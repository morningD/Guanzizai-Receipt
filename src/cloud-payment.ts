import { withinAmountTier } from "./amount-matching";
const PAYMENT_NODES = new Set(["chatgpt-payment", "cloud-payment", "zhipu-payment"]);
const PRIMARY_NODES = new Set(["chatgpt-receipt", "cloud-invoice", "zhipu-invoice"]);

export function cloudPaymentNodeKind(nodeId: string) {
  if (PAYMENT_NODES.has(nodeId)) return "payment";
  if (PRIMARY_NODES.has(nodeId)) return "primary";
}

export function validPaymentDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
}

export function readCloudPaymentDate(text: string, paymentRecord = false, modelDate?: string) {
  const normalized = text.normalize("NFKC");
  if (/退款成功|已退款|未支付|支付失败|交易关闭|\brefunded\b|payment failed/i.test(normalized)) return { blocked: true };
  const dates = [...normalized.matchAll(/(?:实付时间|扣款(?:日期|时间)|付款(?:日期|时间)|支付(?:日期|时间)|Date paid|Payment date)\s*:?\s*(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})(?!\d)/gi)]
    .map((match) => validPaymentDate(`${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`))
    .filter((date): date is string => Boolean(date));
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const englishDates = paymentRecord && /eReceipt|amount paid|transaction (?:successful|was completed)/i.test(normalized)
    ? /(?:Date paid|Payment date|paid on|\bDate:)\s*:?\s*([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/gi
    : /(?:Date paid|Payment date|paid on)\s*:?\s*([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/gi;
  for (const [, month, day, year] of normalized.matchAll(englishDates)) {
    const number = months.indexOf(month.slice(0, 3).toLowerCase()) + 1;
    const date = validPaymentDate(`${year}-${String(number).padStart(2, "0")}-${day.padStart(2, "0")}`);
    if (date) dates.push(date);
  }
  const unique = [...new Set(dates)];
  return unique.length > 1 ? { blocked: true } : { blocked: false, date: unique[0] ?? validPaymentDate(modelDate) };
}

export function closestCloudPaymentDate(dates: readonly string[], documentDate?: string) {
  const day = validPaymentDate(documentDate);
  const candidates = [...new Set(dates.map(validPaymentDate).filter((date): date is string => Boolean(date)))];
  if (candidates.length === 1) return candidates[0];
  if (!day || !candidates.length) return;
  const distances = candidates.map((date) => ({ date, distance: Math.abs(Date.parse(date) - Date.parse(day)) }))
    .sort((a, b) => a.distance - b.distance);
  return distances[0].distance < distances[1].distance ? distances[0].date : undefined;
}

export type CloudMaterialDate = {
  requirementId: string;
  documentDate?: string;
  paymentDate?: string;
  paymentDateBlocked?: boolean;
  amount?: number | string;
  currency?: string;
};

function amountOf(material: CloudMaterialDate) {
  const amount = Number(typeof material.amount === "string" ? material.amount.replace(/[,\s]/g, "") : material.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function paymentDistance(invoice: CloudMaterialDate, payment: CloudMaterialDate) {
  if (invoice.paymentDateBlocked || payment.paymentDateBlocked) return Infinity;
  const issued = validPaymentDate(invoice.documentDate);
  const paid = validPaymentDate(payment.paymentDate);
  if (!issued || !paid || invoice.requirementId.replace(/-(invoice|receipt)$/, "-payment") !== payment.requirementId) return Infinity;
  if (invoice.currency && payment.currency && invoice.currency !== payment.currency) return Infinity;
  const days = Math.abs(Date.parse(issued) - Date.parse(paid)) / 86_400_000;
  const invoicedAmount = amountOf(invoice);
  const paidAmount = amountOf(payment);
  if (!invoicedAmount || !paidAmount || !invoice.currency || !payment.currency) return days === 0 ? 0 : Infinity;
  if (days > 7 || !withinAmountTier(paidAmount, invoicedAmount, invoice.currency, "precision")
    && !withinAmountTier(paidAmount, invoicedAmount, invoice.currency, "nearby")
    && !withinAmountTier(paidAmount, invoicedAmount, invoice.currency, "corroborated")) return Infinity;
  return days;
}

export function cloudPaymentDateForImport(material: CloudMaterialDate, candidates: readonly CloudMaterialDate[], competingInvoices: readonly CloudMaterialDate[] = candidates) {
  const kind = cloudPaymentNodeKind(material.requirementId);
  if (!kind || material.paymentDateBlocked) return;
  const explicit = validPaymentDate(material.paymentDate);
  if (explicit || kind !== "primary") return explicit;
  const possible = candidates.filter((payment) => Number.isFinite(paymentDistance(material, payment)));
  const date = closestCloudPaymentDate(possible.flatMap((payment) => payment.paymentDate ?? []), material.documentDate);
  if (!date) return;
  return possible.some((payment) => payment.paymentDate === date && !competingInvoices.some((other) => {
    if (other === material || cloudPaymentNodeKind(other.requirementId) !== "primary") return false;
    if (other.paymentDate && other.paymentDate !== date) return false;
    const distance = paymentDistance(other, payment);
    return Number.isFinite(distance) && (other.paymentDate === date || distance <= paymentDistance(material, payment));
  })) ? date : undefined;
}
