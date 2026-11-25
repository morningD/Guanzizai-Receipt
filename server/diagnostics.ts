import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { defaultDeveloperLogSettings, developerLogLevels, parseDeveloperLogSettings, type DeveloperLogSettings } from "../src/log-settings";
import { version } from "../package.json";
import { diagnosticEvent, diagnosticHeader, diagnosticLimit, isDiagnosticRoute, type DiagnosticEvent, type TraceEntry } from "../src/trace";

type TraceInput = Omit<TraceEntry, "id" | "t">;
const pollingPaths = new Set(["/api/printers", "/api/treasury-pulse", "/api/model-state"]);
const detailEvents = new Set(["meta.merged-put", "model-state.stale-merge", "model-state.stale-merge-enter"]);
const taskLabels = new Set(["自动归类", "双写保护", "归类元数据", "手工标注字段", "线上递交", "elab前置单", "AI 搜索引用", "劳务费"]);

async function fileSize(file: string) {
  return stat(file).then((entry) => entry.size, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
}

async function appendRotating(file: string, line: string, limit: number) {
  const bytes = Buffer.byteLength(line);
  if (bytes > limit) return;
  const size = await fileSize(file);
  if (size + bytes > limit) {
    await rm(file + ".1", { force: true });
    if (size > limit) await rm(file, { force: true });
    else await rename(file, file + ".1");
  }
  await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
}

export function createDiagnostics(root: string, maxBytes = 512 * 1024, developerMode = false) {
  const directory = path.join(root, ".guanzizai", "logs");
  const current = path.join(directory, "diagnostics.jsonl");
  const previous = current + ".1";
  const developerFile = path.join(directory, "developer.jsonl");
  const settingsFile = path.join(directory, "developer-settings.json");
  const limitPerFile = (settings: DeveloperLogSettings) => settings.maxMiB * 512 * 1024;
  const developerSettings = developerMode ? readFile(settingsFile, "utf8")
    .then((raw) => parseDeveloperLogSettings(JSON.parse(raw)) ?? defaultDeveloperLogSettings)
    .catch(() => defaultDeveloperLogSettings) : null;
  let settings = developerSettings;
  const operation = new AsyncLocalStorage<string>();
  let pending = Promise.resolve();
  let queued = 0;

  function record(input: TraceInput) {
    const t = Date.now();
    const operationId = operation.getStore();
    const event = diagnosticEvent({ ...input, t, operationId });
    if ((!event && !developerMode) || queued >= 1000) return;
    queued++;
    pending = pending.then(async () => {
      await mkdir(directory, { recursive: true });
      if (event) await appendRotating(current, JSON.stringify(event) + "\n", maxBytes);
      if (!settings) return;
      const config = await settings;
      if (developerLogLevels.indexOf(input.level) < developerLogLevels.indexOf(config.level)) return;
      const { scope, event: name, level, status, durationMs, exitCode, detail, task } = input;
      const local = {
        t, scope, event: name, level, operationId, status, durationMs, exitCode,
        detail: detailEvents.has(`${scope}.${name}`) ? detail?.slice(0, 300) : undefined,
        task: task && taskLabels.has(task) ? task : undefined,
      };
      await appendRotating(developerFile, JSON.stringify(local) + "\n", limitPerFile(config));
    }).catch(() => undefined).finally(() => { queued--; });
  }

  function saveSettings(value: DeveloperLogSettings) {
    const result = pending.then(async () => {
      if (!developerMode) throw new Error("仅开发模式可修改日志设置");
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `settings-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
        await rename(temporary, settingsFile);
      } finally {
        await rm(temporary, { force: true });
      }
      settings = Promise.resolve(value);
      const limit = limitPerFile(value);
      for (const file of [developerFile, developerFile + ".1"]) {
        if (await fileSize(file) > limit) await rm(file, { force: true });
      }
      return value;
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  function track<T>(request: IncomingMessage, response: ServerResponse, pathname: string, run: () => T): T {
    const diagnosticRoute = isDiagnosticRoute(pathname);
    const localApi = developerMode && /^\/api\/[a-z-]+$/.test(pathname)
      && pathname !== "/api/diagnostics" && pathname !== "/api/log-settings";
    if (!diagnosticRoute && !localApi) return run();
    const started = Date.now();
    const id = randomUUID();
    response.setHeader(diagnosticHeader, id);
    return operation.run(id, () => {
      const finish = (status?: number) => operation.run(id, () => record({
        level: status == null || status >= 500 ? "error" : status >= 400 ? "warn"
          : !diagnosticRoute || pollingPaths.has(pathname) && request.method === "GET" ? "debug" : "info",
        scope: "api", event: `${request.method ?? "GET"} ${pathname}`,
        status, durationMs: Math.max(0, Date.now() - started),
      }));
      response.once("finish", () => finish(response.statusCode));
      response.once("close", () => { if (!response.writableFinished) finish(); });
      return run();
    });
  }

  function report() {
    const result = pending.then(async () => {
      const events: DiagnosticEvent[] = [];
      for (const file of [previous, current]) {
        try {
          if ((await stat(file)).size > maxBytes) continue;
          const content = await readFile(file, "utf8");
          for (const line of content.trim().split("\n").slice(-diagnosticLimit)) {
            try {
              const event = diagnosticEvent(JSON.parse(line));
              if (event) events.push(event);
            } catch { /* Ignore incomplete records. */ }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return { schemaVersion: 1, version, platform: process.platform, arch: process.arch, events: events.slice(-diagnosticLimit) };
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return { record, track, report, saveSettings, getSettings: () => pending.then(() => settings) };
}
