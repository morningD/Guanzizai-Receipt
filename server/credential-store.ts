import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const maxSecretBytes = 16 * 1024;

function protectedPath(root: string, service: string) {
  const id = createHash("sha256").update(service).digest("hex");
  return path.join(root, ".guanzizai", "credentials", `${id}.dpapi`);
}

async function windowsCredential(codeRoot: string, action: "protect" | "unprotect", service: string, value: Buffer) {
  if (value.length > maxSecretBytes + 512) throw new Error("系统凭据超出长度限制。");
  const script = await readFile(path.join(codeRoot, "tools", "credential-dpapi.ps1"), "utf8");
  const command = Buffer.from(script, "utf16le").toString("base64");
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 8_000,
    });
    let output = "";
    child.stdout.setEncoding("ascii").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 32 * 1024) child.kill();
    });
    const failure = () => reject(new Error("Windows 无法加密或读取该凭据。"));
    child.once("error", failure);
    child.stdin.once("error", failure);
    child.once("close", (code) => {
      const response = output.trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(response)) {
        failure();
        return;
      }
      resolve(Buffer.from(response, "base64"));
    });
    child.stdin.end(`${action}\n${Buffer.from(service, "utf8").toString("base64")}\n${value.toString("base64")}\n`);
  });
}

export function createCredentialStore(root: string, codeRoot: () => string) {
  async function read(service: string) {
    if (process.platform === "win32") {
      const ciphertext = await readFile(protectedPath(root, service));
      return (await windowsCredential(codeRoot(), "unprotect", service, ciphertext)).toString("utf8");
    }
    const { stdout } = await execute("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { timeout: 1_500 });
    return stdout.trim();
  }

  async function save(service: string, password: string) {
    const bytes = Buffer.from(password, "utf8");
    if (!bytes.length || bytes.length > maxSecretBytes) throw new Error("凭据内容为空或超出长度限制。");
    if (process.platform !== "win32") {
      await execute("/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", "观自在票据簿", "-w", password], { timeout: 4_000 });
      return;
    }
    const target = protectedPath(root, service);
    const ciphertext = await windowsCredential(codeRoot(), "protect", service, bytes);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(temporary, ciphertext, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function has(service: string) {
    try {
      if (process.platform === "win32") return Boolean(await read(service));
      await execute("/usr/bin/security", ["find-generic-password", "-s", service], { timeout: 1_500 });
      return true;
    } catch {
      return false;
    }
  }

  return { read, save, has };
}
