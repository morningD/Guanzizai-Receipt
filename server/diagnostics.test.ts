import { mkdtemp, mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiagnostics } from "./diagnostics";
import { diagnosticEvent } from "../src/trace";

let root: string;
const privateText = "姓名示例 /Users/示例/票据.pdf session=虚构令牌 12345-123456-12345";

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "receipt-diagnostics-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("diagnostics", () => {
  it("轮转串行写入，可跨重启读取，旧版原始日志不进入诊断", async () => {
    const directory = path.join(root, ".guanzizai", "logs");
    await mkdir(directory, { recursive: true });
    const legacy = path.join(directory, "server.jsonl");
    await writeFile(legacy, privateText);
    const diagnostics = createDiagnostics(root, 512);
    for (let index = 0; index < 25; index++) {
      diagnostics.record({ level: "error", scope: "classify", event: "failed", durationMs: index, detail: privateText, task: privateText, data: { secret: privateText } });
    }
    const first = await diagnostics.report();
    expect(first.events.at(-1)?.durationMs).toBe(24);
    expect(first.events[0].durationMs).toBeGreaterThan(0);
    for (const name of (await readdir(directory)).filter((name) => name !== "server.jsonl")) {
      expect((await stat(path.join(directory, name))).size).toBeLessThanOrEqual(512);
      expect(await readFile(path.join(directory, name), "utf8")).not.toContain(privateText);
    }
    const reopened = createDiagnostics(root, 512);
    expect(await reopened.report()).toEqual(first);
    expect(await readFile(legacy, "utf8")).toBe(privateText);
  });

  it("开发日志按等级保存且与脱敏导出隔离，设置跨重启生效", async () => {
    const diagnostics = createDiagnostics(root, undefined, true);
    const directory = path.join(root, ".guanzizai", "logs");
    const developer = path.join(directory, "developer.jsonl");
    expect(await diagnostics.getSettings()).toEqual({ level: "debug", maxMiB: 32 });
    diagnostics.record({ level: "debug", scope: "model-state", event: "stale-merge-enter", detail: "previous 证据 1 incoming 证据 2" });
    diagnostics.record({ level: "info", scope: "online-submit", event: "log", detail: privateText });
    await diagnostics.saveSettings({ level: "warn", maxMiB: 4 });
    diagnostics.record({ level: "info", scope: "print", event: "lp.done" });
    diagnostics.record({ level: "warn", scope: "print", event: "lp.unconfirmed" });
    const { events } = await diagnostics.report();
    const raw = await readFile(developer, "utf8");
    expect(raw).toContain("previous 证据 1");
    expect(raw).toContain("lp.unconfirmed");
    expect(raw).not.toContain("lp.done");
    expect(raw).not.toContain(privateText);
    expect(events.map((event) => event.event)).toEqual(["lp.done", "lp.unconfirmed"]);
    const reopened = createDiagnostics(root, undefined, true);
    expect(await reopened.getSettings()).toEqual({ level: "warn", maxMiB: 4 });
    await truncate(developer, 1024 * 1024);
    await writeFile(developer + ".1", "保留此小分卷");
    await reopened.saveSettings({ level: "off", maxMiB: 1 });
    await expect(stat(developer)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(developer + ".1", "utf8")).toBe("保留此小分卷");
    reopened.record({ level: "error", scope: "print", event: "lp.fail" });
    expect((await reopened.report()).events.at(-1)?.event).toBe("lp.fail");
    await expect(stat(developer)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝自由文本、查询参数和格式不合法的关联号", () => {
    const t = Date.now();
    expect(diagnosticEvent({ t, level: "error", scope: "ui", event: privateText })).toBeNull();
    expect(diagnosticEvent({ t, level: "error", scope: "api", event: "POST /api/import?token=" + privateText })).toBeNull();
    expect(diagnosticEvent({ t, level: "error", scope: "constructor", event: "failed" })).toBeNull();
    expect(diagnosticEvent({ t, level: "error", scope: "api", event: "POST /api/import", operationId: privateText, durationMs: -1, status: 400, detail: privateText }))
      .toEqual({ t, level: "error", scope: "api", event: "POST /api/import", status: 400 });
  });
});
