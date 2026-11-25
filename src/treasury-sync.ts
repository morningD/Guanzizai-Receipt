import type { ExpenseLine, TreasuryBillRecord } from "./types";

/** 财务系统（预约报销平台）报销单记录，来自 treasury_research/fetch_bill_status.py 输出。 */
export type TreasuryBill = {
  billNo: string;
  projectCode?: string;
  appliedAt?: string;
  reimburser?: string;
  status?: string;
  remark?: string;
  postedAt?: string;
  voucherNo?: string;
  amount?: string;
  category?: string;
};

export type TreasuryProgress =
  | { stage: "submitted"; label: string; posted: false }
  | { stage: "delivered"; label: string; posted: false }
  | { stage: "documenting"; label: string; posted: false }
  | { stage: "reviewing"; label: string; posted: false }
  | { stage: "awaiting-payment"; label: string; posted: false }
  | { stage: "paid"; label: string; posted: false }
  | { stage: "posted"; label: string; posted: true }
  | { stage: "returned"; label: string; posted: false }
  | { stage: "unknown"; label: string; posted: false };

/** 将财务系统状态映射为票据簿中的进度。 */
export function treasuryProgress(bill: Pick<TreasuryBill, "status">): TreasuryProgress {
  const status = (bill.status ?? "").trim();
  if (status.includes("退回")) return { stage: "returned", label: "财务退回，需处理", posted: false };
  if (status.includes("已入账")) return { stage: "posted", label: "财务已入账", posted: true };
  if (status === "报销完成") return { stage: "paid", label: "支付完成，待入账", posted: false };
  if (status.includes("等待支付")) return { stage: "awaiting-payment", label: "已复核，待支付", posted: false };
  if (status.includes("等待复核")) return { stage: "reviewing", label: "已制单，复核中", posted: false };
  if (status.includes("等待制单")) return { stage: "documenting", label: "已分配，制单中", posted: false };
  if (status.includes("协同")) return { stage: "submitted", label: "协同审批中", posted: false };
  if (status === "投递成功") return { stage: "delivered", label: "已投递财务", posted: false };
  if (status.includes("已预约")) return { stage: "submitted", label: "已递交，待投递", posted: false };
  return { stage: "unknown", label: status || "跟踪中", posted: false };
}

/** 展示用：每张报销单的轮询快照。优先 treasuryBills；旧数据无该字段时从顶层字段合成单条（主单）。 */
export function lineTreasuryBills(line: Pick<ExpenseLine, "treasuryBillNo" | "treasuryBillNos" | "treasuryBills" | "treasuryStatus" | "treasuryPostedAt" | "treasuryVoucherNo" | "treasuryAmountCny">): TreasuryBillRecord[] {
  if (line.treasuryBills?.length) return line.treasuryBills;
  if (!line.treasuryBillNo) return [];
  return [{
    billNo: line.treasuryBillNo,
    status: line.treasuryStatus,
    postedAt: line.treasuryPostedAt,
    voucherNo: line.treasuryVoucherNo,
    amountCny: line.treasuryAmountCny,
  }];
}

export function archivedApplicationTotal(lines: readonly ExpenseLine[]): number | undefined {
  const amounts = new Map<string, number>();
  for (const line of lines) {
    if (line.status !== "archived") continue;
    if (line.treasuryBillNo && typeof line.treasuryAmountCny === "number" && Number.isFinite(line.treasuryAmountCny) && !amounts.has(line.treasuryBillNo)) {
      amounts.set(line.treasuryBillNo, line.treasuryAmountCny);
    }
    for (const bill of line.treasuryBills ?? []) {
      if (bill.billNo && typeof bill.amountCny === "number" && Number.isFinite(bill.amountCny)) {
        amounts.set(bill.billNo, bill.amountCny);
      }
    }
  }
  if (!amounts.size) return undefined;
  return [...amounts.values()].reduce((total, amount) => total + amount, 0);
}

export function treasuryBillProject(line: ExpenseLine, bill: TreasuryBillRecord, budgets: ReadonlyArray<{ projectId: string; projectName: string }>) {
  const registered = new Set([...lineBillNos(line), ...lineTreasuryBills(line).map((item) => item.billNo)]);
  const fallback = registered.size === 1 && registered.has(bill.billNo) ? line.projectId?.trim() : undefined;
  const code = bill.projectCode?.trim() || fallback;
  if (!code) return undefined;
  const budget = budgets.find((entry) => entry.projectId === code);
  if (!budget && code !== fallback) return undefined;
  return { code, name: budget?.projectName };
}

