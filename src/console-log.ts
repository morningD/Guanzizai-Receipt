/** 前端调试日志：基于统一 trace 模型的薄封装（兼容旧 appLog 签名）+ 全局 fetch 追踪。 */
import { diagnosticHeader, trace } from "./trace";

export type LogLevel = "info" | "warn" | "error";

/** 兼容旧调用：appLog(level, msg) → trace(scope="ui")。 */
export function appLog(level: LogLevel, msg: string) {
  trace({ level, scope: "ui", event: msg.slice(0, 60), detail: msg.length > 60 ? msg : undefined });
}

/** 拦截 window.fetch：所有 API 调用自动记录方法/路径/状态/耗时（幂等，仅装一次）。 */
export function installFetchTracing() {
  const w = window as typeof window & { __fetchTraced?: boolean };
  if (w.__fetchTraced) return;
  w.__fetchTraced = true;
  appLog("info", "应用启动");
  window.addEventListener("error", () => trace({ level: "error", scope: "ui", event: "window-error" }));
  window.addEventListener("unhandledrejection", () => trace({ level: "error", scope: "ui", event: "unhandled-rejection" }));
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof window.fetch>) => {
    const started = performance.now();
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (args[1]?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    let resolved: URL;
    try { resolved = new URL(url, window.location.href); }
    catch { return original(...args); }
    const path = resolved.pathname;
    if (resolved.origin !== window.location.origin || !path.startsWith("/api/") || path === "/api/diagnostics") return original(...args);
    try {
      const response = await original(...args);
      trace({
        level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "debug",
        scope: "api",
        event: `${method} ${path}`,
        detail: String(response.status),
        status: response.status,
        operationId: response.headers.get(diagnosticHeader) ?? undefined,
        durationMs: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      trace({
        level: "error",
        scope: "api",
        event: `${method} ${path}`,
        detail: error instanceof Error ? error.message : "网络失败",
        durationMs: Math.round(performance.now() - started),
      });
      throw error;
    }
  };
}
