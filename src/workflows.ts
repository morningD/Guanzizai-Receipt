import {
  DAILY_REQUIREMENT_GROUPS,
  DOMESTIC_CONFERENCE_GROUPS,
  DOMESTIC_TRIP_GROUPS,
  ICME_REQUIREMENT_GROUPS,
  INTERNATIONAL_ATTACHMENTS,
} from "./data";
import { PAYMENT_PROOF_THRESHOLD_CNY } from "./reimbursement-policy";
import type { EvidenceTypeId, ExpenseTypeId } from "./expense-taxonomy";
import type { ExpenseLine, Requirement, RequirementGroup, WorkflowDefinition, WorkflowEdge, WorkflowNode } from "./types";

const paymentLinks: Array<[string, string]> = [
  ["registration", "registration-payment"], ["registration-invoice", "registration-payment"], ["membership-invoice", "membership-payment"],
  ["airfare-invoice", "airfare-payment"], ["hotel", "hotel-payment"],
  ["hotel-invoice", "hotel-payment"], ["transport-payment", "transport-payment"],
  ["transport-invoice", "transport-payment"],
];

type NodeBinding = { evidenceTypes: EvidenceTypeId[]; expenseTypes?: ExpenseTypeId[]; ruleIds?: string[] };
export const NODE_BINDINGS: Record<string, NodeBinding> = {
  // 前置报账单（报账单本身非消费凭证，expenseTypes 仅用于递交面板把报账单归入对应财务流程组）
  "low-value-gear-elab": { evidenceTypes: ["other"], expenseTypes: ["low-value-gear"] },
  "cloud-services-csf": { evidenceTypes: ["other"], expenseTypes: ["cloud-service"] },
  registration: { evidenceTypes: ["invoice", "receipt"], expenseTypes: ["conference-registration"], ruleIds: ["global-payment-proof-threshold", "global-registration-fee-schedule"] },
  "registration-invoice": { evidenceTypes: ["invoice", "receipt"], expenseTypes: ["conference-registration"], ruleIds: ["global-payment-proof-threshold", "global-registration-fee-schedule"] },
  "registration-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["conference-registration"], ruleIds: ["global-payment-proof-threshold"] },
  "registration-fee-list": { evidenceTypes: ["fee-schedule"], expenseTypes: ["conference-registration"], ruleIds: ["global-registration-fee-schedule"] },
  "membership-invoice": { evidenceTypes: ["receipt"], expenseTypes: ["membership-fee"], ruleIds: ["global-payment-proof-threshold", "global-membership-fee-schedule"] },
  "membership-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["membership-fee"], ruleIds: ["global-payment-proof-threshold"] },
  "membership-fee-list": { evidenceTypes: ["fee-schedule"], expenseTypes: ["membership-fee"], ruleIds: ["global-membership-fee-schedule"] },
  "outbound-transport": { evidenceTypes: ["transport-ticket", "itinerary"], expenseTypes: ["air-transport", "rail-transport"] },
  "return-transport": { evidenceTypes: ["transport-ticket", "itinerary"], expenseTypes: ["air-transport", "rail-transport"] },
  "airfare-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["air-transport"], ruleIds: ["global-payment-proof-threshold"] },
  "airfare-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["air-transport"], ruleIds: ["global-payment-proof-threshold"] },
  hotel: { evidenceTypes: ["invoice"], expenseTypes: ["lodging"], ruleIds: ["global-payment-proof-threshold", "global-lodging-hotel-folio"] },
  "hotel-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["lodging"], ruleIds: ["global-payment-proof-threshold", "global-lodging-hotel-folio"] },
  "hotel-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["lodging"], ruleIds: ["global-payment-proof-threshold"] },
  folio: { evidenceTypes: ["hotel-folio"], expenseTypes: ["lodging"], ruleIds: ["global-lodging-hotel-folio"] },
  "hotel-folio": { evidenceTypes: ["hotel-folio"], expenseTypes: ["lodging"], ruleIds: ["global-lodging-hotel-folio"] },
  "transport-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["air-transport", "rail-transport"], ruleIds: ["global-payment-proof-threshold"] },
  "transport-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["air-transport", "rail-transport"], ruleIds: ["global-payment-proof-threshold"] },
  "intercity-taxi-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["intercity-ride-hailing"], ruleIds: ["global-ride-hailing-itinerary"] },
  "intercity-taxi-itinerary": { evidenceTypes: ["itinerary"], expenseTypes: ["intercity-ride-hailing"], ruleIds: ["global-ride-hailing-itinerary"] },
  "taxi-note": { evidenceTypes: ["explanation"], expenseTypes: ["intercity-ride-hailing"] },
  "ride-hailing-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["local-ride-hailing"], ruleIds: ["global-ride-hailing-itinerary"] },
  "ride-hailing-itinerary": { evidenceTypes: ["itinerary"], expenseTypes: ["local-ride-hailing"], ruleIds: ["global-ride-hailing-itinerary"] },
  "chatgpt-receipt": { evidenceTypes: ["receipt"], expenseTypes: ["ai-subscription"], ruleIds: ["global-cloud-service-payment-record"] },
  "chatgpt-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["ai-subscription"], ruleIds: ["global-cloud-service-payment-record"] },
  "chatgpt-fee-schedule": { evidenceTypes: ["fee-schedule"], expenseTypes: ["ai-subscription"], ruleIds: ["global-cloud-service-payment-record"] },
  "cloud-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["cloud-service"], ruleIds: ["global-cloud-service-payment-record"] },
  "cloud-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["cloud-service"], ruleIds: ["global-cloud-service-payment-record"] },
  "cloud-fee-schedule": { evidenceTypes: ["fee-schedule"], expenseTypes: ["cloud-service"], ruleIds: ["global-cloud-service-payment-record"] },
  "zhipu-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["cloud-service"], ruleIds: ["global-cloud-service-payment-record"] },
  "zhipu-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["cloud-service"], ruleIds: ["global-cloud-service-payment-record"] },
  "zhipu-fee-schedule": { evidenceTypes: ["fee-schedule"], expenseTypes: ["cloud-service"], ruleIds: ["global-cloud-service-payment-record"] },
  // 出租车发票已并入网约车口径：票面写「出租车」的平台代开发票一律按网约车处理；纸质出租车发票走线下财务，不进系统
  "taxi-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["local-ride-hailing"] },
  approval: { evidenceTypes: ["approval-form"] },
  "approval-notice": { evidenceTypes: ["approval-form"] },
  return: { evidenceTypes: ["closure-confirmation"] },
  "office-supplies-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["office-supplies"], ruleIds: ["global-low-value-online-purchase-proof"] },
  "office-supplies-proof": { evidenceTypes: ["purchase-order"], expenseTypes: ["office-supplies"], ruleIds: ["global-low-value-online-purchase-proof"] },
  "low-value-gear-invoice": { evidenceTypes: ["invoice"], expenseTypes: ["low-value-gear"], ruleIds: ["global-low-value-online-purchase-proof"] },
  "low-value-gear-proof": { evidenceTypes: ["purchase-order"], expenseTypes: ["low-value-gear"], ruleIds: ["global-low-value-online-purchase-proof"] },
  "low-value-gear-payment": { evidenceTypes: ["payment-proof"], expenseTypes: ["low-value-gear"] },
};

