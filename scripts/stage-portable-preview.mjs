import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import schoolFiles from "./portable/school-runtime.json" with { type: "json" };
import { appDependencies } from "./portable/update-layout.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [argument] = process.argv.slice(2);
if (!argument || process.argv.length !== 3) throw new Error("用法：node scripts/stage-portable-preview.mjs <新目录>");
if (!["darwin", "win32"].includes(process.platform)) throw new Error("请在对应的 Windows 或 macOS 主机上制包");

const output = path.resolve(argument);
const windows = process.platform === "win32";
const executable = windows ? "node.exe" : "node";
const launcher = windows ? "Start-Receipt-Desk.cmd" : "Start-Receipt-Desk.command";

const runtimeDirectory = path.dirname(process.execPath);
const license = [runtimeDirectory, path.dirname(runtimeDirectory)]
  .map((directory) => path.join(directory, "LICENSE")).find(existsSync);
if (!license || process.config.variables.node_shared) {
  throw new Error("请用官方 Node.js 二进制发行版制包，以提供独立运行时及许可证。");
}

mkdirSync(output);
mkdirSync(path.join(output, "runtime"));
execFileSync(windows ? "python" : "python3", [
  path.join(root, "scripts", "bundle-school-python.py"), path.join(output, "runtime", "python"),
], { stdio: "inherit" });
const app = path.join(output, "app");
mkdirSync(app);
for (const script of ["bootstrap.mjs", "update-layout.mjs", "data-library.mjs"]) {
  copyFileSync(path.join(root, "scripts", "portable", script), path.join(output, script));
}
copyFileSync(process.execPath, path.join(output, "runtime", executable));
copyFileSync(license, path.join(output, "runtime", "LICENSE"));
copyFileSync(path.join(root, "scripts", "portable", launcher), path.join(output, launcher));
if (!windows) {
  chmodSync(path.join(output, "runtime", executable), 0o755);
  chmodSync(path.join(output, launcher), 0o755);
}
cpSync(path.join(root, "dist"), path.join(app, "dist"), { recursive: true });
mkdirSync(path.join(app, "node_modules"));
for (const name of appDependencies) {
  const source = path.join(root, "node_modules", name);
  const optionalWatcher = path.join(source, "node_modules", "fsevents");
  cpSync(source, path.join(app, "node_modules", name), {
    recursive: true,
    filter: (entry) => name !== "playwright" || entry !== optionalWatcher,
  });
}
for (const file of schoolFiles) {
  const target = path.join(app, file);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, file), target);
}
// Vite embeds these browser dependencies into dist; keep their license texts explicitly.
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;
const frontendDependencies = new Set(["react", "react-dom", "@xyflow/react", "lucide-react"]);
const licenseHome = path.join(app, "licenses");
mkdirSync(licenseHome);
copyFileSync(path.join(root, "LICENSE"), path.join(licenseHome, "Guanzizai-Receipt-LICENSE.txt"));
const licenseIndex = [{ name: "Guanzizai-Receipt", version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, license: "MulanPSL-2.0", files: ["Guanzizai-Receipt-LICENSE.txt"] }];
for (const name of frontendDependencies) {
  const relative = `node_modules/${name}`;
  const descriptor = lock[relative];
  if (!descriptor) throw new Error(`缺少前端依赖锁定信息：${name}`);
  for (const dependency of Object.keys(descriptor.dependencies ?? {})) {
    if (!dependency.startsWith("@types/")) frontendDependencies.add(dependency);
  }
  const source = path.join(root, relative);
  const notices = readdirSync(source).filter((file) => /^(?:licen[cs]e|copying|notice|authors)(?:[._-]|$)/i.test(file));
  if (!notices.length) throw new Error(`未找到前端依赖许可证：${name}`);
  const files = notices.sort().map((file) => {
    const target = `${name.replaceAll("/", "-")}-${descriptor.version}-${file}.txt`;
    copyFileSync(path.join(source, file), path.join(licenseHome, target));
    return target;
  });
  licenseIndex.push({ name, version: descriptor.version, license: descriptor.license, files });
}
writeFileSync(path.join(licenseHome, "licenses.json"), JSON.stringify(licenseIndex, null, 2) + "\n");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const contractFiles = [
  "scripts/portable/bootstrap.mjs", "scripts/portable/update-layout.mjs", "scripts/portable/data-library.mjs",
  "scripts/portable/Start-Receipt-Desk.command", "scripts/portable/Start-Receipt-Desk.cmd",
  "scripts/bundle-school-python.py", "scripts/portable/school-wheels.txt",
];
const runtime = createHash("sha256").update(process.version);
for (const file of contractFiles) {
  runtime.update(file).update("\0").update(readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n")).update("\0");
}
const runtimeCompatibility = runtime.digest("hex");
writeFileSync(path.join(app, "package.json"), JSON.stringify({ type: "module", private: true, version, runtimeCompatibility }) + "\n");
const release = process.env.RECEIPT_PACKAGE_CHANNEL === "release";
writeFileSync(path.join(output, "README.txt"), `观自在 · 票据簿${release ? ` v${version}` : "内部启动原型"}
双击 ${launcher} 启动，按 Ctrl+C 停止。启动窗口会显示浏览器地址与数据目录。
校内脚本使用随包 Python。校内登录需安装 Chrome 或 Edge。
${release ? "使用指南：https://github.com/morningD/Guanzizai-Receipt" : "本原型用于内部验证。"}
`);
console.log(`已准备启动包：${output}`);
