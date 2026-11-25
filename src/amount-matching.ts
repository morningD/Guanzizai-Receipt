export const AMOUNT_MATCH_LIMITS = {
  precisionMinorUnits: 1,
  nearbyCnyCents: 100,
  merchantDiscountPercent: 5,
  merchantDiscountCnyCents: 1000,
  itemizedPercent: 10,
} as const;

export type AmountMatchTier = "precision" | "nearby" | "corroborated" | "itemized";

export function amountInMinorUnits(amount: number, currency: string) {
  return Math.round(amount * (currency === "JPY" ? 1 : 100));
}

/** 跨币种时先用交易证据定位，按换算后的金额校验百分比。 */
export function withinRelativeAmountTier(actual: number, expected: number, tier: "corroborated" | "itemized") {
  actual = Number(actual);
  expected = Number(expected);
  const percent = tier === "corroborated" ? AMOUNT_MATCH_LIMITS.merchantDiscountPercent : AMOUNT_MATCH_LIMITS.itemizedPercent;
  return Number.isFinite(actual) && Number.isFinite(expected) && actual > 0 && expected > 0
    && Math.abs(Math.round(actual * 100) - Math.round(expected * 100)) * 100 <= Math.round(expected * 100) * percent;
}

/** 金额按最小单位比较。调用方先校验同币种、交易证据和候选唯一性。 */
export function withinAmountTier(actual: number, expected: number, currency: string, tier: AmountMatchTier) {
  actual = Number(actual);
  expected = Number(expected);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || actual <= 0 || expected <= 0) return false;
  const units = amountInMinorUnits(expected, currency);
  const difference = Math.abs(amountInMinorUnits(actual, currency) - units);
  const { precisionMinorUnits, nearbyCnyCents, merchantDiscountPercent, merchantDiscountCnyCents, itemizedPercent } = AMOUNT_MATCH_LIMITS;
  if (tier === "precision") return difference <= precisionMinorUnits;
  if (tier === "itemized") return difference * 100 <= units * itemizedPercent;
  if (currency !== "CNY") return false;
  if (tier === "nearby") return difference <= nearbyCnyCents;
  return difference <= Math.min(merchantDiscountCnyCents, Math.round(units * merchantDiscountPercent / 100));
}
