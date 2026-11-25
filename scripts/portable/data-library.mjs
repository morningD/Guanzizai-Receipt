import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { checkedUpdateRoot } from "./update-layout.mjs";

const settingsFile = "data-library-settings.json";
const snapshotFile = ".receipt-snapshot.json";
const incompleteFile = ".receipt-copying";
const materials = "01_报销材料";
const dataFiles = new Set([
  "receipt-lines.json", "receipt-meta.json", "reimbursement-model.json", "receipt-removed-ids.json",
  "expense-set-remaps.json", "elab-bill-registry.json",
  "receipt-lines.backup.json", "receipt-meta.backup.json",
]);
const workspaceSettings = new Set([
  ".guanzizai/first-run.json", ".guanzizai/print-settings.json", ".guanzizai/print-log.json",
  ".guanzizai/user-profiles/profiles.json",
]);

/** @typedef {{ action: "use"|"migrate"|"backup"|"restore", source: string, destination: string, id: string }} DataOperation */
/** @typedef {{ id: string, status: "completed"|"failed", action: DataOperation["action"], destination: string, error?: string }} DataResult */
/** @typedef {{ directory?: string, pending?: DataOperation, last?: DataResult }} DataSettings */
/** @typedef {{ path: string, bytes: number, sha256: string }} FileStamp */

/** @param {string} file */
async function statIfPresent(file) {
  try { return await lstat(file); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null; throw error; }
}

/** @param {string} install @returns {Promise<DataSettings>} */
export async function readDataSettings(install) {
  const file = path.join(install, settingsFile);
  const info = await statIfPresent(file);
  if (!info) return {};
  if (!info.isFile()) throw new Error("数据目录配置不是普通文件");
  return JSON.parse(await readFile(file, "utf8"));
}

/** @param {string} file @param {unknown} value */
async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** @param {string} install @param {DataSettings} settings */
export function saveDataSettings(install, settings) {
  return writeJson(path.join(install, settingsFile), settings);
}

/** @param {string} candidate */
async function absoluteDirectory(candidate) {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error("请输入本机目录的绝对路径");
  if (process.platform === "win32" && !/^[a-z]:[/\\]/i.test(candidate)) throw new Error("请选择本机磁盘上的目录");
  const resolved = path.resolve(candidate);
  const entry = await statIfPresent(resolved);
  if (entry) {
    if (!entry.isDirectory()) throw new Error("路径须为普通目录");
    return realpath(resolved);
  }
  return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
}

/** @param {string} parent @param {string} child */
function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** @param {string} root */
async function isLibrary(root) {
  return Boolean((await statIfPresent(path.join(root, materials)))?.isDirectory()
    || [...await readdir(path.join(root, "data")).catch(() => [])].some((name) => dataFiles.has(name)));
}

/** @param {unknown} input @param {string} active @param {string} install @returns {Promise<DataOperation>} */
export async function prepareDataOperation(input, active, install) {
  const body = /** @type {Record<string, unknown>} */ (input && typeof input === "object" ? input : {});
  const { action } = body;
  if (action !== "use" && action !== "migrate" && action !== "backup" && action !== "restore") throw new Error("请选择有效的数据操作");
  const destination = await absoluteDirectory(typeof body.destination === "string" ? body.destination.trim() : "");
  const source = await absoluteDirectory(action === "backup" || action === "use" ? active : typeof body.source === "string" ? body.source.trim() : "");
  checkedUpdateRoot(install, destination);
  checkedUpdateRoot(install, source);
  const canonicalActive = await absoluteDirectory(active);
  const sameActive = path.relative(canonicalActive, destination) === "";
  if ((action !== "use" || !sameActive)
    && (contains(source, destination) || contains(destination, source)
      || contains(canonicalActive, destination) || contains(destination, canonicalActive))) {
    throw new Error("源库、当前库和目标目录须分开");
  }
  if (await statIfPresent(path.join(source, incompleteFile)) || await statIfPresent(path.join(destination, incompleteFile))) {
    throw new Error("选择的目录包含尚未完成的数据副本");
  }
  if (action !== "use") {
    if (!await isLibrary(source)) throw new Error("源目录没有找到票据簿数据");
    if (await statIfPresent(destination)) throw new Error("目标目录须为尚未创建的新目录");
    if (action === "restore" && (await readManifest(source)).action !== "backup") throw new Error("请选择由票据簿生成的备份");
    if (action === "migrate" && await statIfPresent(path.join(source, snapshotFile)) && (await readManifest(source)).action === "backup") {
      throw new Error("请通过「从备份恢复」校验备份");
    }
  } else if (await statIfPresent(destination)) {
    if (await statIfPresent(path.join(destination, snapshotFile)) && (await readManifest(destination)).action === "backup") {
      throw new Error("请通过「从备份恢复」打开备份");
    }
    if ((await readdir(destination)).length && !await isLibrary(destination)) throw new Error("请选择空目录或已有票据簿的数据目录");
    await access(destination, constants.W_OK);
  }
  return { action, source, destination, id: randomUUID() };
}

