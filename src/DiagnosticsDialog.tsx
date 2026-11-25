import { useEffect, useId, useRef, useState } from "react";
import { DataLibraryPanel, useDataLibrary } from "./DataLibraryPanel";
import { X } from "lucide-react";
import { developerLogLevels, parseDeveloperLogSettings, type DeveloperLogSettings } from "./log-settings";
import { diagnosticEvent, diagnosticLimit, traceEntriesAfter, type DiagnosticEvent } from "./trace";

export default function DiagnosticsDialog({ onClose, systemSettings = false }: { onClose: () => void; systemSettings?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const showLogSettings = systemSettings && import.meta.env.DEV;
  const [library, setLibrary] = useDataLibrary();
  const [tab, setTab] = useState<"logs" | "diagnostics" | "library">(showLogSettings ? "logs" : "diagnostics");
  const visibleLibrary = systemSettings && library;
  const [preview, setPreview] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element?.open) element?.showModal();
    if (tab !== "diagnostics") return;
    const request = new AbortController();
    const collect = (events: unknown[], source: "browser" | "server") => events.flatMap((input) => {
      const event = diagnosticEvent(input);
      return event ? [{ ...event, source }] : [];
    });
    void fetch("/api/diagnostics", { signal: request.signal }).then(async (response) => {
      if (!response.ok) throw new Error("无法读取诊断记录");
      const report = await response.json() as { version: string; platform: string; arch: string; events: DiagnosticEvent[] };
      const events = [...collect(report.events, "server"), ...collect(traceEntriesAfter(0), "browser")]
        .sort((first, second) => first.t - second.t)
        .slice(-diagnosticLimit);
      setPreview(JSON.stringify({
        schemaVersion: 1, version: report.version, platform: report.platform, arch: report.arch, events,
      }, null, 2));
    }).catch(() => {
      if (!request.signal.aborted) setError(true);
    });
    return () => request.abort();
  }, [tab]);

  function download() {
    const url = URL.createObjectURL(new Blob([preview + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "guanzizai-receipt-diagnostics.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <dialog ref={dialog} className="treasury-detail-dialog" aria-labelledby={title} onClose={onClose}>
    <header className="treasury-detail-header">
      <h2 id={title}>{systemSettings ? "系统设置" : "脱敏诊断"}</h2>
      <button type="button" className="icon-button" aria-label={systemSettings ? "关闭系统设置" : "关闭脱敏诊断"} onClick={() => dialog.current?.close()}><X size={20} /></button>
    </header>
    {(showLogSettings || visibleLibrary) && <nav className="log-settings-tabs" aria-label="系统设置分类">
      {showLogSettings && <button type="button" className="quiet-button" aria-pressed={tab === "logs"} onClick={() => setTab("logs")}>日志设置</button>}
      {visibleLibrary && <button type="button" className="quiet-button" aria-pressed={tab === "library"} onClick={() => setTab("library")}>数据目录与备份</button>}
      <button type="button" className="quiet-button" aria-pressed={tab === "diagnostics"} onClick={() => {
        if (tab !== "diagnostics") { setPreview(""); setError(false); setTab("diagnostics"); }
      }}>脱敏诊断</button>
    </nav>}
    {tab === "logs" ? <DeveloperLogSettingsForm /> : tab === "library" && visibleLibrary
      ? <section className="diagnostics-body"><DataLibraryPanel status={visibleLibrary} onChange={setLibrary} /></section> : <section className="diagnostics-body">
      <p>包含应用版本、系统和近期操作状态。请先查看内容，再下载并随问题反馈自行分享。</p>
      {preview && <>
        <textarea aria-label="诊断内容预览" value={preview} readOnly spellCheck={false} />
        <button type="button" className="quiet-button" onClick={download}>下载诊断 JSON</button>
      </>}
      {!preview && (error ? <p role="alert">无法读取诊断记录，请关闭后重试。</p> : <p role="status">正在读取诊断记录…</p>)}
    </section>}
  </dialog>;
}


function DeveloperLogSettingsForm() {
  const [config, setConfig] = useState<DeveloperLogSettings | null>(null);
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    void fetch("/api/log-settings", { signal: request.signal }).then(async (response) => {
      const value = response.ok && parseDeveloperLogSettings(await response.json());
      if (!value) throw new Error("日志设置读取失败");
      setConfig(value);
    }).catch(() => {
      if (!request.signal.aborted) setFeedback("日志设置读取失败，请关闭后重试。");
    });
    return () => request.abort();
  }, []);

  async function save(data: FormData) {
    const next = parseDeveloperLogSettings({ level: data.get("level"), maxMiB: Number(data.get("maxMiB")) });
    if (!next) return setFeedback("容量须为 1 至 256 MiB 的整数。");
    setSaving(true);
    setFeedback("");
    try {
      const response = await fetch("/api/log-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error("日志设置保存失败");
      setConfig(next);
      setFeedback("设置已保存并生效。");
    } catch {
      setFeedback("日志设置保存失败，请检查数据目录权限。");
    } finally {
      setSaving(false);
    }
  }

  return <section className="diagnostics-body">
    <p>开发日志仅保存在本机。达到容量上限时会轮转，缩小容量会清理超限分卷。</p>
    {config && <form className="log-settings-form" onSubmit={(event) => {
      event.preventDefault();
      void save(new FormData(event.currentTarget));
    }}>
      <label>最低日志等级
        <select name="level" defaultValue={config.level}>
          {developerLogLevels.map((level) => <option key={level} value={level}>{level === "off" ? "关闭开发日志" : level.toUpperCase()}</option>)}
        </select>
      </label>
      <label>总容量上限（MiB）
        <input name="maxMiB" type="number" min={1} max={256} step={1} defaultValue={config.maxMiB} required />
      </label>
      <button type="submit" className="quiet-button" disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
    </form>}
    {feedback ? <p role="status">{feedback}</p> : !config && <p role="status">正在读取日志设置…</p>}
  </section>;
}
