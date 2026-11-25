import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import schoolFiles from "../scripts/portable/school-runtime.json";

const execute = promisify(execFile);

export function schoolCodeRoot() {
  return process.env.RECEIPT_RUNTIME === "portable" && process.env.RECEIPT_INSTALL_ROOT
    ? path.join(process.env.RECEIPT_INSTALL_ROOT, "app")
    : process.cwd();
}

function bundledSchoolPython() {
  const install = process.env.RECEIPT_INSTALL_ROOT;
  if (process.env.RECEIPT_RUNTIME !== "portable" || !install || process.env.RECEIPT_PYTHON_BIN) return null;
  const root = path.join(install, "runtime", "python");
  const executable = path.join(root, process.platform === "win32" ? "python.exe" : "bin/python3.12");
  return existsSync(executable) ? { executable, modules: path.join(root, "site-packages") } : null;
}

export function schoolPython() {
  if (process.env.RECEIPT_PYTHON_BIN) return process.env.RECEIPT_PYTHON_BIN;
  const bundled = bundledSchoolPython();
  if (bundled) return bundled.executable;
  if (process.platform === "win32") return "python";
  if (process.env.RECEIPT_RUNTIME !== "portable" && existsSync("/opt/miniconda3/bin/python3")) return "/opt/miniconda3/bin/python3";
  return "python3";
}

export function schoolScript(script: string) {
  if (!schoolFiles.includes(script) || !script.endsWith(".py")) throw new Error("学校运行脚本未登记。");
  return path.join(schoolCodeRoot(), script);
}

function runtimeEnvironment(root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, RECEIPT_DATA_ROOT: root, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
  const bundled = bundledSchoolPython();
  if (bundled) {
    for (const key of Object.keys(env)) {
      if (/^(PYTHONHOME|PYTHONPATH|PYTHONUSERBASE)$/i.test(key)) delete env[key];
    }
    env.PYTHONPATH = bundled.modules;
    env.PYTHONNOUSERSITE = "1";
  }
  return env;
}

export function startSchoolScript(root: string, script: string, args: string[], quiet = false) {
  const child = spawn(schoolPython(), ["-u", schoolScript(script), ...args], {
    cwd: root, env: runtimeEnvironment(root),
  });
  // Missing Python is reported through the normal process completion path.
  child.on("error", () => undefined);
  if (quiet) {
    child.stdout.resume();
    child.stderr.resume();
  }
  return child;
}

export function runSchoolPython(root: string, args: string[], timeout: number) {
  return execute(schoolPython(), args, {
    cwd: root, env: runtimeEnvironment(root), timeout, maxBuffer: 4 * 1024 * 1024,
  });
}

export function runSchoolScript(root: string, script: string, args: string[], timeout: number) {
  return runSchoolPython(root, [schoolScript(script), ...args], timeout);
}

export async function schoolRuntimeStatus(root: string) {
  const missingFiles = schoolFiles.filter((file) => !existsSync(path.join(schoolCodeRoot(), file)));
  const modules = ["playwright", "openpyxl", "pypdf"];
  let python: string | null = null;
  let missingModules = modules;
  try {
    const { stdout } = await execute(schoolPython(), [
      "-c",
      "import importlib.util, json, platform, sys; print(json.dumps({'version': platform.python_version(), 'missing': [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]}))",
      ...modules,
    ], { cwd: root, env: runtimeEnvironment(root), timeout: 8_000 });
    const result = JSON.parse(stdout) as { version: string; missing: string[] };
    python = result.version;
    missingModules = result.missing;
  } catch { /* reported as unavailable */ }
  return { python, source: bundledSchoolPython() ? "bundled" : "system", missingFiles, missingModules, ready: Boolean(python && !missingFiles.length && !missingModules.length) };
}
