/** 页面调试日志，以及前后端共享的脱敏诊断事件白名单。 */

export type TraceLevel = "debug" | "info" | "warn" | "error";

export type TraceEntry = {
  /** 当前页面内单调自增序号。 */
  id: number;
  t: number;
  level: TraceLevel;
  /** 事件来源：api / ai / classify / print / treasury / budget / store / ui … */
  scope: string;
  /** 短码事件名，如 "ai.classify.done"、"POST /api/model-state"。 */
  event: string;
  detail?: string;
  durationMs?: number;
  operationId?: string;
  status?: number;
  exitCode?: number;
  /** 结构化补充（序列化截断存储，仅调试用途）。 */
  data?: unknown;
  /** 任务标签（如 "online:贵阳差旅"）：区分并聚合并发任务的事件。 */
  task?: string;
};

const MAX_ENTRIES = 800;
const entries: TraceEntry[] = [];
let nextId = 1;
let version = 0;
const listeners = new Set<() => void>();

const emit = () => {
  version += 1;
  for (const listener of listeners) listener();
};

export function trace(entry: Omit<TraceEntry, "id" | "t"> & { t?: number }): TraceEntry {
  const full: TraceEntry = { id: nextId++, t: entry.t ?? Date.now(), ...entry };
  entries.push(full);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  emit();
  return full;
}

export function traceEntriesAfter(afterId: number): TraceEntry[] {
  if (afterId <= 0) return entries.slice();
  // 二分找第一个 id > afterId 的位置（entries 按 id 递增）。
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].id <= afterId) lo = mid + 1;
    else hi = mid;
  }
  return entries.slice(lo);
}

export function latestTraceId(): number {
  return entries.length ? entries[entries.length - 1].id : 0;
}

export function subscribeTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTraceVersion(): number {
  return version;
}

const diagnosticRoutes = new Set([
  "/api/first-run", "/api/school-runtime", "/api/import", "/api/auto-classify", "/api/evidence-search",
  "/api/model-state", "/api/split-line", "/api/move-line", "/api/treasury-poll", "/api/print", "/api/print-confirm",
  "/api/online-submit", "/api/online-submit-decide", "/api/online-submit-stop",
  "/api/elab-hc-submit", "/api/elab-hc-stop", "/api/elab-hc-sync", "/api/elab-csf-submit", "/api/elab-csf-stop",
  "/api/ai-backend-test-stream", "/api/app-update",
]);
const diagnosticEvents: Record<string, readonly string[]> = {
  ui: ["render-error", "window-error", "unhandled-rejection"],
  ai: ["classify.done", "backend-test.failed"],
  classify: ["completed", "failed", "missing-input", "no-materials", "incomplete-result"],
  "line-move": ["archive", "restore", "submit"],
  "evidence-search": ["ai-degraded", "linked"],
  treasury: ["poll.done"],
  print: ["lp.submit", "lp.fail", "lp.done", "lp.lost", "lp.unconfirmed"],
  "online-submit": ["start", "failed", "stopped", "awaiting", "submitted", "withdrawn", "bill-registered"],
  "elab-hc": ["start", "failed", "stopped", "draft_saved", "submitted", "status-synced"],
  "elab-csf": ["start", "failed", "stopped", "draft_saved", "submitted"],
};

export const diagnosticHeader = "X-Receipt-Operation-Id";
export const diagnosticLimit = 200;

export function isDiagnosticRoute(pathname: string) {
  return diagnosticRoutes.has(pathname);
}

export type DiagnosticEvent = {
  t: number;
  level: TraceLevel;
  scope: string;
  event: string;
  operationId?: string;
  status?: number;
  durationMs?: number;
  exitCode?: number;
};

/** Construct a new object from approved values only. Never serialize source text, paths, or payloads. */
export function diagnosticEvent(input: unknown): DiagnosticEvent | null {
  if (!input || typeof input !== "object") return null;
  const { t, level, scope, event, operationId, status, durationMs, exitCode } = input as Partial<DiagnosticEvent>;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t <= 0 || t > 8.64e15
    || (level !== "debug" && level !== "info" && level !== "warn" && level !== "error")
    || typeof scope !== "string" || typeof event !== "string") return null;
  const api = /^(GET|POST|PUT|DELETE|PATCH) (\/api\/[a-z-]+)$/.exec(event);
  if (scope === "api" ? !api || !isDiagnosticRoute(api[2]) : !Object.hasOwn(diagnosticEvents, scope) || !diagnosticEvents[scope].includes(event)) {
    return null;
  }
  const result: DiagnosticEvent = { t, level, scope, event };
  if (typeof operationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) result.operationId = operationId;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  if (typeof durationMs === "number" && Number.isInteger(durationMs) && durationMs >= 0 && durationMs <= 86_400_000) result.durationMs = durationMs;
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 0xffffffff) result.exitCode = exitCode;
  return result;
}
