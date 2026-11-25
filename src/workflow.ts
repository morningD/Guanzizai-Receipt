import { PAYMENT_PROOF_THRESHOLD_CNY, estimateAmountInCny } from "./reimbursement-policy";
import { classifiedFileAlsoMatches } from "./classification-rules";
import type {
  ExpenseLine,
  ReceiptRecord,
  ResolvedWorkflow,
  ResolvedWorkflowNode,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowNode,
} from "./types";

/** 关键词匹配；含 "&" 的关键词表示所有子词须同时出现（如 "旅行社&支付" 匹配 "XX旅行社_支付凭证"）。 */
export function keywordMatches(value: string, keyword: string) {
  return keyword.toLowerCase().split("&").map((part) => part.trim()).filter(Boolean).every((part) => value.includes(part));
}

type DatedReceipt = Pick<ReceiptRecord, "invoiceDate" | "name">;

/** 金额相同的候选按材料自身日期消歧，日期仍并列时留待核对。 */
export function chooseReceiptPair<T extends DatedReceipt>(receipt: DatedReceipt, candidates: T[]) {
  if (candidates.length < 2) return candidates[0];
  const dateOf = (record: DatedReceipt) => Date.parse(record.invoiceDate || record.name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "");
  const date = dateOf(receipt);
  if (!Number.isFinite(date)) return undefined;
  const distances = candidates.map((candidate) => Math.abs(dateOf(candidate) - date));
  const nearest = Math.min(...distances.filter(Number.isFinite));
  const closest = candidates.filter((_, index) => distances[index] === nearest);
  return closest.length === 1 ? closest[0] : undefined;
}

function findFiles(records: ReceiptRecord[], node: WorkflowNode) {
  if (node.requiredPaths?.length) {
    return node.requiredPaths.every((path) => records.some((record) => record.path === path))
      ? [node.requiredPaths.flatMap((path) => records.find((record) => record.path === path)).filter((record): record is ReceiptRecord => Boolean(record))[0]].filter(Boolean)
      : [];
  }
  return records.filter((record) => {
    if (node.templateId && record.name.includes("模板")) return false;
    const classified = record.classifiedWorkflowNodeId ?? record.classifiedRequirementId;
    if (classified || record.classifiedRequirementId) {
      // 已被明确归类的文件只归属其目标节点，避免文件名中的商户词误命中其他材料项（如“酒店管理有限公司”误配支付凭证）。
      if (classified === node.id || (node.id === "return" && record.classifiedRequirementId === "return-confirmation")) return true;
      // 例外：铁路电子客票发票一张顶两张（既是交通发票也是乘車凭证），按文件名中的方向词同时点亮去/返程交通凭证。
      if (classifiedFileAlsoMatches(classified ?? "", node.id, record.name)) return true;
      return false;
    }
    const value = record.name.toLowerCase();
    const matches = node.keywords.map((keyword) => keywordMatches(value, keyword));
    return node.matchAll ? matches.every(Boolean) : matches.some(Boolean);
  });
}

function conditionMatches(
  condition: WorkflowCondition | undefined,
  nodes: Map<string, { complete: boolean; file?: ReceiptRecord }>,
) {
  if (!condition || condition.kind === "always") return true;
  if (condition.kind === "source-complete") {
    const matches = condition.sourceIds.map((id) => nodes.get(id)?.complete ?? false);
    return (condition.mode ?? "any") === "all" ? matches.every(Boolean) : matches.some(Boolean);
  }
  const source = nodes.get(condition.sourceId)?.file;
  return Boolean(source && estimateAmountInCny(source) >= condition.thresholdCny);
}

/** 日常网购商品达到采购门槛后离开本系统，不再触发“发票 + 购买截图”的票据闭环。 */
function relationApplies(
  edge: WorkflowDefinition["edges"][number],
  nodes: Map<string, { complete: boolean; file?: ReceiptRecord }>,
) {
  if (edge.ruleId !== "global-low-value-online-purchase-proof") return true;
  const invoice = nodes.get(edge.source)?.file;
  return !invoice || estimateAmountInCny(invoice) < PAYMENT_PROOF_THRESHOLD_CNY;
}

/**
 * 将文件、人工确认和声明式关系收敛为节点状态。此函数不读写浏览器状态，供界面和测试共用。
 */
