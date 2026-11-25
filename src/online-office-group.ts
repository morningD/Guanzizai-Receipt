import type { ReceiptRecord, RequirementGroup } from "./types";

function matchesRequirement(record: ReceiptRecord, requirementId: string, keywords: string[]) {
  if (record.classifiedRequirementId === requirementId) return true;
  const value = `${record.name} ${record.path}`.toLowerCase();
  return keywords.some((keyword) => value.includes(keyword.toLowerCase()));
}

/** 兼容旧版材料卡的低额网购激活逻辑；正式金额边界由形式化 Expense 规则计算。 */
export function activateOnlineOfficePurchaseSet(group: RequirementGroup, records: ReceiptRecord[]) {
  if (group.id !== "online-office-supplies") return group;
  const triggered = group.requirements.some((requirement) => records.some((record) => matchesRequirement(record, requirement.id, requirement.keywords)));
  return triggered ? { ...group, optional: false } : group;
}
