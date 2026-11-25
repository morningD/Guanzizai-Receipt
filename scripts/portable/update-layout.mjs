import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const appDirectory = "app";
export const appDependencies = ["playwright", "playwright-core", "yauzl", "pend"];
export const pendingDirectory = ".receipt-update-pending";

export function receiptDataRoot() {
  const dataHome = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
    : path.join(homedir(), "Library", "Application Support");
  return path.resolve(process.env.RECEIPT_DATA_ROOT || path.join(dataHome, "GuanzizaiReceipt"));
}

/** @param {string} file */
function canonicalPath(file) {
  if (lstatSync(file, { throwIfNoEntry: false })) return realpathSync.native(file);
  return path.join(canonicalPath(path.dirname(file)), path.basename(file));
}

/** @param {string} directory @param {string} file */
function contains(directory, file) {
  const relative = path.relative(directory, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** @param {string} installRoot @param {string} dataRoot */
export function checkedUpdateRoot(installRoot, dataRoot) {
  const root = realpathSync.native(installRoot);
  const data = canonicalPath(path.resolve(dataRoot));
  if (contains(root, data) || contains(data, root)) {
    throw new Error("程序目录与数据目录重叠，已停止更新。");
  }
  return root;
}

/** @param {string} root @param {string} name */
function codeFolder(root, name) {
  const folder = path.join(root, name);
  const entry = lstatSync(folder, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || realpathSync.native(folder) !== folder)) throw new Error("更新目录不是普通目录。");
  return entry ? folder : null;
}

/** @param {string} installRoot @param {string} dataRoot */
export async function applyPreparedUpdate(installRoot, dataRoot) {
  const canonicalRoot = realpathSync.native(installRoot);
  const pending = codeFolder(canonicalRoot, pendingDirectory);
  if (!pending) return false;
  const root = checkedUpdateRoot(canonicalRoot, dataRoot);
  const active = path.join(root, appDirectory);
  const dist = codeFolder(pending, "dist");
  const server = dist && codeFolder(dist, "server");
  const required = ["package.json", "licenses/licenses.json", "dist/index.html", "dist/server/standalone.js",
    ...appDependencies.map((name) => `node_modules/${name}/package.json`)];
  if (!server || required.some((name) => !lstatSync(path.join(pending, name), { throwIfNoEntry: false })?.isFile())) {
    throw new Error("新版程序不完整，原版本仍保留。");
  }
  const installed = JSON.parse(readFileSync(path.join(active, "package.json"), "utf8"));
  const replacement = JSON.parse(readFileSync(path.join(pending, "package.json"), "utf8"));
  if (replacement.type !== "module" || !replacement.runtimeCompatibility
    || replacement.runtimeCompatibility !== installed.runtimeCompatibility) {
    throw new Error("新版程序需要兼容的启动器和运行环境，原版本仍保留。");
  }
  let backup;
  if (codeFolder(root, appDirectory)) {
    const backupRoot = path.join(root, ".receipt-update-backups");
    await mkdir(backupRoot, { recursive: true });
    codeFolder(root, ".receipt-update-backups");
    backup = path.join(await mkdtemp(path.join(backupRoot, "app-")), appDirectory);
    await rename(active, backup);
  }
  try {
    await rename(pending, active);
  } catch (error) {
    if (backup) await rename(backup, active);
    throw error;
  }
  return true;
}