export function resolveWorkflow(
  definition: WorkflowDefinition,
  line: ExpenseLine,
  records: ReceiptRecord[],
  overrides: Record<string, boolean>,
): ResolvedWorkflow {
  const base = new Map(definition.nodes.map((node) => {
    const overrideKey = `${line.id}:${node.id}`;
    const files = findFiles(records, node);
    const file = files[0];
    const manuallyConfirmed = overrides[overrideKey] === true && !file;
    const complete = overrideKey in overrides ? overrides[overrideKey] : Boolean(file);
    return [node.id, { node, files, file, complete, manuallyConfirmed, active: node.required === "always" || complete }];
  }));

  // 条件可以依赖前一个节点的识别结果；循环至状态稳定。
  for (let pass = 0; pass < definition.nodes.length + 1; pass += 1) {
    let changed = false;
    for (const item of base.values()) {
      const activation = item.node.activation;
      const activatedByNode = Boolean(activation && conditionMatches(activation, base));
      const activatedByEdge = definition.edges.some((edge) => edge.target === item.node.id && edge.relation === "activates" && conditionMatches(edge.condition, base));
      const activatedByPair = definition.edges.some((edge) => edge.relation === "paired-with" && relationApplies(edge, base) && (edge.source === item.node.id || edge.target === item.node.id) && Boolean(base.get(edge.source === item.node.id ? edge.target : edge.source)?.complete));
      const nextActive = item.node.required === "always" || item.complete || activatedByNode || activatedByEdge || activatedByPair;
      if (nextActive !== item.active) { item.active = nextActive; changed = true; }
    }
    if (!changed) break;
  }

  const resolved = {} as Record<string, ResolvedWorkflowNode>;
  for (const item of base.values()) {
    const incoming = definition.edges.filter((edge) => edge.target === item.node.id && edge.relation === "input");
    const blockers = incoming.filter((edge) => !base.get(edge.source)?.complete).map((edge) => edge.source);
    const completedByOutput = item.node.completedBy?.some((id) => base.get(id)?.complete) ?? false;
    let status: ResolvedWorkflowNode["status"];
    if (item.node.kind === "external-action") status = completedByOutput ? "complete" : blockers.length ? "blocked" : "ready";
    else if (item.complete) status = item.manuallyConfirmed ? "manually-confirmed" : "complete";
    else if (item.active && item.node.scope === "finance") status = "missing";
    else status = "inactive";
    resolved[item.node.id] = {
      ...item.node,
      file: item.file,
      files: item.files,
      active: item.active,
      status,
      blockers,
      requiredForSubmission: item.node.scope === "finance" && item.node.kind === "evidence" && (item.node.required === "always" || item.active),
    };
  }

  // 成对材料只有两侧均完成才形成闭环；已上传的一侧保留为“受阻”，而不是伪装成完成。
  for (const edge of definition.edges.filter((item) => item.relation === "paired-with" && relationApplies(item, base))) {
    const source = resolved[edge.source];
    const target = resolved[edge.target];
    if (!source || !target || (!source.active && !target.active)) continue;
    if ((source.status === "complete" || source.status === "manually-confirmed") && !(target.status === "complete" || target.status === "manually-confirmed")) {
      source.status = "blocked";
      source.blockers = [...source.blockers, target.id];
    }
    if ((target.status === "complete" || target.status === "manually-confirmed") && !(source.status === "complete" || source.status === "manually-confirmed")) {
      target.status = "blocked";
      target.blockers = [...target.blockers, source.id];
    }
  }

  const submissionReady = Object.values(resolved)
    .filter((node) => node.requiredForSubmission)
    .every((node) => node.status === "complete" || node.status === "manually-confirmed");

  for (const node of Object.values(resolved)) {
    if (node.kind === "submission") node.status = submissionReady ? "ready" : "blocked";
  }
  return { definition, nodes: resolved, submissionReady };
}

export function workflowFilesForLine(records: ReceiptRecord[], line: ExpenseLine) {
  return records.filter((record) => record.path.startsWith(`${line.folder}/`));
}

/** 在启动与测试时拒绝悬空引用和会造成前置死锁的有向环。 */
export function validateWorkflow(definition: WorkflowDefinition) {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) errors.push(`重复节点：${node.id}`);
    ids.add(node.id);
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push(`悬空关系：${edge.id}`);
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges.filter((edge) => edge.relation === "input" || edge.relation === "produces")) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (adjacency.get(id) ?? []).some(visit);
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  if ([...ids].some(visit)) errors.push("前置或产出关系存在循环");
  return errors;
}
