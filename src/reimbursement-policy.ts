import type { ExpenseLine, ReceiptRecord } from "./types";

/** 仅用于判断是否触发支付凭证，不用于最终财务结算。 */
export const PAYMENT_PROOF_THRESHOLD_CNY = 1000;
/** 图书资料单册或单套达到该金额，须经图书馆验收后报销。 */
export const BOOK_LIBRARY_ACCEPTANCE_THRESHOLD_CNY = 500;
/** 图书资料单张或累计发票达到该金额，报销前还须提供采购合同。 */
export const BOOK_CONTRACT_THRESHOLD_CNY = 30000;
/** 单价 <1,000 的低值设备同类批量达到该金额时，视同固定资产（elab 设备申购），不走材料通道。 */
export const LOW_VALUE_FIXED_ASSET_BATCH_CNY = 30000;
/** 财务系统单张报销单的发票+附件总数上限（2026-10-16 页面校验实证）；超限时附件自动合并为 1 份 PDF，发票数+1 仍超限则必须拆单。daily_bx_draft.py 侧同名常量需同步。 */
export const FINANCE_ATTACHMENT_LIMIT = 80;
export const USD_TO_CNY_REFERENCE = 7.2;

export type TrafficLight = "red" | "yellow" | "green";

export function estimateAmountInCny(record: Pick<ReceiptRecord, "amount" | "currency" | "name">) {
  if (record.amount != null) {
    if (record.currency === "CNY") return record.amount;
    if (record.currency === "USD") return record.amount * USD_TO_CNY_REFERENCE;
  }

  const namedAmount = record.name.match(/CNY(\d+(?:\.\d+)?)/i)?.[1];
  return namedAmount ? Number(namedAmount) : 0;
}

export function requiresPaymentProof(record: Pick<ReceiptRecord, "amount" | "currency" | "name">) {
  return estimateAmountInCny(record) >= PAYMENT_PROOF_THRESHOLD_CNY;
}

/** 必填缺件为红灯；按实际发生但尚未确认的材料为黄灯；材料齐全为绿灯。 */
export function trafficLightForGroup({
  complete,
  total,
  optional = false,
}: {
  complete: number;
  total: number;
  optional?: boolean;
}): TrafficLight {
  if (complete >= total) return "green";
  return optional ? "yellow" : "red";
}

/** 将未完成事项置前；同一状态下保持原有流程顺序。 */
export function sortIncompleteFirst<T>(items: readonly T[], isComplete: (item: T) => boolean): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((first, second) => Number(isComplete(first.item)) - Number(isComplete(second.item)) || first.index - second.index)
    .map(({ item }) => item);
}

export function shouldPrioritizeIncomplete(status: ExpenseLine["status"]) {
  return status === "active";
}
