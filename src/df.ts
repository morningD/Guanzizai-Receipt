/**
 * DF（党费）月度计算核心 —— 自原独立脚本 calculate_df.py 移植进观自在系统（2026-09，原目录已删除）。
 * 月度计算方式：适用于新入职教工，按当月工资单逐月独立计算。
 */

/** 计入 DF 的工资字段（月收入合计的组成项） */
export const DF_INCOME_FIELDS = ["岗位工资", "薪级工资", "初见期工资", "年薪津贴", "上海市岗位津贴", "岗位津贴", "基本津贴"] as const;

/** 扣除部分字段（CSV/工资单中为个人+单位合计口径的，计算内部再折半） */
export const DF_DEDUCTION_FIELDS = ["基本公积金", "补充公积金", "职业年金", "养老金", "失业保险", "医疗保险"] as const;

/** 7 级超额累进税率表：[年度应纳税所得额上限, 税率, 速算扣除数] */
const TAX_BRACKETS: ReadonlyArray<readonly [number, number, number]> = [
  [36_000, 0.03, 0],
  [144_000, 0.1, 2_520],
  [300_000, 0.2, 16_920],
  [420_000, 0.25, 31_920],
  [660_000, 0.3, 52_920],
  [960_000, 0.35, 85_920],
  [Number.POSITIVE_INFINITY, 0.45, 181_920],
];

/** DF 缴纳比例：月 DF 基数区间上限 → 比例 */
const DF_RATES: ReadonlyArray<readonly [number, number]> = [
  [3_000, 0.005],
  [5_000, 0.01],
  [10_000, 0.015],
  [Number.POSITIVE_INFINITY, 0.02],
];

/** 单月工资数据：字段名 → 金额（扣除项存正数，计算时做减法） */
export type DfMonthValues = Record<string, number>;

export type DfMonthResult = {
  monthlyIncome: number;
  annualTaxable: number;
  annualTax: number;
  monthlyTax: number;
  dfBase: number;
  rate: number;
  /** 月应交 DF（整数元，向零截断，对齐原 Python int()） */
  dfAmount: number;
};

export function calcIncomeTax(taxableIncome: number): number {
  if (taxableIncome <= 0) return 0;
  for (const [upper, rate, quickDeduction] of TAX_BRACKETS) {
    if (taxableIncome <= upper) return taxableIncome * rate - quickDeduction;
  }
  return 0;
}

export function dfRate(base: number): number {
  for (const [upper, rate] of DF_RATES) if (base <= upper) return rate;
  return 0.02;
}

/** 月专项附加扣除默认 1500（上海住房租金标准），可在弹窗中调整。 */
export const DF_DEFAULT_SPECIAL_DEDUCTION = 1500;

export function calculateDfMonth(values: DfMonthValues, monthlySpecialDeduction = DF_DEFAULT_SPECIAL_DEDUCTION): DfMonthResult {
  const field = (name: string) => (Number.isFinite(values[name]) ? values[name] : 0);
  const monthlyIncome = DF_INCOME_FIELDS.reduce((sum, name) => sum + field(name), 0);

  const annualSpecial = monthlySpecialDeduction * 12;
  const annualTaxable = monthlyIncome * 12 - 60_000 - annualSpecial;
  const annualTax = calcIncomeTax(annualTaxable);
  const monthlyTax = annualTax / 12;

  // 公积金（基本/补充）只扣一半：工资单口径是个人+单位合计
  const dfBase = monthlyIncome
    - field("基本公积金") / 2
    - field("补充公积金") / 2
    - field("职业年金")
    - field("养老金")
    - field("失业保险")
    - field("医疗保险")
    - monthlyTax;

  const rate = dfRate(dfBase);
  const dfAmount = Math.trunc(dfBase * rate);
  return { monthlyIncome, annualTaxable, annualTax, monthlyTax, dfBase, rate, dfAmount };
}

/** 单年工资数据：月份(1-12) → 工资字段。存 data/df/salary-YYYY.json。 */
export type DfYearSalary = { year: number; months: Record<number, DfMonthValues>; updatedAt?: string };

export type DfSettings = {
  enabled: boolean;
  monthlySpecialDeduction: number;
  /** 已确认交费的季度："2026-Q3" → 确认时间（ISO）。 */
  confirmedQuarters?: Record<string, string>;
};

/** "YYYY-MM" → [year, month]；非法返回 null。 */
export function parseMonthKey(key: string): [number, number] | null {
  const match = /^(\d{4})-(\d{1,2})$/.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return [year, month];
}

export function quarterOf(month: number): 1 | 2 | 3 | 4 {
  return (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

export function currentQuarterKey(now = new Date()): 1 | 2 | 3 | 4 {
  return quarterOf(now.getMonth() + 1);
}

/** 某季度内的月份列表（1-12）。 */
export function quarterMonths(quarter: 1 | 2 | 3 | 4): number[] {
  return [1, 2, 3].map((offset) => (quarter - 1) * 3 + offset);
}

/** "YYYY-MM" 列表按时间升序去重。 */
export function sortMonthKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

/** 月份是否晚于当前月（未来发薪月：工资单尚不存在，禁止抓取与计算）。 */
export function isFutureMonth(year: number, month: number, now = new Date()): boolean {
  return `${year}-${String(month).padStart(2, "0")}` > `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-Q3" 形式的季度 key。 */
export function quarterKeyOf(year: number, quarter: 1 | 2 | 3 | 4): string {
  return `${year}-Q${quarter}`;
}

/** "2026-Q3" → [2026, 3]；非法返回 null。 */
export function quarterOfKey(key: string): [number, 1 | 2 | 3 | 4] | null {
  const match = /^(\d{4})-Q([1-4])$/.exec(key.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]) as 1 | 2 | 3 | 4];
}

/** 季度交费确认的开启日：该季度最后一个月的 7 号（当季缴款落定后确认）。 */
export function quarterConfirmationOpensOn(year: number, quarter: 1 | 2 | 3 | 4): Date {
  const lastMonth = quarterMonths(quarter)[2];
  return new Date(year, lastMonth - 1, 7, 0, 0, 0);
}

/** 该季度交费确认是否已开启（过去/已到开启日的季度为 true，未来季度 false）。 */
export function isQuarterConfirmationOpen(year: number, quarter: 1 | 2 | 3 | 4, now = new Date()): boolean {
  const opens = quarterConfirmationOpensOn(year, quarter);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return today >= opens;
}