/** 费用类型 → 票据集组 label：按票据集 workflow 的节点绑定反查（归档/递交分组与票据集保持一致）；无绑定的费用无组。 */
export function expenseCollectionLabel(typeId: string, collections: ReadonlyArray<{ label: string; nodeIds: readonly string[] }>): string | undefined {
  for (const collection of collections) {
    if (collection.nodeIds.some((nodeId) => NODE_BINDINGS[nodeId]?.expenseTypes?.includes(typeId as never))) return collection.label;
  }
  return undefined;
}

function nodeFromRequirement(requirement: Requirement, collection: string, scope: WorkflowNode["scope"], attachment = false): WorkflowNode {
  return {
    ...requirement,
    kind: attachment ? "attachment" : "evidence",
    scope,
    collection,
    required: attachment ? "never" : requirement.optional ? "when-active" : "always",
    visibleWhen: ["intercity-taxi-invoice", "intercity-taxi-itinerary"].includes(requirement.id) ? "active" : "always",
    ...(NODE_BINDINGS[requirement.id] ?? { evidenceTypes: [attachment ? "archive-attachment" : "other"] as EvidenceTypeId[] }),
  };
}

function uniqueNodes(groups: RequirementGroup[], attachments: Requirement[] = []) {
  const nodes = new Map<string, WorkflowNode>();
  for (const group of groups) for (const requirement of group.requirements) {
    if (!nodes.has(requirement.id)) nodes.set(requirement.id, nodeFromRequirement(requirement, group.id, "finance"));
  }
  for (const attachment of attachments) nodes.set(attachment.id, nodeFromRequirement(attachment, "project-attachments", "archive", true));
  return [...nodes.values()];
}

