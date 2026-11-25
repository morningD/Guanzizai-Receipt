import { ArrowLeft, Download, FileText, Search, X } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { ConvertedMaterialPreview } from "./ConvertedMaterialPreview";
import { FilePreviewTrigger } from "./FilePreviewTrigger";
import { materialSearchHighlights, materialSearchTerms, searchMaterials } from "./material-search";
import { materialUrl } from "./store";
import type { ExpenseLine, ReceiptRecord, ViewId } from "./types";

export function MaterialSearchDialog({ records, lines, views, onClose }: {
  records: readonly ReceiptRecord[];
  lines: readonly ExpenseLine[];
  views: ReadonlyArray<{ id: ViewId; label: string }>;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState(() => views.map((view) => view.id));
  const [preview, setPreview] = useState<ReceiptRecord>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const results = useMemo(() => searchMaterials(records, lines, scopes, query), [records, lines, scopes, query]);
  const terms = materialSearchTerms(query);
  const highlight = (text: string) => materialSearchHighlights(text, terms).map((part, index) => (
    part.matched ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>
  ));

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    input.current?.focus();
  }, []);

  async function download(file: ReceiptRecord) {
    setDownloadingPath(file.path);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/material-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path }),
      });
      const result = await response.json() as { name?: string; error?: string };
      if (!response.ok || !result.name) throw new Error(result.error ?? "下载失败");
      setFeedback({ text: `已保存到下载目录：${result.name}` });
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : "下载失败", error: true });
    } finally {
      setDownloadingPath("");
    }
  }

  const downloadButton = (file: ReceiptRecord) => (
    <button type="button" className="quiet-button" disabled={Boolean(downloadingPath)} onClick={() => void download(file)}>
      <Download size={14} /> {downloadingPath === file.path ? "保存中…" : "下载"}
    </button>
  );
  const previewIsDirect = preview && ["pdf", "txt", "jpg", "jpeg", "png"].includes(preview.ext);
  const previewSrc = preview && (previewIsDirect ? materialUrl(preview.path) : `/api/preview?path=${encodeURIComponent(preview.path)}`);

  return (
    <dialog ref={dialog} className="material-search-dialog" aria-labelledby={titleId} onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <header className="treasury-detail-header">
        <h2 id={titleId}>文件搜索</h2>
        <button type="button" className="icon-button" aria-label="关闭文件搜索" onClick={() => dialog.current?.close()}><X size={20} /></button>
      </header>
      <div className="material-search-body">
        <label className="material-search-input">
          <Search size={17} aria-hidden="true" />
          <input ref={input} type="search" aria-label="搜索文件" placeholder="文件名、商户或票据集" value={query}
            onChange={(event) => { setQuery(event.target.value); setPreview(undefined); }} />
        </label>
        <fieldset className="material-search-scopes">
          <legend>搜索范围</legend>
          {views.map(({ id, label }) => (
            <label key={id}><input type="checkbox" checked={scopes.includes(id)} onChange={(event) => {
              const checked = event.target.checked;
              setScopes((current) => checked ? [...current, id] : current.filter((scope) => scope !== id));
              setPreview(undefined);
            }} />{label}</label>
          ))}
        </fieldset>
        {feedback && <p className="material-search-feedback" role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
        {preview ? (
          <section className="material-search-preview" aria-label="文件预览">
            <div className="material-search-preview-bar">
              <button type="button" className="quiet-button" onClick={() => setPreview(undefined)}><ArrowLeft size={14} /> 返回结果</button>
              <strong>{preview.name}</strong>
              {downloadButton(preview)}
            </div>
            {previewFailed ? <p>无法生成预览，可下载原文件查看。</p> :
              ["pdf", "txt", "ofd"].includes(preview.ext)
                ? <iframe title={preview.ext === "ofd" ? "OFD 文本预览" : `${preview.name} 预览`} src={previewSrc} />
                : previewIsDirect ? <img alt={`${preview.name} 预览`} src={previewSrc} onError={() => setPreviewFailed(true)} />
                  : <ConvertedMaterialPreview url={previewSrc!} name={preview.name} />}
          </section>
        ) : (
          <section className="material-search-results" aria-label="搜索结果">
            <p role="status">{!scopes.length ? "请选择搜索范围" : !query.trim() ? "输入关键词搜索" : results.length ? `找到 ${results.length} 份文件` : "未找到匹配的文件"}</p>
            {results.length > 0 && <ul>
              {results.map(({ file, status, lineTitle, matchingDetails }) => (
                <li key={file.path}>
                  <FileText size={16} aria-hidden="true" />
                  <div className="material-search-file">
                    <strong title={file.name}>{highlight(file.name)}</strong>
                    <span>{highlight([views.find((view) => view.id === status)?.label, lineTitle || file.folder.split("/").at(-1), file.issuer, ...matchingDetails].filter(Boolean).join(" · "))}</span>
                  </div>
                  <div className="material-search-actions">
                    <FilePreviewTrigger file={file} label="预览" onOpen={() => { setPreviewFailed(false); setPreview(file); }} />
                    {downloadButton(file)}
                  </div>
                </li>
              ))}
            </ul>}
          </section>
        )}
      </div>
    </dialog>
  );
}