/** @param {string} rel @param {boolean} directory */
function allowedLibraryEntry(rel, directory) {
  if (rel === materials || rel.startsWith(materials + "/")) {
    return !rel.split("/").some((part) => part.startsWith(".") || part === "Thumbs.db");
  }
  const parts = rel.split("/");
  if (parts.some((part, index) => part.startsWith(".") && !(index === 0 && part === ".guanzizai"))) return false;
  if (directory && ["data", "data/budgets", "data/df", "data/labor", ".guanzizai", ".guanzizai/user-profiles"].includes(rel)) return true;
  if (parts[0] === "data" && parts.length === 2) return !directory && dataFiles.has(parts[1]);
  if (parts[0] === "data" && parts.length === 3 && !directory) {
    if (parts[1] === "df") return /^(settings|salary-\d{4})\.json$/.test(parts[2]);
    if (parts[1] === "labor") return /^(settings|roster|months)\.json$|^template\.xlsx$/.test(parts[2]);
    if (parts[1] === "budgets") return /^[0-9][a-z0-9-]*\.json$/i.test(parts[2]);
  }
  const profileFolder = /^\.guanzizai\/user-profiles\/(?:profile-default|user-[a-z0-9-]+)/;
  if (profileFolder.test(rel)) {
    const remainder = rel.replace(profileFolder, "");
    if (remainder === "" || remainder === "/memberships") return directory;
    return !directory && (remainder === "/signature.png" || /^\/memberships\/[^/]+\.pdf$/i.test(remainder));
  }
  return !directory && workspaceSettings.has(rel);
}

/** @param {string} file */
async function fileDigest(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}

/** @param {string} root @param {string} directory @param {string|null} output @param {FileStamp[]} result */
async function copyEntries(root, directory, output, result) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (entry.isSymbolicLink() && !rel.startsWith(materials + "/") && allowedLibraryEntry(rel, true)) {
      throw new Error("数据子目录是链接，请先恢复为普通目录");
    }
    if (!allowedLibraryEntry(rel, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      if (output) await mkdir(path.join(output, rel), { recursive: true });
      await copyEntries(root, file, output, result);
      continue;
    }
    let source = file;
    if (entry.isSymbolicLink() && rel.startsWith(materials + "/")) {
      source = await realpath(file);
      const sourceRel = path.relative(root, source).split(path.sep).join("/");
      if (!contains(path.join(root, materials), source) || !allowedLibraryEntry(sourceRel, false) || !(await lstat(source)).isFile()) {
        throw new Error("材料引用指向库外、隐藏文件或不是普通文件");
      }
    } else if (!entry.isFile()) throw new Error("数据目录包含无法安全复制的文件");
    const target = output ? path.join(output, rel) : source;
    const before = await lstat(source);
    if (output) await copyFile(source, target, constants.COPYFILE_EXCL);
    const stamped = await fileDigest(target);
    const after = await lstat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      throw new Error("源库有文件在复制时发生变化，请关闭使用源库的程序后重试");
    }
    result.push({ path: rel, ...stamped });
  }
}

