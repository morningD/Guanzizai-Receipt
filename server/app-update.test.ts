import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { expect, test, vi } from "vitest";
import schoolFiles from "../scripts/portable/school-runtime.json";
import { appDependencies, applyPreparedUpdate, pendingDirectory } from "../scripts/portable/update-layout.mjs";
import { createAppUpdater } from "./app-update";

const assetName = "Guanzizai-Receipt-v0.2.0-app.zip";
const assetUrl = `https://github.com/morningD/Guanzizai-Receipt/releases/download/v0.2.0/${assetName}`;

function fixtureZip(files: Record<string, string>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [file, text] of Object.entries(files)) {
    const name = Buffer.from(file);
    const body = Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);

    const descriptor = Buffer.alloc(46);
    descriptor.writeUInt32LE(0x02014b50);
    descriptor.writeUInt16LE(20, 4);
    header.copy(descriptor, 6, 4, 30);
    descriptor.writeUInt32LE(offset, 42);
    central.push(descriptor, name);
    offset += header.length + name.length + body.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

const runtimeCompatibility = "f".repeat(64);
const code = {
  ...Object.fromEntries(appDependencies.map((name) => [`node_modules/${name}/package.json`, "{}"])),
  ...Object.fromEntries(schoolFiles.map((file) => [file, "# masked test program file"])),
  "package.json": JSON.stringify({ type: "module", version: "0.2.0", runtimeCompatibility }),
  "licenses/licenses.json": "[]",
  "dist/index.html": "<title>新版</title>",
  "dist/server/standalone.js": "// 新版服务",
};

function fakeRelease(archive = fixtureZip(code), digest?: string) {
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input) === assetUrl) return new Response(new Uint8Array(archive));
    return Response.json({ tag_name: "v0.2.0", assets: [{
      name: assetName, browser_download_url: assetUrl, size: archive.length,
      digest: "sha256:" + (digest ?? createHash("sha256").update(archive).digest("hex")),
    }] });
  });
  return request;
}

async function workspace(check: (install: string, data: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "票据簿 更新测试-"));
  const install = path.join(root, "程序");
  const data = path.join(root, "用户数据");
  await mkdir(path.join(install, "app", "dist"), { recursive: true });
  await mkdir(data);
  await writeFile(path.join(install, "app", "dist", "index.html"), "旧版程序");
  await writeFile(path.join(install, "app", "package.json"), JSON.stringify({ runtimeCompatibility }));
  try {
    await check(install, data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshot(root: string, relative = ""): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      results[file] = "directory";
      Object.assign(results, await snapshot(root, file));
    }
    else {
      const target = path.join(root, file);
      results[file] = { content: (await readFile(target)).toString("base64"), mtime: (await stat(target)).mtimeMs };
    }
  }
  return results;
}

test("开发模式只读取版本信息，不下载更新包", async () => {
  const request = fakeRelease();
  expect(await createAppUpdater({ request, version: "0.1.0" })()).toEqual({ status: "development", version: "0.2.0" });
  expect(request.mock.calls.map(([input]) => String(input))).toEqual([
    "https://api.github.com/repos/morningD/Guanzizai-Receipt/releases/latest",
  ]);
});

test("在原程序目录启用新版，配置和原始票据逐字节保持一致", async () => {
  await workspace(async (install, data) => {
    for (const [name, bytes] of Object.entries({
      ".guanzizai/first-run.json": '{"campus":"闵行校区"}',
      ".guanzizai/user-profiles/profiles.json": '{"synthetic":true}',
      "data/reimbursement-model.json": '{"links":[1,2]}',
      "01_报销材料/已归档/原件.pdf": "虚构原件",
    })) {
      const location = path.join(data, name);
      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, bytes);
    }
    await mkdir(path.join(data, "空的资料目录"));
    await writeFile(path.join(install, "保留我的文件.txt"), "保留");
    await writeFile(path.join(install, "app", "旧程序附带的自定义资料.txt"), "也保留");
    const before = await snapshot(data);

    expect(await createAppUpdater({ installRoot: install, dataRoot: data, request: fakeRelease() })())
      .toEqual({ status: "pending", version: "0.2.0" });
    expect(await readFile(path.join(install, "app", "dist", "index.html"), "utf8")).toBe("旧版程序");
    expect(await applyPreparedUpdate(install, data)).toBe(true);
    expect(await readFile(path.join(install, "app", "dist", "index.html"), "utf8")).toBe(code["dist/index.html"]);
    expect(await applyPreparedUpdate(install, data)).toBe(false);
    expect(await snapshot(data)).toEqual(before);
    expect(await readFile(path.join(install, "保留我的文件.txt"), "utf8")).toBe("保留");
    const [backup] = await readdir(path.join(install, ".receipt-update-backups"));
    expect(await readFile(path.join(install, ".receipt-update-backups", backup, "app", "旧程序附带的自定义资料.txt"), "utf8")).toBe("也保留");
  });
});

