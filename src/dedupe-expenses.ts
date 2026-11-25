/** 零依赖的"同一笔支出多凭证归并"工具：被 formal-model 与 vite.config 共用。 */

export type DedupeExpenseLike = {
  id: string;
  setId?: string;
  typeId?: string;
  amount?: number;
  currency: string;
  merchant?: string;
  occurredAt?: string;
  amountCny?: number;
  exchangeRate?: { source?: "base" | "reference" | "manual" | "online" };
};

/** 判定两笔费用是否为同一笔支出的重复凭证：同币种、原币金额近似（±0.5%）、商户归一化后可互含、日期相近（≤14 天，收据开具常晚于支付）。 */
export function samePaymentEvent(a: DedupeExpenseLike, b: DedupeExpenseLike): boolean {
  if (!a.amount || !b.amount || a.currency !== b.currency) return false;
  if (Math.abs(a.amount - b.amount) > 0.005 * Math.max(a.amount, 1)) return false;
  const normalizeMerchant = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
  const merchantA = normalizeMerchant(a.merchant ?? "");
  const merchantB = normalizeMerchant(b.merchant ?? "");
  if (merchantA && merchantB && !merchantA.includes(merchantB) && !merchantB.includes(merchantA)) return false;
  if (!a.occurredAt || !b.occurredAt) return true;
  const timeA = Date.parse(a.occurredAt);
  const timeB = Date.parse(b.occurredAt);
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) return true;
  return Math.abs(timeA - timeB) <= 14 * 86_400_000;
}

const expenseCanonicalScore = <T extends DedupeExpenseLike>(expense: T): number => {
  // 实付人民币最可信；其次在线汇率；参考/基准汇率最弱。金额精度高者优先。
  let score = 0;
  if (expense.currency === "CNY") score += 8;
  score += { online: 4, manual: 3, base: 2, reference: 0 }[expense.exchangeRate?.source ?? "reference"] ?? 0;
  if ((expense.amountCny ?? 0) % 1 !== 0) score += 1;
  return score;
};

/** 同一笔支出的多份凭证（发票+收据+截图等）只计一次：返回去重后的主行与被排除的重复行。同集内按并查集聚类。 */
export function dedupeExpenses<T extends DedupeExpenseLike>(expenses: T[]): { kept: T[]; duplicates: T[] } {
  const parent = expenses.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  for (let i = 0; i < expenses.length; i += 1)
    for (let j = i + 1; j < expenses.length; j += 1) {
      if (!samePaymentEvent(expenses[i], expenses[j])) continue;
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[Math.max(rootI, rootJ)] = Math.min(rootI, rootJ);
    }
  const groups = new Map<number, T[]>();
  expenses.forEach((expense, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), expense]);
  });
  const kept: T[] = [];
  const duplicates: T[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => expenseCanonicalScore(b) - expenseCanonicalScore(a) || a.id.localeCompare(b.id));
    kept.push(sorted[0]);
    duplicates.push(...sorted.slice(1));
  }
  return { kept, duplicates };
}

/** 去重后的人民币合计（递交面板"材料合计"口径）。 */
export function dedupedAmountCny<T extends DedupeExpenseLike>(expenses: T[]): number {
  return dedupeExpenses(expenses).kept.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0);
}
