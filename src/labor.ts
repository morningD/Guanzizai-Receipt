/**
 * 实验室劳务费发放核心 —— 数据模型与月度生成日计算。
 * 每月 1 号（遇周六日顺延到下一个周一）生成当月发放表（xlsx 到 ~/Downloads），
 * 用户微信发给财务后在弹窗中勾选「确认已发」，dock 状态灯随之变绿。
 */

export type LaborMember = {
  id: string;
  /** 姓名 */
  name: string;
  /** 硕 / 博 */
  degree: string;
  /** 学号（存字符串防前导零丢失，写入表格时转数字） */
  studentId: string;
  /** 工作内容 */
  workContent: string;
  /** 津贴金额（元/月） */
  amount: number;
  /** 备注（可选） */
  note?: string;
};

export type LaborMonthRecord = {
  /** 生成时间（ISO）；存在 = 当月表格已生成 */
  generatedAt?: string;
  /** 确认已发时间（ISO）；dock 状态灯据此显示 */
  confirmedAt?: string;
  /** 生成时的名单快照（历史可追溯） */
  rows: Array<{ name: string; degree: string; studentId: string; amount: number }>;
};

export type LaborSettings = {
  enabled: boolean;
  /** 导师/负责人姓名（取自活动用户档案 chineseName） */
  ownerName: string;
};

export type LaborData = {
  settings: LaborSettings;
  members: LaborMember[];
  /** "2026-09" → 发放记录 */
  months: Record<string, LaborMonthRecord>;
};

/** "YYYY-MM" → [year, month]；非法返回 null。 */
export function parseLaborMonthKey(key: string): [number, number] | null {
  const match = /^(\d{4})-(\d{1,2})$/.exec(key.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return [year, month];
}

export function laborMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 当月发放表的应生成日：1 号遇周六/日顺延到下一个周一。 */
export function laborGenerationDate(year: number, month: number): Date {
  const date = new Date(year, month - 1, 1);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  return date;
}

/** 是否已到当月生成日（自动生成判定，date 部分比较忽略时刻）。 */
export function isLaborGenerationDue(year: number, month: number, now = new Date()): boolean {
  const due = laborGenerationDate(year, month);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return today >= due;
}

/** 名单 → 表格行快照（生成时落盘）。 */
export function laborRowsFromMembers(members: LaborMember[]): LaborMonthRecord["rows"] {
  return members
    .filter((member) => member.name.trim())
    .map((member) => ({
      name: member.name.trim(),
      degree: member.degree.trim(),
      studentId: member.studentId.trim(),
      amount: Number.isFinite(member.amount) ? member.amount : 0,
    }));
}

export function laborTotal(rows: Array<{ amount: number }>): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.amount) ? row.amount : 0), 0);
}

export function newLaborMember(): LaborMember {
  return {
    id: `labor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    degree: "硕",
    studentId: "",
    workContent: "参与研究课题调研",
    amount: 600,
    note: "参与研究课题工作",
  };
}