test("哈希错误、越界文件或数据目录重叠时不替换现有程序", async () => {
  await workspace(async (install, data) => {
    const snapshotBefore = await snapshot(install);
    const base = { installRoot: install, dataRoot: data };
    const request = fakeRelease(fixtureZip({ ...code, "配置.json": "拒绝" }));
    const newRuntime = fakeRelease(fixtureZip({ ...code, "package.json": JSON.stringify({
      type: "module", version: "0.2.0", runtimeCompatibility: "d".repeat(64),
    }) }));
    await expect(createAppUpdater({ ...base, request: newRuntime })()).rejects.toThrow("完整 ZIP");
    await expect(createAppUpdater({ ...base, request })()).rejects.toThrow("不允许");
    const hiddenData = fakeRelease(fixtureZip({ ...code, "dist/assets/receipt-lines.json": "{}" }));
    await expect(createAppUpdater({ ...base, request: hiddenData })()).rejects.toThrow("不允许");
    await expect(createAppUpdater({ ...base, request: fakeRelease(fixtureZip(code), "0".repeat(64)) })()).rejects.toThrow("SHA-256");
    const overlapRequest = fakeRelease();
    await expect(createAppUpdater({ ...base, dataRoot: path.join(install, "app"), request: overlapRequest })()).rejects.toThrow("重叠");
    expect(overlapRequest).toHaveBeenCalledTimes(1);
    const missingScript = Object.fromEntries(Object.entries(code).filter(([file]) => file !== "tools/fetch_budget.py"));
    await expect(createAppUpdater({ ...base, request: fakeRelease(fixtureZip(missingScript)) })())
      .rejects.toThrow("缺少程序文件");

    expect(await snapshot(install)).toEqual(snapshotBefore);
    expect(await readdir(install)).not.toContain(pendingDirectory);
  });
});

test("暂存程序不完整时保持旧版本和数据", async () => {
  await workspace(async (install, data) => {
    expect(await createAppUpdater({ installRoot: install, dataRoot: data, request: fakeRelease(), version: "0.1.0" })())
      .toEqual({ status: "pending", version: "0.2.0" });
    await rm(path.join(install, pendingDirectory, "dist", "index.html"));
    await expect(applyPreparedUpdate(install, data)).rejects.toThrow("原版本仍保留");
    expect(await readFile(path.join(install, "app", "dist", "index.html"), "utf8")).toBe("旧版程序");
  });
});

test.skipIf(!process.env.RECEIPT_CI_UPDATE_DIR)("候选实际更新附件通过安装与数据隔离验收", async () => {
  const directory = process.env.RECEIPT_CI_UPDATE_DIR!;
  const report = JSON.parse(await readFile(path.join(directory, "update-report.json"), "utf8")) as {
    version: string; runtimeCompatibility: string; update: { file: string; sha256: string; bytes: number };
  };
  const payload = await readFile(path.join(directory, report.update.file));
  const url = `https://github.com/morningD/Guanzizai-Receipt/releases/download/v${report.version}/${report.update.file}`;
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input) === url) return new Response(new Uint8Array(payload));
    expect(String(input)).toBe("https://api.github.com/repos/morningD/Guanzizai-Receipt/releases/latest");
    return Response.json({ tag_name: `v${report.version}`, assets: [{
      name: report.update.file, browser_download_url: url, size: report.update.bytes, digest: `sha256:${report.update.sha256}`,
    }] });
  });
  await workspace(async (install, data) => {
    await writeFile(path.join(install, "app", "package.json"), JSON.stringify({ runtimeCompatibility: report.runtimeCompatibility }));
    await writeFile(path.join(install, "bootstrap.mjs"), "// existing launcher");
    await writeFile(path.join(install, "data-library-settings.json"), JSON.stringify({ directory: data }));
    await mkdir(path.join(install, "runtime"));
    await writeFile(path.join(install, "runtime", "runtime-fixture"), "old runtime");
    await mkdir(path.join(data, "01_报销材料"));
    await writeFile(path.join(data, "01_报销材料", "虚构原件.pdf"), "original fixture");
    await writeFile(path.join(data, "业务设置.json"), '{"fixture":true}');
    const before = await snapshot(data);
    const launcherBefore = await stat(path.join(install, "bootstrap.mjs"));
    const runtimeBefore = await snapshot(path.join(install, "runtime"));

    expect(await createAppUpdater({ installRoot: install, dataRoot: data, request, version: "0.0.0" })())
      .toEqual({ status: "pending", version: report.version });
    expect(await applyPreparedUpdate(install, data)).toBe(true);
    expect(JSON.parse(await readFile(path.join(install, "app", "package.json"), "utf8")).version).toBe(report.version);
    expect(await snapshot(data)).toEqual(before);
    expect((await stat(path.join(install, "bootstrap.mjs"))).mtimeMs).toBe(launcherBefore.mtimeMs);
    expect(await readFile(path.join(install, "data-library-settings.json"), "utf8")).toBe(JSON.stringify({ directory: data }));
    expect(await snapshot(path.join(install, "runtime"))).toEqual(runtimeBefore);
  });
}, 60_000);