/** 把财务查询结果合并进票据集；返回新对象（无变化时返回原引用）。 */
export function applyTreasuryBill(line: ExpenseLine, bill: TreasuryBill): ExpenseLine {
  const amountCny = Number(String(bill.amount ?? "").replace(/[,\s¥元]/g, ""));
  const next: ExpenseLine = {
    ...line,
    treasuryBillNo: bill.billNo || line.treasuryBillNo,
    treasuryBillNos: mergeBillNos(line.treasuryBillNos, line.treasuryBillNo, bill.billNo),
    treasuryStatus: bill.status ?? line.treasuryStatus,
    treasuryStatusAt: bill.postedAt || bill.appliedAt || line.treasuryStatusAt,
    treasuryVoucherNo: bill.voucherNo || line.treasuryVoucherNo,
    treasuryPostedAt: bill.postedAt || line.treasuryPostedAt,
    ...(Number.isFinite(amountCny) && amountCny > 0 ? { treasuryAmountCny: amountCny } : {}),
  };
  const unchanged = (Object.keys(next) as Array<keyof ExpenseLine>)
    .filter((key) => key.startsWith("treasury"))
    .every((key) => JSON.stringify(next[key]) === JSON.stringify(line[key]));
  return unchanged ? line : next;
}

/** 合并报销单号：保持去重与稳定顺序（主单在前）。 */
export function mergeBillNos(existing: string[] | undefined, primary: string | undefined, added: string | undefined): string[] | undefined {
  const all = [primary, ...(existing ?? []), added].filter((value): value is string => Boolean(value));
  const unique = [...new Set(all)];
  return unique.length ? unique : undefined;
}

/** 展示用：全部报销单号（主单+拆单）。 */
export function lineBillNos(line: Pick<ExpenseLine, "treasuryBillNo" | "treasuryBillNos">): string[] {
  const all = [line.treasuryBillNo, ...(line.treasuryBillNos ?? [])].filter((value): value is string => Boolean(value));
  return [...new Set(all)];
}

export function treasuryDetail(line: ExpenseLine) {
  const savedBills = lineTreasuryBills(line);
  const byNo = new Map(savedBills.map((bill) => [bill.billNo, bill]));
  const bills = [...new Set([...lineBillNos(line), ...byNo.keys()])].map((billNo): TreasuryBillRecord => byNo.get(billNo) ?? { billNo });
  const events: Array<{ label: string; date?: string; billNo?: string; elabBillNo?: string }> = [];
  for (const bill of line.elabBills ?? []) {
    if (bill.submittedAt) events.push({ label: "前置报账递交", date: bill.submittedAt, elabBillNo: bill.billNo });
    if (bill.approvedAt) events.push({ label: "前置报账审核通过", date: bill.approvedAt, elabBillNo: bill.billNo });
  }
  if (line.submittedAt) events.push({ label: "票据簿登记递交", date: line.submittedAt });
  for (const bill of bills) {
    if (bill.appliedAt) events.push({ label: "财务系统登记申请", date: bill.appliedAt, billNo: bill.billNo });
    if (bill.postedAt) events.push({ label: "财务入账", date: bill.postedAt, billNo: bill.billNo });
  }
  if (line.lastArchiveRestore?.archivedAt) {
    events.push({ label: "上一次归档", date: line.lastArchiveRestore.archivedAt });
  }
  if (line.lastArchiveRestore) {
    events.push({ label: "票据簿还原归档", date: line.lastArchiveRestore.restoredAt });
  }
  events.sort((first, second) => (first.date ?? "").localeCompare(second.date ?? ""));
  if (line.status === "archived") events.push({ label: "票据簿归档", date: line.archivedAt });
  return { bills, events };
}

