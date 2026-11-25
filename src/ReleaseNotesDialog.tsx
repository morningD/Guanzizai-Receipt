import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import notes from "../docs/RELEASE_NOTES.md?raw";
import { renderMarkdownToHtml } from "./mini-markdown";

const publicRepository = "https://github.com/morningD/Guanzizai-Receipt";

export function ReleaseNotesDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function update() {
    setChecking(true);
    setStatus("");
    try {
      const response = await fetch("/api/app-update", { method: "POST" });
      const result = await response.json() as { status?: string; error?: string; version?: string };
      if (!response.ok) throw new Error(result.error || "检查更新失败。");
      if (result.status === "development") setStatus("开发模式检查完成。没有下载或替换程序文件。");
      else if (result.status === "pending") setStatus(`v${result.version} 已下载并校验。关闭票据簿服务，再用原启动脚本打开即可应用更新。`);
      else if (result.status === "current") setStatus("当前已是最新版本。");
      else setStatus("暂时没有公开更新。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "检查更新失败。");
    } finally {
      setChecking(false);
    }
  }

  return <dialog ref={dialog} className="treasury-detail-dialog" aria-labelledby={title} onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
    <header className="treasury-detail-header">
      <h2 id={title}>版本说明 · v{version}</h2>
      <button type="button" className="icon-button" aria-label="关闭版本说明" onClick={() => dialog.current?.close()}><X size={20} /></button>
    </header>
    <div className="treasury-detail-body">
      <section>
        <div dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(notes) }} />
        <p><a href={publicRepository} target="_blank" rel="noreferrer">GitHub 公共仓库</a></p>
        {status && <p role="status">{status}</p>}
        <button type="button" className="quiet-button" disabled={checking} onClick={() => void update()}>
          {checking ? "正在检查更新…" : "检查并更新"}
        </button>
      </section>
    </div>
  </dialog>;
}
