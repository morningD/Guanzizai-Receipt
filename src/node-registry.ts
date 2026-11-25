/**
 * 材料节点注册表：节点知识的唯一事实来源。
 *
 * 新增/修改节点 = 在 NODES 改一处 + 对应 WORKFLOWS 的 version+1；
 * requirements/groups、classifyEvidenceType、支付配对、AI prompt 候选等全部由此派生，
 * 票据集快照由 upgradeLineRequirements 按 version 自动对齐——不再手工同步多处。
 */
import type { ExpenseLine, Requirement, RequirementGroup } from "./types";

/** 节点定义：展示字段（Requirement 兼容）+ 供各子系统派生的元数据。 */
export type NodeDef = {
  id: string;
  label: string;
  hint: string;
  keywords: string[];
  optional?: boolean;
  templateId?: Requirement["templateId"];
  paymentProofKeywords?: string[];
  /** 证据类型查表（formal-model classifyEvidenceType 派生源）。 */
  evidenceType?: "invoice" | "receipt" | "transport-ticket" | "payment-proof" | "hotel-folio" | "itinerary" | "fee-schedule" | "invitation" | "agenda" | "explanation" | "purchase-order" | "other";
  /** 支付配对族（formal-model attachWorkflowPaymentEvidence 派生源）。 */
  paymentFamily?: "transport" | "hotel" | "registration" | "membership";
};

export const NODES: Record<string, NodeDef> = {
  "outbound-transport": { id: "outbound-transport", label: "去程交通凭证", hint: "去程高铁票、机票或相应订单/行程单", keywords: ["去程", "出发", "往返"], evidenceType: "transport-ticket", paymentFamily: "transport" },
  "return-transport": { id: "return-transport", label: "返程交通凭证", hint: "返程高铁票、机票或相应订单/行程单", keywords: ["返程", "返回", "往返"], evidenceType: "transport-ticket", paymentFamily: "transport" },
  "transport-payment": { id: "transport-payment", label: "支付凭证", hint: "可随时补充交通支付截图；金额达到 CNY 1,000 时必需", keywords: ["交通支付", "机票支付", "车票支付", "旅行社&支付"], optional: true, evidenceType: "payment-proof", paymentFamily: "transport" },
  "transport-invoice": { id: "transport-invoice", label: "交通发票", hint: "机票、铁路或代订交通服务的电子发票，与行程单分属不同凭证", keywords: ["交通发票", "机票发票", "铁路电子客票", "代订机票", "退改"], evidenceType: "invoice", paymentFamily: "transport" },
  "hotel-invoice": { id: "hotel-invoice", label: "住宿发票", hint: "酒店住宿发票", keywords: ["住宿发票"], evidenceType: "invoice", paymentFamily: "hotel" },
  "hotel-folio": { id: "hotel-folio", label: "住宿水单", hint: "酒店入住日期与房费明细", keywords: ["住宿水单", "酒店水单"], evidenceType: "hotel-folio", paymentFamily: "hotel" },
  "hotel-payment": { id: "hotel-payment", label: "支付凭证", hint: "可随时补充住宿支付截图；金额达到 CNY 1,000 时必需", keywords: ["住宿支付", "酒店支付", "住宿费支付", "酒店&支付"], optional: true, evidenceType: "payment-proof", paymentFamily: "hotel" },
  "taxi-note": { id: "taxi-note", label: "打车往返说明", hint: "如跨城市打车往返，附必要说明", keywords: ["打车说明", "出租说明", "交通情况说明"], optional: true, templateId: "traffic-explanation", evidenceType: "explanation" },
  "rebooking-note": { id: "rebooking-note", label: "机票改签情况说明", hint: "如发生机票改签，附改签原因与费用说明", keywords: ["改签说明", "改签情况说明", "机票改签"], optional: true, templateId: "rebooking-explanation", evidenceType: "explanation" },
  "intercity-taxi-invoice": { id: "intercity-taxi-invoice", label: "跨城市打车发票", hint: "跨城市打车往返时，提供对应发票", keywords: ["打车发票", "出租车发票", "网约车发票"], optional: true, evidenceType: "invoice" },
  "intercity-taxi-itinerary": { id: "intercity-taxi-itinerary", label: "跨城市打车行程单", hint: "跨城市打车往返时，提供对应行程单", keywords: ["打车行程单", "网约车行程单", "滴滴行程单", "高德行程单"], optional: true, evidenceType: "itinerary" },
  "hosted-stay-invitation": { id: "hosted-stay-invitation", label: "会议方提供住宿的邀请函", hint: "如由会议方提供住宿，附邀请函或住宿安排", keywords: ["邀请函", "住宿安排"], optional: true, evidenceType: "invitation" },
  "conference-notice": { id: "conference-notice", label: "会议通知/日程", hint: "会议通知、日程或邀请函（纯通知类，国内会议报销必需，随报销单差旅附件上传）", keywords: ["会议通知", "大会通知", "第四轮通知", "会议通知第四轮", "日程", "邀请函"], evidenceType: "agenda" },
  "registration-fee": { id: "registration-fee", label: "注册费标准", hint: "注册费价格表或缴费方式说明（含注册金额的页面）", keywords: ["注册费标准", "注册费用及缴费方式", "会议注册、费用及缴费方式", "费用清单"], evidenceType: "fee-schedule" },
  "registration-invoice": { id: "registration-invoice", label: "注册费票据", hint: "会议注册费发票或收据", keywords: ["注册费发票", "会务费发票", "注册费收据", "Registration Receipt"], evidenceType: "invoice", paymentFamily: "registration" },
  "registration-payment": { id: "registration-payment", label: "注册费支付记录", hint: "如有注册费，附支付截图或支付记录", keywords: ["注册费支付记录", "注册费支付截图"], optional: true, evidenceType: "payment-proof", paymentFamily: "registration" },
  "membership-invoice": { id: "membership-invoice", label: "会员费收据", hint: "如为参会新购或续费会员，附会员费收据", keywords: ["CCF会员", "IEEE会员", "ACM会员", "会员费发票", "会员费收据"], optional: true, paymentProofKeywords: ["会员费支付", "会员支付"], evidenceType: "receipt", paymentFamily: "membership" },
  "membership-fee-list": { id: "membership-fee-list", label: "会员费标准清单", hint: "如报销会员费，附会员等级与收费标准", keywords: ["会员费标准", "会员收费标准", "会员费清单"], optional: true, evidenceType: "fee-schedule" },
};

