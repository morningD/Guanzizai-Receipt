import { createHash } from "node:crypto";
import { createWriteStream, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import { appDependencies, checkedUpdateRoot, pendingDirectory } from "../scripts/portable/update-layout.mjs";
import schoolFiles from "../scripts/portable/school-runtime.json";
import { version as currentVersion } from "../package.json";

const repository = "morningD/Guanzizai-Receipt";
const latest = `https://api.github.com/repos/${repository}/releases/latest`;
const maxArchive = 200 * 1024 * 1024;
const downloadHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

type Release = {
  version: string;
  asset?: { browser_download_url?: string; digest?: string; size?: number };
};
type Options = {
  installRoot?: string;
  dataRoot?: string;
  request?: typeof fetch;
  version?: string;
};

function versionParts(version: string) {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]+)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1] : null;
}

function newer(version: string, current: string) {
  const next = versionParts(version);
  const previous = versionParts(current);
  if (!next || !previous) return false;
  const index = next.findIndex((value, index) => value !== previous[index]);
  return index >= 0 && next[index] > previous[index];
}

async function findRelease(request: typeof fetch): Promise<Release | null> {
  const response = await request(latest, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("GitHub 暂时无法返回版本信息，请稍后再试。");
  const body = await response.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<Release["asset"] & { name?: string }> };
  const version = body.tag_name?.replace(/^v/, "") ?? "";
  if (body.draft || body.prerelease || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return null;
  const name = `Guanzizai-Receipt-v${version}-app.zip`;
  const asset = body.assets?.find((item) => item?.name === name);
  return { version, asset };
}

async function download(request: typeof fetch, url: string, target: string, size: number, hash: string) {
  const signal = AbortSignal.timeout(120_000);
  let next = new URL(url);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (next.protocol !== "https:" || next.username || next.password || next.port || !downloadHosts.has(next.hostname)) {
      throw new Error("更新下载地址不符合要求。");
    }
    const response = await request(next, { redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      next = new URL(location, next);
      continue;
    }
    if (!response.ok || !response.body) throw new Error("下载更新失败。");
    const digest = createHash("sha256");
    let bytes = 0;
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > size) return callback(new Error("更新包大小不符。"));
        digest.update(chunk);
        callback(null, chunk);
      } }),
      createWriteStream(target, { flags: "wx" }),
      { signal },
    );
    if (bytes !== size || digest.digest("hex") !== hash) throw new Error("更新包未通过 SHA-256 校验。");
    return;
  }
  throw new Error("更新下载重定向过多。");
}

function allowedProgramPath(name: string, parts: string[], directory: boolean) {
  if (parts[0] === "node_modules") {
    return directory && parts.length === 1 || appDependencies.includes(parts[1]);
  }
  if (directory) {
    return ["dist", "dist/assets", "dist/server", "dist/server/assets", "tools", "treasury_research", "licenses"].includes(name);
  }
  if (schoolFiles.includes(name) || name === "licenses/licenses.json" || /^licenses\/[A-Za-z0-9@_.-]+\.txt$/.test(name)) return true;
  return ["package.json", "dist/index.html", "dist/server/standalone.js"].includes(name)
    || /^dist\/assets\/[^/]+\.(?:js|css|svg|png|woff2)$/.test(name)
    || /^dist\/server\/assets\/[^/]+\.js$/.test(name);
}

