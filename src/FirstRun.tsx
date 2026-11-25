import { lazy, Suspense, useEffect, useState } from "react";
import { DataLibraryPanel, useDataLibrary } from "./DataLibraryPanel";
import type { ReactNode } from "react";
import type { FirstRunConfig } from "./first-run";
import type { LineDelivery } from "./types";

const DiagnosticsDialog = lazy(() => import("./DiagnosticsDialog"));

export function FirstRun({ children }: { children: (delivery: LineDelivery) => ReactNode }) {
  const [library, setLibrary] = useDataLibrary();
  const [config, setConfig] = useState<FirstRunConfig | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const readConfig = () => {
    setError("");
    fetch("/api/first-run").then(async (response) => {
      if (!response.ok) throw new Error("无法读取首次配置");
      setConfig(await response.json() as FirstRunConfig);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取首次配置"));
  };
  useEffect(readConfig, []);

  async function complete(fields: Record<string, unknown>) {
    if (library?.pending) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/first-run", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!response.ok) throw new Error("无法保存配置，请检查数据目录是否可写");
      setConfig(await response.json() as FirstRunConfig);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存配置");
    } finally {
      setSaving(false);
    }
  }

  if (config?.completed) return children(config.delivery);
  return <div className="dialog-backdrop">
    <form className="new-line-dialog first-run-dialog" onSubmit={(event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      void complete({ ...Object.fromEntries(values), printByFinance: values.has("printByFinance") });
    }}>
      <header><h2>首次配置</h2></header>
      {config ? <>
        <p>票据簿数据保存在 <code>{config.dataRoot}</code>。姓名、学院和常用投递方式可稍后填写。</p>
        {library && <details className="first-run-data">
          <summary>选择数据目录或迁移旧库</summary>
          <DataLibraryPanel status={library} onChange={setLibrary} />
        </details>}
        <label>姓名<input name="chineseName" autoComplete="name" maxLength={120} /></label>
        <label>学院或部门<input name="organization" maxLength={120} /></label>
        <label>常用投递校区<select name="campus" defaultValue=""><option value="">稍后选择</option><option>普陀校区</option><option>闵行校区</option></select></label>
        <label>协同审批人<input name="approver" placeholder="工号/姓名" maxLength={120} /></label>
        <label className="signature-option"><input type="checkbox" name="printByFinance" />委托财务打印</label>
        <p>进入票据簿后，可使用「用户资料」配置并验证学校账号。</p>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="quiet-button" onClick={() => void complete({})} disabled={saving || Boolean(library?.pending)}>稍后配置</button>
          <button type="submit" className="create-button" disabled={saving || Boolean(library?.pending)}>{saving ? "保存中…" : "保存并开始"}</button>
        </footer>
      </> : error ? <><p role="alert">{error}</p><button type="button" onClick={readConfig}>重试</button></> : <p>正在读取本地配置…</p>}
      {error && <button type="button" className="quiet-button" onClick={() => setDiagnosticsOpen(true)}>导出脱敏诊断</button>}
    </form>
    {diagnosticsOpen && <Suspense fallback={null}><DiagnosticsDialog onClose={() => setDiagnosticsOpen(false)} /></Suspense>}
  </div>;
}