/** 吸收模型中的最新财务快照，任一拆单的变化都能更新票据卡。 */
export function mergeTreasurySnapshot(line: ExpenseLine, snapshot: ExpenseLine, folder: string): ExpenseLine {
  const next = {
    ...line,
    status: snapshot.status ?? line.status,
    title: snapshot.title ?? line.title,
    submittedAt: line.treasuryBillNo ? line.submittedAt ?? snapshot.submittedAt : snapshot.submittedAt ?? line.submittedAt,
    archivedAt: snapshot.status === "archived" ? snapshot.archivedAt ?? line.archivedAt : undefined,
    lastArchiveRestore: snapshot.lastArchiveRestore ?? line.lastArchiveRestore,
    folder,
    treasuryBillNo: snapshot.treasuryBillNo ?? line.treasuryBillNo,
    treasuryBillNos: snapshot.treasuryBillNos ?? line.treasuryBillNos,
    treasuryBills: snapshot.treasuryBills ?? line.treasuryBills,
    treasuryStatus: snapshot.treasuryStatus,
    treasuryStatusAt: snapshot.treasuryStatusAt,
    treasuryVoucherNo: snapshot.treasuryVoucherNo,
    treasuryPostedAt: snapshot.treasuryPostedAt,
    treasuryAmountCny: snapshot.treasuryAmountCny ?? line.treasuryAmountCny,
  };
  const previousBills = line.treasuryBills ?? [];
  const nextBills = next.treasuryBills ?? [];
  const previousByNo = new Map(previousBills.map((bill) => [bill.billNo, bill]));
  const billFields = ["status", "appliedAt", "postedAt", "voucherNo", "amountCny", "system", "view", "projectCode"] as const;
  const sameBills = previousBills.length === nextBills.length && nextBills.every((bill) => {
    const previous = previousByNo.get(bill.billNo);
    return previous && billFields.every((key) => previous[key] === bill[key]);
  });
  const fields = ["status", "title", "submittedAt", "archivedAt", "folder", "treasuryBillNo", "treasuryStatus", "treasuryStatusAt", "treasuryVoucherNo", "treasuryPostedAt", "treasuryAmountCny"] as const;
  const sameNumbers = JSON.stringify(lineBillNos(line)) === JSON.stringify(lineBillNos(next));
  const sameRestore = line.lastArchiveRestore?.restoredAt === next.lastArchiveRestore?.restoredAt
    && line.lastArchiveRestore?.archivedAt === next.lastArchiveRestore?.archivedAt;
  return sameBills && sameNumbers && sameRestore && fields.every((key) => line[key] === next[key]) ? line : next;
}

export async function refreshTreasuryStatus(pullModelState: () => Promise<boolean>, request: typeof fetch = fetch) {
  const response = await request("/api/treasury-poll", { method: "POST" }).catch(() => {
    throw new Error("财务查询失败，请稍后重试");
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "财务查询失败，请稍后重试");
  }
  const { changedBills } = await response.json() as { changedBills: number };
  if (!await pullModelState().catch(() => false)) throw new Error("财务查询已完成，但页面同步失败，请重试");
  return changedBills ? `已同步 ${changedBills} 张报销单` : "已查询，状态无变化";
}

/** 人工标注：系统内未找到报销单（他人代报或尚未提交）。 */
export const TREASURY_UNMATCHED = "未匹配报销单（他人代报或未提交，待确认）";

/** 所有关联报销单均须有财务入账日期。历史主单可使用票据集上的入账记录。 */
export function allTreasuryBillsPosted(line: Pick<ExpenseLine, "treasuryPostedAt" | "treasuryStatus" | "treasuryBillNo" | "treasuryBillNos" | "treasuryBills">): boolean {
  const billsByNo = new Map(line.treasuryBills?.map((bill) => [bill.billNo, bill]));
  const billNos = [...new Set([...lineBillNos(line), ...billsByNo.keys()])];
  return billNos.length > 0 && billNos.every((no) => {
    const bill = billsByNo.get(no);
    const isMain = no === line.treasuryBillNo;
    const status = bill?.status || (isMain ? line.treasuryStatus : undefined);
    if (status?.includes("退回")) return false;
    return Boolean(bill?.postedAt || (isMain && line.treasuryPostedAt));
  });
}

export function canArchivePostedLine(line: ExpenseLine) {
  return line.status === "submitted" && allTreasuryBillsPosted(line);
}

export function restoreArchiveDestination(line: ExpenseLine) {
  return lineBillNos(line).length || line.treasuryBills?.length ? "submitted" : "active";
}

export function isArchiveLocked(line: ExpenseLine) {
  return Boolean(line.treasuryVoucherNo) || allTreasuryBillsPosted(line);
}

/** 通用词不作为匹配依据（“差旅/报销”等出现在大多数备注里）。 */
const GENERIC_GRAMS = new Set(["差旅", "报销", "日常", "业务", "会议", "交通", "住宿", "机票", "高铁"]);

/** 票据集备注/标题与报销单备注的匹配：先整串双向包含，再按分隔词，最后滑窗子串（中文备注无分隔符，排除通用词）。 */
export function billMatchesLine(lineTitle: string, billRemark: string): boolean {
  if (!lineTitle || !billRemark) return false;
  if (lineTitle.includes(billRemark) || billRemark.includes(lineTitle)) return true;
  const words = billRemark.split(/[\s ·,，、;；/]+/).filter((word) => word.length >= 2);
  if (words.some((word) => !GENERIC_GRAMS.has(word) && lineTitle.includes(word))) return true;
  // 中文无分隔：报销单备注的 2~4 字滑窗（城市/事项名）命中标题即匹配
  for (let size = 2; size <= 4; size += 1) {
    for (let i = 0; i + size <= billRemark.length; i += 1) {
      const gram = billRemark.slice(i, i + size);
      if (!GENERIC_GRAMS.has(gram) && /[\u4e00-\u9fa5]{2}/.test(gram) && lineTitle.includes(gram)) return true;
    }
  }
  return false;
}