async function extract(archive: string, destination: string, version: string, runtimeCompatibility: string) {
  const zip = await openPromise(archive, { strictFileNames: true });
  const names = new Set<string>();
  let uncompressed = 0;
  await mkdir(destination);
  try {
    if (zip.entryCount > 30_000) throw new Error("更新包文件数量超出限制。");
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith("/");
      const name = entry.fileName.replace(/\/$/, "");
      const parts = name.split("/");
      const category = entry.externalFileAttributes >>> 16 & 0o170000;
      if (!parts.every((part) => /^[^.:\\/\x00-\x1f][^:\\/\x00-\x1f]*$/.test(part)
        && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        || (category !== 0 && category !== 0o100000 && category !== 0o040000)
        || !allowedProgramPath(name, parts, directory)
        || names.has(name.toLowerCase())) {
        throw new Error("更新包包含不允许的路径或文件。");
      }
      names.add(name.toLowerCase());
      uncompressed += entry.uncompressedSize;
      if (uncompressed > 750 * 1024 * 1024) throw new Error("更新包解压大小超出限制。");
      const output = path.join(destination, ...parts);
      if (directory) {
        await mkdir(output, { recursive: true });
      } else {
        await mkdir(path.dirname(output), { recursive: true });
        await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(output, { flags: "wx" }));
        if ((entry.externalFileAttributes >>> 16) & 0o111) await chmod(output, 0o755);
      }
    }
  } finally {
    zip.close();
  }
  const descriptor = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8")) as { version?: string; type?: string; runtimeCompatibility?: string };
  if (descriptor.runtimeCompatibility !== runtimeCompatibility) throw new Error("该版本需要新版启动器或运行环境，请使用完整 ZIP。");
  if (descriptor.version !== version || descriptor.type !== "module"
    || schoolFiles.some((file) => !names.has(file.toLowerCase()))
    || !names.has("licenses/licenses.json")
    || !lstatSync(path.join(destination, "dist", "index.html"), { throwIfNoEntry: false })?.isFile()
    || !lstatSync(path.join(destination, "dist", "server", "standalone.js"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("更新包与发布版本不一致或缺少程序文件。");
  }
}

export function createAppUpdater(options: Options = {}) {
  let busy = false;
  return async function run() {
    if (busy) throw new Error("已有更新检查在运行。");
    busy = true;
    try {
      const request = options.request ?? fetch;
      const release = await findRelease(request);
      const version = options.version ?? currentVersion;
      if (!options.installRoot || !options.dataRoot) {
        return { status: "development", version: release?.version ?? version };
      }
      if (!release) return { status: "unavailable", version };
      if (!newer(release.version, version)) return { status: "current", version };
      const root = checkedUpdateRoot(options.installRoot, options.dataRoot);
      const pending = path.join(root, pendingDirectory);
      if (lstatSync(pending, { throwIfNoEntry: false })) {
        const prepared = JSON.parse(await readFile(path.join(pending, "package.json"), "utf8").catch(() => "{}")) as { version?: string };
        if (!prepared.version || !versionParts(prepared.version)) throw new Error("暂存的更新包不完整，请查看启动窗口。");
        return { status: "pending", version: prepared.version };
      }

      const { browser_download_url: url, digest, size } = release.asset ?? {};
      const expectedHash = /^sha256:([a-f0-9]{64})$/i.exec(digest ?? "")?.[1].toLowerCase();
      const assetName = `Guanzizai-Receipt-v${release.version}-app.zip`;
      if (url !== `https://github.com/${repository}/releases/download/v${release.version}/${assetName}`
        || !expectedHash || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > maxArchive) {
        throw new Error("该公开版本尚未提供可验证的更新包。");
      }

      const installed = JSON.parse(await readFile(path.join(root, "app", "package.json"), "utf8").catch(() => "{}")) as { runtimeCompatibility?: string };
      if (!installed.runtimeCompatibility || !/^[a-f0-9]{64}$/.test(installed.runtimeCompatibility)) {
        throw new Error("此安装需要先换用完整 ZIP，才能使用应用内更新。");
      }

      const temporary = await mkdtemp(path.join(root, ".receipt-update-"));
      try {
        const archive = path.join(temporary, "download.zip");
        const extracted = path.join(temporary, "app");
        await download(request, url, archive, size, expectedHash);
        await extract(archive, extracted, release.version, installed.runtimeCompatibility);
        await rename(extracted, pending);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return { status: "pending", version: release.version };
    } finally {
      busy = false;
    }
  };
}

export function createAppUpdateHandler(options: Options = {}) {
  const run = createAppUpdater(options);
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(data));
    };
    if (request.method !== "POST") {
      send(405, { error: "请使用更新按钮检查版本。" });
      return;
    }
    try {
      send(200, await run());
    } catch (error) {
      send(502, { error: error instanceof Error ? error.message : "检查更新失败。" });
    }
  };
}