function standardEdges(nodes: WorkflowNode[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const edges: WorkflowEdge[] = [];
  for (const [source, target] of paymentLinks) {
    if (source !== target && ids.has(source) && ids.has(target)) edges.push({ id: `${source}-activates-${target}`, source, target, relation: "activates", condition: { kind: "source-at-least-threshold", sourceId: source, thresholdCny: PAYMENT_PROOF_THRESHOLD_CNY } });
  }
  if (ids.has("intercity-taxi-invoice") && ids.has("intercity-taxi-itinerary")) {
    edges.push(
      { id: "taxi-invoice-paired-itinerary", source: "intercity-taxi-invoice", target: "intercity-taxi-itinerary", relation: "paired-with", ruleId: "global-ride-hailing-itinerary", pairing: { strategy: "transaction-first" } },
      { id: "taxi-invoice-activates-note", source: "intercity-taxi-invoice", target: "taxi-note", relation: "activates", ruleId: "global-intercity-ride-hailing-explanation", condition: { kind: "source-complete", sourceIds: ["intercity-taxi-invoice", "intercity-taxi-itinerary"], mode: "any" } },
      { id: "taxi-invoice-activates-itinerary", source: "intercity-taxi-invoice", target: "intercity-taxi-itinerary", relation: "activates", ruleId: "global-ride-hailing-itinerary", condition: { kind: "source-complete", sourceIds: ["intercity-taxi-invoice", "intercity-taxi-itinerary"], mode: "any" } },
    );
  }
  if (ids.has("ride-hailing-invoice") && ids.has("ride-hailing-itinerary")) edges.push({ id: "ride-hailing-pair", source: "ride-hailing-invoice", target: "ride-hailing-itinerary", relation: "paired-with", ruleId: "global-ride-hailing-itinerary", pairing: { strategy: "transaction-first" } });
  if (ids.has("office-supplies-invoice") && ids.has("office-supplies-proof")) edges.push({ id: "office-supplies-pair", source: "office-supplies-invoice", target: "office-supplies-proof", relation: "paired-with", ruleId: "global-low-value-online-purchase-proof", pairing: { strategy: "transaction-first" } });
  if (ids.has("low-value-gear-invoice") && ids.has("low-value-gear-proof")) edges.push({ id: "low-value-gear-pair", source: "low-value-gear-invoice", target: "low-value-gear-proof", relation: "paired-with", ruleId: "global-low-value-online-purchase-proof", pairing: { strategy: "transaction-first" } });
  for (const [source, target] of [["chatgpt-receipt", "chatgpt-payment"], ["cloud-invoice", "cloud-payment"], ["zhipu-invoice", "zhipu-payment"]]) {
    if (ids.has(source) && ids.has(target)) edges.push({ id: `${source}-paired-${target}`, source, target, relation: "paired-with", ruleId: "global-cloud-service-payment-record", pairing: { strategy: "transaction-first" } });
  }
  for (const [source, target] of [["chatgpt-receipt", "chatgpt-fee-schedule"], ["cloud-invoice", "cloud-fee-schedule"], ["zhipu-invoice", "zhipu-fee-schedule"]]) {
    if (ids.has(source) && ids.has(target)) edges.push({ id: `${source}-paired-${target}`, source, target, relation: "paired-with", ruleId: "global-cloud-service-payment-record", pairing: { strategy: "project-first" } });
  }
  return edges;
}

function definition(id: string, kind: ExpenseLine["kind"], groups: RequirementGroup[], attachments: Requirement[] = []): WorkflowDefinition {
  const nodes = uniqueNodes(groups, attachments);
  return {
    id,
    version: 1,
    kind,
    nodes,
    edges: standardEdges(nodes),
    collections: [
      ...groups.map((group) => ({ id: group.id, label: group.label, hint: group.hint, scope: "finance" as const, nodeIds: group.requirements.map((item) => item.id) })),
      ...(attachments.length ? [{ id: "project-attachments", label: "项目附件", hint: "随票据集保存与归档", scope: "archive" as const, nodeIds: attachments.map((item) => item.id) }] : []),
    ],
  };
}

const international = definition("international-conference", "国际会议", ICME_REQUIREMENT_GROUPS, INTERNATIONAL_ATTACHMENTS);
international.nodes.push({ id: "foreign-closure", label: "外事系统：办理结团", hint: "归团总结报告完成后，可在外事系统办理并取得结团确认单", keywords: [], kind: "external-action", scope: "process", collection: "travel-approval", required: "never", completedBy: ["return"] });
international.edges.push(
  { id: "return-summary-input-closure", source: "return-summary", target: "foreign-closure", relation: "input" },
  { id: "closure-produces-return", source: "foreign-closure", target: "return", relation: "produces" },
  { id: "summary-archives-with-case", source: "return-summary", target: "return", relation: "archives-with" },
);

export const WORKFLOW_DEFINITIONS: Record<ExpenseLine["kind"], WorkflowDefinition> = {
  "国际会议": international,
  "国内会议": definition("domestic-conference", "国内会议", DOMESTIC_CONFERENCE_GROUPS),
  "国内差旅": definition("domestic-trip", "国内差旅", DOMESTIC_TRIP_GROUPS),
  "日常": (() => {
    const daily = definition("daily-receipts", "日常", DAILY_REQUIREMENT_GROUPS);
    // 前置单节点（elab 资产入账单/软件服务费报账单）是系统单据状态而非上传文件——
    // 恒显示（visibleWhen "always"），否则无文件时 active=false 被渲染链过滤隐藏
    const PREAPPROVAL_NODES = ["low-value-gear-elab", "cloud-services-csf"];
    // 前置单必须项：required "always" → requiredForSubmission 恒真（否则无文件时 active=false、
    // optional=true，被 requiredInGroup 排除，组进度分母不 +1）
    daily.nodes = daily.nodes.map((node) => PREAPPROVAL_NODES.includes(node.id)
      ? { ...node, required: "always", visibleWhen: "always" }
      : { ...node, required: "when-active", visibleWhen: "active" });
    return daily;
  })(),
};

export function workflowForLine(line: ExpenseLine) {
  const base = WORKFLOW_DEFINITIONS[line.kind];
  const extras = (line.attachments ?? []).filter((attachment) => !base.nodes.some((node) => node.id === attachment.id));
  if (!extras.length) return base;
  const attachmentNodes = extras.map((attachment) => nodeFromRequirement(attachment, "project-attachments", "archive", true));
  const existingCollection = base.collections.find((collection) => collection.id === "project-attachments");
  return {
    ...base,
    nodes: [...base.nodes, ...attachmentNodes],
    collections: existingCollection
      ? base.collections.map((collection) => collection.id === "project-attachments" ? { ...collection, nodeIds: [...collection.nodeIds, ...attachmentNodes.map((node) => node.id)] } : collection)
      : [...base.collections, { id: "project-attachments", label: "项目附件", hint: "随票据集保存与归档", scope: "archive" as const, nodeIds: attachmentNodes.map((node) => node.id) }],
  };
}
