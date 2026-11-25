import { useEffect, useState } from "react";

const actions = {
  use: "使用另一个目录",
  migrate: "从旧库迁移",
  backup: "备份当前库",
  restore: "从备份恢复",
};
type Action = keyof typeof actions;
type LibraryStatus = {
  active: string;
  pending?: { action: Action; destination: string };
  last?: { action: Action; status: "completed" | "failed"; destination: string; error?: string };
};

export function useDataLibrary() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/data-library", { signal: abort.signal }).then(async (response) => {
      if (response.ok) setStatus(await response.json() as LibraryStatus);
    }).catch(() => undefined);
    return () => abort.abort();
  }, []);
  return [status, setStatus] as const;
}

export function DataLibraryPanel({ status, onChange }: { status: LibraryStatus; onChange: (value: LibraryStatus) => void }) {
  const [action, setAction] = useState<Action>("use");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const needSource = action === "migrate" || action === "restore";

  async function save(cancel = false) {
    setError("");
    setSaving(true);
    try {
      const response = await fetch("/api/data-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cancel ? { action: "cancel" } : { action, source, destination }),
      });
      const result = await response.json() as LibraryStatus & { error?: string };
      if (!response.ok) throw new Error(result.error || "无法保存数据操作");
      onChange(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存数据操作");
    } finally {
      setSaving(false);
    }
  }

  return <div className="data-library-panel">
    <p>当前数据目录 <code>{status.active}</code></p>
    {status.last && <p role={status.last.status === "failed" ? "alert" : "status"}>
      {actions[status.last.action]}{status.last.status === "completed"
        ? <>已完成。<code>{status.last.destination}</code></>
        : <>失败，当前数据目录已保留。{status.last.error}</>}
    </p>}
    {status.pending ? <>
      <p role="status">已安排「{actions[status.pending.action]}」。关闭票据簿服务后，用原启动脚本重新打开。目标 <code>{status.pending.destination}</code></p>
      <button type="button" className="quiet-button" disabled={saving} onClick={() => void save(true)}>取消待执行操作</button>
    </> : <>
      <label>数据操作
        <select aria-label="数据操作" value={action} onChange={(event) => { setAction(event.target.value as Action); setError(""); }}>
          {Object.entries(actions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      {needSource && <label>{action === "restore" ? "备份目录" : "旧库目录"}
        <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="本机目录的绝对路径" spellCheck={false} />
      </label>}
      <label>目标目录
        <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="本机目录的绝对路径" spellCheck={false} />
      </label>
      <p>{action === "use" ? "可选空目录、尚未创建的目录或已有票据簿。"
        : "请输入尚未创建的目标目录。复制在重启时执行，原库保留。备份包含票据和个人资料，请自行妥善保管。"}</p>
      <button type="button" className="quiet-button" disabled={saving || !destination.trim() || (needSource && !source.trim())}
        onClick={() => void save()}>安排下次启动执行</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