/** @param {string} directory */
async function readManifest(directory) {
  const file = path.join(directory, snapshotFile);
  if (!(await statIfPresent(file))?.isFile()) throw new Error("缺少有效的备份清单");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.schema !== 1 || !Array.isArray(value.files)) throw new Error("备份清单格式不受支持");
  return /** @type {{schema: 1, id: string, action: DataOperation["action"], files: FileStamp[]}} */ (value);
}

/** @param {FileStamp[]} actual @param {FileStamp[]} expected */
function verifyFiles(actual, expected) {
  const index = new Map(expected.map((file) => [file.path, file]));
  if (actual.length !== expected.length || index.size !== expected.length || actual.some((file) => {
    const match = index.get(file.path);
    return match?.sha256 !== file.sha256 || match.bytes !== file.bytes;
  })) throw new Error("备份校验失败，文件缺失、增添或已修改");
}

/** @param {string} source @param {string} staging @param {FileStamp[]} files */
async function normalizeLibraryPaths(source, staging, files) {
  /** @param {unknown} value */
  const relativeMaterial = (value) => {
    if (typeof value !== "string") return value;
    const portable = value.replaceAll("\\", "/");
    const relative = portable.replace(/^\.\//, "");
    if (relative.startsWith(materials + "/") && !relative.split("/").includes("..")) return relative;
    if (path.isAbsolute(value)) {
      let resolved = value;
      if (!contains(source, resolved)) {
        try { resolved = realpathSync.native(value); } catch { /* Check portable form below. */ }
      }
      if (contains(source, resolved)) {
        const rel = path.relative(source, resolved).split(path.sep).join("/");
        if (rel.startsWith(materials + "/")) return rel;
      }
    }
    // Match an absolute path written on another system only if the same library-relative file was copied.
    if (!/^(?:[a-z]:)?\//i.test(portable)) return value;
    const parts = portable.split("/");
    const anchor = parts.indexOf(materials);
    if (anchor < 1 || parts.lastIndexOf(materials) !== anchor) return value;
    const tail = parts.slice(anchor + 1);
    if (!tail.length || tail.some((part) => !part || part === "." || part === "..")) return value;
    const candidate = [materials, ...tail].join("/");
    return existsSync(path.join(staging, candidate)) ? candidate : value;
  };
  for (const record of files) {
    if (!/^data\/(reimbursement-model|receipt-lines(?:\.backup)?|receipt-meta(?:\.backup)?|expense-set-remaps)\.json$/.test(record.path)) continue;
    const target = path.join(staging, record.path);
    const data = JSON.parse(await readFile(target, "utf8"));
    const original = JSON.stringify(data);
    for (const line of Array.isArray(data.sets) ? data.sets : Array.isArray(data.lines) ? data.lines : []) {
      if (line && typeof line === "object") line.folder = relativeMaterial(line.folder);
    }
    for (const evidence of Array.isArray(data.evidence) ? data.evidence : []) {
      if (evidence && typeof evidence === "object") evidence.path = relativeMaterial(evidence.path);
    }
    if (data.metadata && typeof data.metadata === "object") {
      const entries = Object.entries(data.metadata);
      const normalized = Object.fromEntries(entries.map(([key, value]) => [relativeMaterial(key), value]));
      if (Object.keys(normalized).length !== entries.length) throw new Error("旧库包含重复的材料记录路径，未覆盖原记录");
      data.metadata = normalized;
    }
    if (data.evidencePaths && typeof data.evidencePaths === "object") {
      data.evidencePaths = Object.fromEntries(Object.entries(data.evidencePaths).map(([key, value]) => [key, relativeMaterial(value)]));
    }
    if (JSON.stringify(data) !== original) {
      await writeJson(target, data);
      Object.assign(record, await fileDigest(target));
    }
  }
}

/** @param {DataOperation} operation */
async function copyLibrary(operation) {
  const { source, destination, id, action } = operation;
  const existing = await statIfPresent(destination);
  if (existing) {
    if (existing.isDirectory()) {
      const manifest = await readManifest(destination);
      if (manifest.id === id && manifest.action === action) {
        const actual = /** @type {FileStamp[]} */ ([]);
        await copyEntries(destination, destination, null, actual);
        verifyFiles(actual, manifest.files);
        await rm(path.join(destination, incompleteFile), { force: true });
        return;
      }
    }
    throw new Error("目标目录已存在，请改用新目录");
  }
  const staging = await mkdtemp(path.join(path.dirname(destination), ".receipt-copy-"));
  try {
    const files = /** @type {FileStamp[]} */ ([]);
    await copyEntries(source, source, staging, files);
    if (action === "restore") {
      const manifest = await readManifest(source);
      if (manifest.action !== "backup") throw new Error("请选择由票据簿生成的备份");
      verifyFiles(files, manifest.files);
    } else await normalizeLibraryPaths(source, staging, files);
    await writeJson(path.join(staging, snapshotFile), { schema: 1, id, action, files });
    // Claim a new directory exclusively. Commit the manifest last, after all data is in place.
    await mkdir(destination, { mode: 0o700 });
    await writeFile(path.join(destination, incompleteFile), id + "\n", { mode: 0o600, flag: "wx" });
    for (const name of await readdir(staging)) {
      if (name !== snapshotFile) await rename(path.join(staging, name), path.join(destination, name));
    }
    await rename(path.join(staging, snapshotFile), path.join(destination, snapshotFile));
    await rm(path.join(destination, incompleteFile));
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** @param {string} directory */
export async function lockDataDirectory(directory) {
  const resolved = await absoluteDirectory(directory);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const port = 20_000 + createHash("sha256").update(key).digest().readUInt16BE() % 20_000;
  const lock = createServer((socket) => socket.destroy());
  lock.listen({ host: "127.0.0.1", port, exclusive: true });
  try { await once(lock, "listening"); }
  catch { throw new Error("数据目录正在使用，或数据锁端口被占用。请关闭其它票据簿后重试。"); }
  return () => lock.close();
}

/** @param {string} install @param {DataSettings} settings @param {string} active
 * @param {(unlock: () => void) => void} [keepDestinationLock]
 */
export async function applyPendingDataOperation(install, settings, active, keepDestinationLock) {
  const operation = settings.pending;
  if (!operation) return active;
  const release = /** @type {Map<string, () => void>} */ (new Map());
  let next = active;
  /** @type {DataResult} */
  const result = { id: operation.id, action: operation.action, destination: operation.destination, status: "completed" };
  try {
    try {
      const canonicalActive = await absoluteDirectory(active);
      const source = await absoluteDirectory(operation.source);
      const destination = await absoluteDirectory(operation.destination);
      checkedUpdateRoot(install, source);
      checkedUpdateRoot(install, destination);
      if (operation.action !== "use" && (contains(source, destination) || contains(destination, source)
        || contains(canonicalActive, destination) || contains(destination, canonicalActive))) {
        throw new Error("源库、当前库和目标目录须分开");
      }
      if (await statIfPresent(path.join(source, incompleteFile))) throw new Error("源库包含尚未完成的数据副本");
      for (const directory of new Set([source, destination])) {
        if (path.relative(canonicalActive, directory) !== "") release.set(directory, await lockDataDirectory(directory));
      }
      if (operation.action === "use") {
        await prepareDataOperation(operation, active, install);
        await mkdir(destination, { recursive: true });
        await access(destination, constants.W_OK);
      } else await copyLibrary({ ...operation, source, destination });
      if (operation.action !== "backup" && path.relative(canonicalActive, destination) !== "") next = destination;
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? error.message : "数据操作失败";
    }
    await saveDataSettings(install, { directory: next, last: result });
    const unlock = release.get(next);
    if (keepDestinationLock && unlock && next !== active) {
      keepDestinationLock(unlock);
      release.delete(next);
    }
    return next;
  } finally { for (const unlock of release.values()) unlock(); }
}