export const GROUP_DEFS: Record<string, { label: string; hint: string; nodeIds: string[] }> = {
  transport: { label: "往返交通", hint: "去程与返程交通；跨城市打车时补充说明、发票与行程单", nodeIds: ["outbound-transport", "return-transport", "transport-invoice", "transport-payment", "taxi-note", "rebooking-note", "intercity-taxi-invoice", "intercity-taxi-itinerary"] },
  hotel: { label: "住宿", hint: "住宿发票、水单与支付凭证", nodeIds: ["hotel-invoice", "hotel-folio", "hotel-payment"] },
  "conference-registration": { label: "会议注册", hint: "注册费与会员费的收费标准、票据与支付记录", nodeIds: ["conference-notice", "registration-fee", "registration-invoice", "registration-payment", "membership-invoice", "membership-fee-list"] },
  "special-arrangements": { label: "特殊安排", hint: "会议方提供住宿等特殊安排的凭证", nodeIds: ["hosted-stay-invitation"] },
};

/** 工作流 = 节点/组的有序引用；version 递增触发存量票据集快照自动对齐。 */
export const WORKFLOWS: Record<"国内会议" | "国内差旅", { version: number; requirements: string[]; groupIds: string[] }> = {
  国内会议: {
    version: 2,
    requirements: ["outbound-transport", "return-transport", "transport-payment", "transport-invoice", "hotel-invoice", "hotel-folio", "hotel-payment", "taxi-note", "rebooking-note", "intercity-taxi-invoice", "intercity-taxi-itinerary", "hosted-stay-invitation", "conference-notice", "registration-fee", "registration-invoice", "registration-payment", "membership-invoice", "membership-fee-list"],
    groupIds: ["transport", "hotel", "conference-registration", "special-arrangements"],
  },
  国内差旅: {
    version: 2,
    requirements: ["outbound-transport", "return-transport", "transport-payment", "transport-invoice", "hotel-invoice", "hotel-folio", "hotel-payment", "taxi-note", "rebooking-note", "intercity-taxi-invoice", "intercity-taxi-itinerary"],
    groupIds: ["transport", "hotel"],
  },
};

const stripToRequirement = (node: NodeDef): Requirement => ({ id: node.id, label: node.label, hint: node.hint, keywords: node.keywords, optional: node.optional, templateId: node.templateId, paymentProofKeywords: node.paymentProofKeywords });

export function nodeDef(id: string): NodeDef | undefined {
  return NODES[id];
}

/** 由注册表派生工作流的材料项（权威覆盖 label/hint/keywords，快照不再各自为政）。 */
export function requirementsFor(workflow: keyof typeof WORKFLOWS): Requirement[] {
  return WORKFLOWS[workflow].requirements.map((id) => NODES[id]).filter(Boolean).map(stripToRequirement);
}

/** 由注册表派生工作流的材料分组。 */
export function groupsFor(workflow: keyof typeof WORKFLOWS): RequirementGroup[] {
  return WORKFLOWS[workflow].groupIds.map((groupId) => {
    const group = GROUP_DEFS[groupId];
    return { id: groupId, label: group.label, hint: group.hint, requirements: group.nodeIds.map((id) => NODES[id]).filter(Boolean).map(stripToRequirement) };
  });
}

/**
 * 快照版本化对齐：line.workflowVersion 落后于注册表 version 时，以注册表为权威重建
 * requirements/groups（label 术语更新与新增节点一次性生效）；已注册工作流之外原样返回。
 */
export function upgradeLineRequirements(line: ExpenseLine): ExpenseLine {
  const workflow = WORKFLOWS[line.kind as keyof typeof WORKFLOWS];
  if (!workflow) return line;
  if (line.workflowVersion === workflow.version) return line;
  return { ...line, requirements: requirementsFor(line.kind as keyof typeof WORKFLOWS), groups: groupsFor(line.kind as keyof typeof WORKFLOWS), workflowVersion: workflow.version };
}
