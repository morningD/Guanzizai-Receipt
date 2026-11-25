import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingDataOperation, lockDataDirectory, readDataSettings } from "./data-library.mjs";
import { appDirectory, applyPreparedUpdate, checkedUpdateRoot, receiptDataRoot } from "./update-layout.mjs";

const root = realpathSync.native(fileURLToPath(new URL(".", import.meta.url)));
const lock = createServer((socket) => socket.destroy());
const lockPort = 49152 + createHash("sha256").update(root).digest().readUInt16BE(0) % 16384;
try {
  lock.listen({ host: "127.0.0.1", port: lockPort, exclusive: true });
  await once(lock, "listening");
} catch {
  console.error("这个目录的票据簿正在运行，或启动端口被占用。请关闭旧窗口后重试。");
  process.exit(1);
}

let unlockData;
try {
  const settings = await readDataSettings(root);
  const initial = settings.directory ?? receiptDataRoot();
  checkedUpdateRoot(root, initial);
  unlockData = await lockDataDirectory(initial);
  const active = await applyPendingDataOperation(root, settings, initial, (unlockNext) => {
    unlockData();
    unlockData = unlockNext;
  });
  try {
    if (await applyPreparedUpdate(root, active)) console.log("已启用新版程序。");
  } catch (error) {
    console.error("更新未完成：", error.message);
  }
  const app = path.join(root, appDirectory, "dist", "server", "standalone.js");
  const worker = spawn(process.execPath, [app, ...process.argv.slice(2)], {
    env: { ...process.env, RECEIPT_INSTALL_ROOT: root, RECEIPT_DATA_ROOT: active, RECEIPT_DATA_LIBRARY: "1" },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => worker.kill(signal));
  const [code] = await once(worker, "exit");
  process.exitCode = code ?? 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  unlockData?.();
  lock.close();
}
