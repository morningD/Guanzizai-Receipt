import { X } from "lucide-react";
import type { ExpenseLine } from "./types";
import { PROCESS_GUIDES } from "./process-guides";

export function ProcessGuideDialog({ title, kind, onClose }: { title: string; kind: ExpenseLine["kind"]; onClose: () => void }) {
  const guide = PROCESS_GUIDES[kind];
  return <div className="dialog-backdrop guide-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="process-guide-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>PROCESS GUIDE</span><h2 id="process-guide-title">{title} · 办事指引</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <p className="guide-motto">{guide.motto}</p>
      <div className="guide-stages">
        {guide.stages.map((stage, index) => <article className="guide-stage" key={stage.title}>
          <div className="guide-stage-marker"><i>{String(index + 1).padStart(2, "0")}</i><span>{stage.timing}</span></div>
          <div className="guide-stage-body">
            <strong>{stage.title}</strong>
            <ol>{stage.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            {stage.warning && <p className="guide-warning">{stage.warning}</p>}
          </div>
        </article>)}
      </div>
      <footer className="guide-footnote">选经费前，可在财务系统打开「项目管理 → 可报销费用情况」，按科目查询可使用的项目。系统材料关系见右上角「规则库 · 流程图谱」。</footer>
    </section>
  </div>;
}
