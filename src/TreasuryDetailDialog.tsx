import { ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { treasuryBillProject, treasuryDetail, treasuryProgress } from "./treasury-sync";
import type { ExpenseLine } from "./types";

const cny = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", currencyDisplay: "code" });
const timelineTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Shanghai" });

export function TreasuryDetailDialog({ line, budgets, materialCount, invoiceTotal, onOpenBill, onClose }: {
  line: ExpenseLine;
  budgets: ReadonlyArray<{ projectId: string; projectName: string }>;
  materialCount: number;
  invoiceTotal: number;
  onOpenBill: (billNo: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { bills, events } = treasuryDetail(line);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  return <dialog
    ref={dialog}
    className="treasury-detail-dialog"
    aria-labelledby={titleId}
    onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
  >
    <header className="treasury-detail-header">
      <div>
        <p>报销详情</p>
        <h2 id={titleId}>{line.title}</h2>
      </div>
      <button type="button" className="icon-button" aria-label="关闭报销详情" onClick={() => dialog.current?.close()}><X size={20} /></button>
    </header>
    <div className="treasury-detail-body">
      <section className="treasury-detail-records" aria-label="报销单与经费项目">
        <h3>报销单</h3>
        {!bills.length && <p className="treasury-detail-muted">{line.treasuryStatus || "尚未登记财务报销单号"}</p>}
        {bills.map((bill) => {
          const project = treasuryBillProject(line, bill, budgets) ?? (bill.projectCode ? { code: bill.projectCode, name: undefined } : undefined);
          const progress = treasuryProgress(bill);
          const settled = progress.stage !== "returned" && Boolean(bill.postedAt);
          return <article className="treasury-detail-record" key={bill.billNo}>
            <header>
              <button type="button" className="bill-link treasury-detail-link" onClick={() => onOpenBill(bill.billNo)} title="在财务系统中查看报销单">
                {bill.billNo}<ExternalLink size={12} aria-hidden="true" />
              </button>
              <span className="treasury-detail-status" data-stage={settled ? "posted" : progress.stage}>{settled ? "财务已入账" : progress.label}</span>
            </header>
            <dl>
              <div className="treasury-detail-project"><dt>经费项目</dt><dd>{project ? <>{project.name && <strong>{project.name}</strong>}<span>{project.code}</span></> : "项目号待同步"}</dd></div>
              {bill.amountCny != null && <div><dt>申请金额</dt><dd>{cny.format(bill.amountCny)}</dd></div>}
              {bill.voucherNo && <div><dt>财务凭证号</dt><dd>{bill.voucherNo}</dd></div>}
              {bill.system && <div><dt>报销渠道</dt><dd>{bill.system === "YBX" ? "智能报销" : "预约报销"}</dd></div>}
            </dl>
          </article>;
        })}
        <dl className="treasury-detail-materials">
          <div><dt>材料</dt><dd>{materialCount} 份</dd></div>
          {invoiceTotal > 0 && <div><dt>票据合计</dt><dd>{cny.format(invoiceTotal)}</dd></div>}
          {line.delivery && <div><dt>已保存的投递设置</dt><dd>{line.delivery.campus} · {line.delivery.printByFinance ? "委托财务打印" : "自行打印"}</dd></div>}
        </dl>
      </section>
      <section className="treasury-detail-history">
        <h3>时间线</h3>
        {events.length ? <ol className="treasury-detail-timeline">
          {events.map(({ label, date, billNo, elabBillNo }) => <li key={`${label}-${billNo ?? elabBillNo ?? ""}`}>
            <strong>{label}</strong>
            {date ? <time dateTime={date}>{date.includes("T") && Number.isFinite(Date.parse(date)) ? timelineTime.format(new Date(date)) : date}</time> : <span>历史记录未留存归档时间</span>}
            {billNo && bills.length > 1 && <span>报销单 {billNo}</span>}
            {elabBillNo && <span>前置单 {elabBillNo}</span>}
          </li>)}
        </ol> : <p className="treasury-detail-muted">暂无已记录的时间点</p>}
      </section>
    </div>
  </dialog>;
}
