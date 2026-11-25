import { cloudPaymentDateForImport, cloudPaymentNodeKind, validPaymentDate, type CloudMaterialDate } from "./cloud-payment";
import { FINANCIAL_FLOW_GROUPS, elabPreapprovalFor, expenseTypeHasRuleTag, expenseTypeIdForClassification, financialFlowGroup, type EvidenceTypeId, type ExpenseRuleTag, type ExpenseTypeId, type FinancialFlowGroup } from "./expense-taxonomy";
import { NODES } from "./node-registry";
import { dedupedAmountCny, dedupeExpenses } from "./dedupe-expenses";
import { inferEvidenceNodeId } from "./classification-rules";
import { amountInMinorUnits, withinAmountTier, withinRelativeAmountTier } from "./amount-matching";
import { flightSegmentMatch, normalizeFlightSegments, rebookingRoutesCompatible } from "./flight-segments";
import { BOOK_LIBRARY_ACCEPTANCE_THRESHOLD_CNY, LOW_VALUE_FIXED_ASSET_BATCH_CNY, PAYMENT_PROOF_THRESHOLD_CNY, estimateAmountInCny } from "./reimbursement-policy";
import type { CurrencyCode, ElabBillRecord, ExpenseLine, FlightSegment, MaterialFile, PersistedState, ReceiptRecord } from "./types";

export type EvidenceRole = "primary" | "payment" | "itinerary" | "detail" | "standard" | "explanation" | "archive" | "paired-support";
export type ExpenseStatus = "draft" | "identified" | "ready" | "submitted" | "archived" | "needs-rate";
export type Evidence = {
  id: string;
  contentHash: string;
  path: string;
  typeId: EvidenceTypeId;
  extracted: { amount?: number; currency?: ReceiptRecord["currency"]; issuer?: string; documentDate?: string; paymentDate?: string; paymentDateBlocked?: boolean; flightSegments?: FlightSegment[]; rebookingFeeAmount?: number };
  workflowNodeId?: string;
  reason?: string;
  feeScheduleReferencedAt?: string;
};
export type Expense = {
  id: string;
  setId: string;
  typeId: ExpenseTypeId;
  merchant?: string;
  occurredAt?: string;
  amount?: number;
  currency: ReceiptRecord["currency"];
  amountCny?: number;
  exchangeRate?: { cnyRate: number; cachedAt: string; source: "base" | "reference" | "manual" | "online" };
  status: ExpenseStatus;
};
export type EvidenceLink = { evidenceId: string; expenseId: string; role: EvidenceRole };
export type ExchangeRateCache = {
  currency: CurrencyCode;
  cnyRate: number;
  /** 本机缓存写入日期。 */
  updatedAt: string;
  /** 汇率源公布的生效日；手动录入时与 updatedAt 一致。 */
  effectiveDate?: string;
  source: "base" | "reference" | "manual" | "online";
};
export type FormalModelState = {
  schemaVersion: 2;
  migrated: boolean;
  sets: ExpenseLine[];
  /** 脚本侧删除/合并的票据集 id 墓碑：UI 吸收时移除对应本地行。 */
  removedSetIds?: string[];
  expenses: Expense[];
  evidence: Evidence[];
  links: EvidenceLink[];
  exchangeRates: ExchangeRateCache[];
  requirementOverrides: Record<string, boolean>;
  batches: PersistedState["batches"];
};

export type RuleCondition =
  | { kind: "amount-cny-at-least"; threshold: number }
  | { kind: "amount-cny-at-least"; threshold: number }
  | { kind: "amount-cny-under"; threshold: number }
  | { kind: "expense-type-is"; expenseType: ExpenseTypeId }
  | { kind: "expense-type-in"; expenseTypes: ExpenseTypeId[] }
  | { kind: "expense-has-tag"; tag: ExpenseRuleTag }
  | { kind: "expense-lacks-tag"; tag: ExpenseRuleTag }
  | { kind: "evidence-linked"; evidenceType: EvidenceTypeId };
export type RuleEffect = { kind: "require-linked-evidence"; evidenceType: EvidenceTypeId } | { kind: "block-submission" } | { kind: "notify"; message: string };
export type RuleDefinition = {
  id: string;
  scope: "expense" | "set";
  category: "金额政策" | "材料闭环" | "流程提示";
  conditions: RuleCondition[];
  effects: RuleEffect[];
  statement: string;
  expression: string;
  source: string;
};

const defaultRates: ExchangeRateCache[] = [
  { currency: "CNY", cnyRate: 1, updatedAt: "2026-08-11", source: "base" },
  { currency: "USD", cnyRate: 7.2, updatedAt: "2026-08-11", source: "reference" },
  { currency: "EUR", cnyRate: 7.85, updatedAt: "2026-08-11", source: "reference" },
  { currency: "GBP", cnyRate: 9.15, updatedAt: "2026-08-11", source: "reference" },
  { currency: "JPY", cnyRate: 0.047, updatedAt: "2026-08-11", source: "reference" },
  { currency: "HKD", cnyRate: 0.92, updatedAt: "2026-08-11", source: "reference" },
  { currency: "SGD", cnyRate: 5.55, updatedAt: "2026-08-11", source: "reference" },
  { currency: "THB", cnyRate: 0.2, updatedAt: "2026-08-11", source: "reference" },
  { currency: "AED", cnyRate: 1.96, updatedAt: "2026-08-11", source: "reference" },
];

export function emptyFormalModel(): FormalModelState {
  return { schemaVersion: 2, migrated: false, sets: [], expenses: [], evidence: [], links: [], exchangeRates: defaultRates, requirementOverrides: {}, batches: [] };
}

export function evidenceIdFor(file: Pick<MaterialFile, "contentHash" | "path">) {
  return `evidence:${file.contentHash || file.path}`;
}

function feeScheduleId(id: string, setId: string) {
  return `${id}:set:${setId}`;
}

function recordEvidenceId(record: ReceiptRecord, lines: ExpenseLine[]) {
  const id = evidenceIdFor(record);
  const owner = classifyEvidenceType(record) === "fee-schedule"
    ? lines.find((line) => line.folder && record.path.startsWith(`${line.folder}/`))
    : undefined;
  return owner ? feeScheduleId(id, owner.id) : id;
}

function feeScheduleReference(record: ReceiptRecord) {
  return record.feeScheduleReferencedAt
    ?? (record.isSymbolicLink || record.classificationReason?.startsWith("AI 搜索引用历史费用清单") ? "0" : undefined);
}

export function classifyEvidenceType(record: ReceiptRecord): EvidenceTypeId {
  // 明确归类优先于文件名：历史错误标签（如发票被命名成“支付凭证”）不得改变证据类型。
  const nodeId = (record.classifiedWorkflowNodeId ?? record.classifiedRequirementId ?? "").toLowerCase();
  // 注册表查表优先：节点元数据（node-registry）声明的证据类型是权威判定。
  const declared = NODES[nodeId]?.evidenceType as EvidenceTypeId | undefined;
  if (declared) return declared;
  if (nodeId.endsWith("-fee-schedule")) return "fee-schedule";
  if (/invoice$|-invoice/.test(nodeId) || /发票$/.test(nodeId)) return "invoice";
  if (/payment/.test(nodeId)) return "payment-proof";
  const value = `${record.name} ${record.path}`.toLowerCase();
  if (/支付|payment/.test(value)) return "payment-proof";
  if (/水单|folio/.test(value)) return "hotel-folio";
  if (/行程单|itinerary/.test(value)) return "itinerary";
  if (/机票|高铁|铁路电子客票|交通票|登机凭证|登机牌/.test(value)) return "transport-ticket";
  if (/订单|购买截图/.test(value)) return "purchase-order";
  if (/收费标准|费用清单|缴费方式|注册费标准|会议注册|会员费标准|产品页面|套餐价格|订阅价格|服务价格|registration-fee-list|membership-fee-list|chatgpt-fee-schedule|cloud-fee-schedule/.test(value)) return "fee-schedule";
  if (/邀请函|住宿安排/.test(value)) return "invitation";
  if (/日程|议程|agenda/.test(value)) return "agenda";
  if (/申请单|审批/.test(value)) return "approval-form";
  if (/出入境/.test(value)) return "entry-exit-record";
  if (/结团确认/.test(value)) return "closure-confirmation";
  if (/说明/.test(value)) return "explanation";
  if (/总结|接洽|执行委员/.test(value)) return "archive-attachment";
  if (/收据|receipt/.test(value)) return "receipt";
  if (/发票|账单/.test(value)) return "invoice";
  return "other";
}

function roleFor(typeId: EvidenceTypeId): EvidenceRole {
  if (typeId === "payment-proof") return "payment";
  if (typeId === "itinerary" || typeId === "transport-ticket") return "itinerary";
  if (typeId === "hotel-folio" || typeId === "purchase-order") return "detail";
  if (typeId === "fee-schedule") return "standard";
  if (typeId === "explanation") return "explanation";
  if (typeId === "archive-attachment" || typeId === "agenda" || typeId === "invitation") return "archive";
  return "primary";
}

function rateFor(currency: ReceiptRecord["currency"], rates: ExchangeRateCache[]) {
  return rates.find((rate) => rate.currency === currency);
}

/** 凭证语义命名（OTA 订单截图、支付凭证等）在方向交通节点上只作行程/支付证据，不产生费用——否则与对应发票双重计量（贵阳携程 1740 vs 机票发票 1030+699.54）。
 * 仅限 outbound/return-transport 语境：ChatGPT/云服务等无发票场景的「支付记录」就是票据依据，必须照常建费用。 */
export function isTransportVoucherNaming(name: string, nodeId: string): boolean {
  if (!["outbound-transport", "return-transport"].includes(nodeId)) return false;
  return /支付凭证|交通凭证|付款凭证|支付记录|支付截图|订单截图/.test(name);
}

/** elab 前置单（资产入账单/软件服务费报账单）不是消费凭证——不生成费用、不参与支付配对。 */
export function isPreapprovalEvidence(record: { classifiedWorkflowNodeId?: string; classifiedRequirementId?: string }) {
  const nodeId = record.classifiedWorkflowNodeId ?? record.classifiedRequirementId ?? "";
  return nodeId === "low-value-gear-elab" || nodeId === "cloud-services-csf";
};

/** 清除模型里前置单证据误建的费用/配对链接（报账单非消费凭证）。evidence 保留：材料仍在册，
 * 递交面板按 NODE_BINDINGS 把报账单归入对应财务流程组；误删 evidence 会让它掉进「未关联费用材料」。 */
export function stripPreapprovalArtifacts<T extends { evidence: Array<{ id: string; workflowNodeId?: string | null }>; expenses: Array<{ id: string }>; links: Array<{ evidenceId: string }> }>(model: T): T {
  const preapprovalIds = new Set(
    model.evidence.filter((item) => item.workflowNodeId === "low-value-gear-elab" || item.workflowNodeId === "cloud-services-csf").map((item) => item.id),
  );
  if (!preapprovalIds.size) return model;
  return {
    ...model,
    expenses: model.expenses.filter((expense) => !preapprovalIds.has(expense.id.replace(/^expense:/, ""))),
    links: model.links.filter((link) => !preapprovalIds.has(link.evidenceId)),
  };
}

function expenseFromRecord(record: ReceiptRecord, setId: string, evidenceId: string, rates: ExchangeRateCache[]): Expense {
  const rate = rateFor(record.currency, rates);
  const amountCny = rate && record.amount != null ? record.amount * rate.cnyRate : undefined;
  const classification = expenseTypeIdForClassification(record.expenseClassification);
  const nodeId = record.classifiedWorkflowNodeId ?? record.classifiedRequirementId;
  const typeId = classification === "other" ? expenseTypeForNode(nodeId) ?? classification : classification;
  return { id: `expense:${evidenceId}`, setId, typeId, merchant: record.issuer, occurredAt: record.invoiceDate, amount: record.amount, currency: record.currency, amountCny, exchangeRate: rate ? { cnyRate: rate.cnyRate, cachedAt: rate.updatedAt, source: rate.source } : undefined, status: rate || record.currency === "CNY" ? "identified" : "needs-rate" };
}

function hasRebookingCue(evidence: Evidence) {
  return /改签|退改费|\brebooking\b|\bchange fee\b/i.test(`${evidence.path.split("/").pop() ?? ""} ${evidence.reason ?? ""}`);
}

function attachWorkflowPaymentEvidence(model: FormalModelState, state: PersistedState, amountMatched: ReadonlySet<string>) {
  const paymentSources: Record<string, string[]> = {
    "registration-payment": ["registration", "registration-fee", "registration-invoice"], "membership-payment": ["membership-invoice"],
    "airfare-payment": ["airfare-invoice"], "hotel-payment": ["hotel", "hotel-invoice"],
    "transport-payment": ["outbound-transport", "return-transport", "transport-invoice", "transport-payment"], "chatgpt-payment": ["chatgpt-receipt"],
    "cloud-payment": ["cloud-invoice"],
  };
  const payments = model.evidence.filter((item) => item.typeId === "payment-proof" && !model.links.some((link) => link.evidenceId === item.id && link.role === "primary"));
  for (const evidence of payments) {
    const line = state.lines.find((item) => evidence.path.startsWith(`${item.folder}/`));
    if (!line) continue;
    if (amountMatched.has(evidence.id)) continue;
    const explicitRebooking = hasRebookingCue(evidence);
    const paymentNodeKey = explicitRebooking ? "transport-payment" : inferEvidenceNodeId(evidence.typeId, evidence.workflowNodeId, evidence.path);
    // 支付凭证若被归入"去程/返程交通凭证"节点（方向凭证），支付关联仍应按交通支付处理：一张合并支付常覆盖多张分开发票。
    const targetNodes = paymentSources[paymentNodeKey] ?? (/^transport/.test(paymentNodeKey) ? paymentSources["transport-payment"] : []);
    const candidates = model.expenses.filter((expense) => expense.setId === line.id && model.links.some((link) => {
      if (link.expenseId !== expense.id || link.role !== "primary") return false;
      const primary = model.evidence.find((item) => item.id === link.evidenceId);
      if (!primary) return false;
      if (targetNodes.includes(primary.workflowNodeId ?? "")) return true;
      // 兜底：主证据缺归类节点（如文件被改名后元数据失配）时，交通支付按证据类型与路径关键词识别交通票据。
      return paymentNodeKey === "transport-payment" && (["transport-ticket", "itinerary"].includes(primary.typeId) || (primary.typeId === "invoice" && /机票|车票|交通|铁路|民航|行程/.test(primary.path)));
    }));
    let targets = candidates;
    const paidAmount = evidenceAmount(evidence);
    const paidCurrency = evidence.extracted.currency;
    if (/^(?:registration|membership|hotel)-payment$/.test(paymentNodeKey) && paidAmount != null && paidCurrency
      && candidates.length && candidates.every((expense) => expense.amount != null)) {
      const pool = candidates.filter((expense) => expense.currency === paidCurrency);
      const sameAmount = pool.filter((expense) => amountInMinorUnits(expense.amount!, paidCurrency) === amountInMinorUnits(paidAmount, paidCurrency));
      const precision = sameAmount.length ? sameAmount : pool.filter((expense) => withinAmountTier(paidAmount, expense.amount!, paidCurrency, "precision"));
      const nearby = precision.length ? precision : pool.filter((expense) => withinAmountTier(paidAmount, expense.amount!, paidCurrency, "nearby"));
      const issuer = normalizedText(evidence.extracted.issuer);
      const eligible = nearby.length ? nearby : pool.filter((expense) => issuer.length >= 3 && issuer === normalizedText(expense.merchant)
        && withinAmountTier(paidAmount, expense.amount!, paidCurrency, "corroborated"));
      targets = eligible.length === 1 ? eligible : [];
    }
    if (explicitRebooking || /^(?:transport|airfare)-payment$/.test(paymentNodeKey)) {
      const fee = paidAmount;
      const currency = paidCurrency;
      const compatible = candidates.filter((expense) => expense.amount != null && fee != null && fee > 0 && currency && expense.currency === currency);
      const mainPayments = payments.filter((item) => item.id !== evidence.id && item.path.startsWith(`${line.folder}/`)
        && item.extracted.currency === currency && !hasRebookingCue(item)
        && /^(transport|airfare)-payment$/.test(inferEvidenceNodeId(item.typeId, item.workflowNodeId, item.path)));
      const itemized = compatible.flatMap((expense) => model.links.flatMap((link) => {
        if (link.role !== "primary" || link.expenseId !== expense.id) return [];
        const primary = model.evidence.find((item) => item.id === link.evidenceId);
        if (!primary?.path.startsWith(`${line.folder}/`) || /说明/.test(primary.path.split("/").pop() ?? "")) return [];
        const feeAmount = primary.extracted.rebookingFeeAmount ?? (hasRebookingCue(primary) ? evidenceAmount(primary) : undefined);
        return feeAmount != null && feeAmount > 0 ? [{ expense, primary, feeAmount }] : [];
      }));
      const marked = new Set(itemized.map(({ expense }) => expense.id));
      const eligible = itemized.filter(({ primary, feeAmount }) =>
        rebookingRoutesCompatible(primary.extracted.flightSegments, evidence.extracted.flightSegments)
        && withinAmountTier(fee!, feeAmount, currency!, "itemized")).map(({ expense }) => expense);
      const partialWithMain = itemized.some(({ expense, feeAmount }) => fee! < expense.amount! && mainPayments.some((item) => {
        const main = evidenceAmount(item);
        const original = expense.amount! - feeAmount;
        return main != null && withinAmountTier(main, original, currency!, currency === "CNY" ? "nearby" : "precision");
      }));
      if (explicitRebooking && !eligible.length) {
        // 无发票明细的历史凭证仍可按原票款合计复核。已有明细时以对应明细的上限为准。
        eligible.push(...compatible.filter((expense) => !marked.has(expense.id) && mainPayments.some((item) => {
          const main = evidenceAmount(item);
          return main != null && withinAmountTier(main + fee!, expense.amount!, currency!, currency === "CNY" ? "nearby" : "precision");
        })));
      }
      const hasFeeMatch = itemized.some(({ feeAmount }) => withinAmountTier(fee!, feeAmount, currency!, "itemized"));
      if (explicitRebooking || hasFeeMatch || partialWithMain) {
        const unique = [...new Set(eligible)];
        targets = unique.length === 1 ? unique : [];
        model.links = model.links.filter((link) => link.evidenceId !== evidence.id || link.role === "primary");
      }
    }
    for (const expense of targets) {
      if (model.links.some((link) => link.evidenceId === evidence.id && link.expenseId === expense.id && link.role === "payment")) continue;
      model.links.push({ evidenceId: evidence.id, expenseId: expense.id, role: "payment" });
    }
  }
}

/** 住宿水单须关联到同一笔住宿支出；日期相同优先，只有一笔住宿时可安全兜底。 */
function attachHotelFolioEvidence(model: FormalModelState, state: PersistedState) {
  for (const folio of model.evidence.filter((item) => item.typeId === "hotel-folio")) {
    const line = state.lines.find((item) => folio.path.startsWith(`${item.folder}/`));
    if (!line) continue;
    const candidates = model.expenses.filter((expense) => expense.setId === line.id && expense.typeId === "lodging" && !linkedEvidence(model, expense.id, "hotel-folio").length);
    const sameDate = candidates.filter((expense) => expense.occurredAt && expense.occurredAt === folio.extracted.documentDate);
    const targets = sameDate.length ? sameDate : candidates.length === 1 ? candidates : [];
    for (const expense of targets) model.links.push({ evidenceId: folio.id, expenseId: expense.id, role: "detail" });
  }
}

/** 注册费/会员费清单与费用类型配对；同一票据集仅有一笔同类支出时自动关联。 */
function attachFeeScheduleEvidence(model: FormalModelState, state: PersistedState) {
  const targets: Array<{ nodeId: string, expenseType: ExpenseTypeId }> = [
    { nodeId: "registration-fee-list", expenseType: "conference-registration" },
    { nodeId: "membership-fee-list", expenseType: "membership-fee" },
  ];
  // 未归类清单按文件名推断归属节点（历史手动命名文件无 nodeId），模式统一维护在 classification-rules。
  for (const target of targets) {
    for (const schedule of model.evidence.filter((item) => item.typeId === "fee-schedule" && inferEvidenceNodeId(item.typeId, item.workflowNodeId, item.path) === target.nodeId)) {
      const line = state.lines.find((item) => schedule.path.startsWith(`${item.folder}/`));
      if (!line) continue;
      const candidates = model.expenses.filter((expense) => expense.setId === line.id && expense.typeId === target.expenseType && !linkedEvidence(model, expense.id, "fee-schedule").length);
      if (candidates.length === 1) model.links.push({ evidenceId: schedule.id, expenseId: candidates[0].id, role: "standard" });
    }
  }
  // 节点归属不精确的清单兜底：AI 偶把清单归到票据节点（如 registration-fee），
  // 只要同一票据集里恰好一笔对应类型支出、且双方都还没有 fee-schedule 链接，就安全配对。
  for (const target of targets) {
    for (const line of state.lines) {
      const expenses = model.expenses.filter((expense) => expense.setId === line.id && expense.typeId === target.expenseType && !linkedEvidence(model, expense.id, "fee-schedule").length);
      if (expenses.length !== 1) continue;
      const linkedIds = new Set(model.links.filter((link) => link.expenseId === expenses[0].id).map((link) => link.evidenceId));
      const orphans = model.evidence.filter((item) =>
        item.typeId === "fee-schedule"
        && item.path.startsWith(`${line.folder}/`)
        && !SUBSCRIPTION_SCHEDULES[inferEvidenceNodeId(item.typeId, item.workflowNodeId, item.path)]
        && !linkedIds.has(item.id)
        && !model.links.some((link) => link.evidenceId === item.id && link.role === "standard"));
      if (orphans.length === 1) model.links.push({ evidenceId: orphans[0].id, expenseId: expenses[0].id, role: "standard" });
    }
  }
}

const SUBSCRIPTION_SCHEDULES: Partial<Record<string, { primaryNode: string; project?: RegExp }>> = {
  "chatgpt-fee-schedule": { primaryNode: "chatgpt-receipt", project: /chatgpt|openai/i },
  "zhipu-fee-schedule": { primaryNode: "zhipu-invoice", project: /智谱|bigmodel/i },
  "cloud-fee-schedule": { primaryNode: "cloud-invoice" },
};

function attachSubscriptionFeeSchedules(model: FormalModelState, state: PersistedState) {
  const feeSchedules = model.evidence.filter((item) => item.typeId === "fee-schedule");
  const primaryByExpense = new Map(model.links.filter((link) => link.role === "primary").map((link) => [link.expenseId, link.evidenceId]));
  const evidenceById = new Map(model.evidence.map((item) => [item.id, item]));
  const subscriptionLinks: EvidenceLink[] = [];
  const consideredIds = new Set<string>();
  for (const line of state.lines) {
    if (!line.folder) continue;
    const prefix = `${line.folder}/`;
    const expenses = model.expenses.filter((expense) => expense.setId === line.id && expenseTypeHasRuleTag(expense.typeId, "cloud-service"));
    const candidates = new Map<string, Evidence[]>();
    for (const schedule of feeSchedules.filter((item) => item.path.startsWith(prefix))) {
      const node = inferEvidenceNodeId(schedule.typeId, schedule.workflowNodeId, schedule.path);
      const binding = SUBSCRIPTION_SCHEDULES[node];
      if (!binding && node) continue;
      const projectName = normalizedText(`${schedule.extracted.issuer ?? ""} ${schedule.path.split("/").pop() ?? ""}`);
      const sameProject = expenses.filter((expense) => {
        const primary = evidenceById.get(primaryByExpense.get(expense.id) ?? "");
        if (binding?.project && primary?.workflowNodeId === binding.primaryNode) return true;
        if (binding?.project) {
          return binding.project.test(`${expense.merchant ?? ""} ${primary?.path.split("/").pop() ?? ""}`);
        }
        const merchant = normalizedText(expense.merchant ?? primary?.extracted.issuer);
        return merchant.length >= 2 && projectName.includes(merchant);
      });
      const selected = schedule.feeScheduleReferencedAt && binding
        ? expenses.filter((expense) => evidenceById.get(primaryByExpense.get(expense.id) ?? "")?.workflowNodeId === binding.primaryNode)
        : [];
      const inSameSubfolder = expenses.filter((expense) => materialFolder(schedule.path) !== line.folder
        && primaryEvidenceFolder(model, expense) === materialFolder(schedule.path));
      const targets = binding?.project
        ? [...new Set([...selected, ...sameProject])]
        : sameProject.length ? sameProject : selected.length ? selected
          : inSameSubfolder.length === 1 ? inSameSubfolder : expenses.length === 1 ? expenses : [];
      if (binding || targets.length) consideredIds.add(schedule.id);
      for (const expense of targets) {
        const options = candidates.get(expense.id) ?? [];
        options.push(schedule);
        candidates.set(expense.id, options);
      }
    }
    for (const [expenseId, options] of candidates) {
      const specified = options.filter((item) => item.feeScheduleReferencedAt)
        .sort((first, second) => second.feeScheduleReferencedAt!.localeCompare(first.feeScheduleReferencedAt!) || first.path.localeCompare(second.path));
      const chosen = specified[0] ?? (options.length === 1 ? options[0] : undefined);
      if (chosen) subscriptionLinks.push({ evidenceId: chosen.id, expenseId, role: "standard" });
    }
  }
  model.links = model.links.filter((link) => link.role !== "standard" || !consideredIds.has(link.evidenceId));
  model.links.push(...subscriptionLinks);
}

function materialFolder(filePath: string) {
  return filePath.split("/").slice(0, -1).join("/");
}

function primaryEvidenceFolder(model: FormalModelState, expense: Expense) {
  const primary = model.links.find((link) => link.expenseId === expense.id && link.role === "primary");
  const evidence = primary ? model.evidence.find((item) => item.id === primary.evidenceId) : undefined;
  return evidence ? materialFolder(evidence.path) : "";
}

function evidenceAmount(evidence: Evidence) {
  if (evidence.extracted.amount != null) return evidence.extracted.amount;
  const match = evidence.path.split("/").pop()?.match(/(?:CNY|USD|SGD|EUR|GBP|JPY|HKD|THB|AED)[_ -]?(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : undefined;
}

function evidenceDate(evidence: Evidence) {
  return evidence.extracted.documentDate ?? evidence.path.split("/").pop()?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
}

function dayDistance(first?: string, second?: string) {
  if (!first || !second) return undefined;
  const firstTime = Date.parse(`${first}T00:00:00Z`);
  const secondTime = Date.parse(`${second}T00:00:00Z`);
  return Number.isFinite(firstTime) && Number.isFinite(secondTime) ? Math.abs(firstTime - secondTime) / 86_400_000 : undefined;
}

function normalizedText(value?: string) {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 可解释的云服务材料匹配：金额 > 日期接近 > 服务商文本；目录仅作为平分时的弱证据。 */
export function cloudEvidenceMatchScore(model: FormalModelState, evidence: Evidence, expense: Expense) {
  let score = 0;
  const amount = evidenceAmount(evidence);
  if (amount != null && expense.amount != null && evidence.extracted.currency === expense.currency && withinAmountTier(amount, expense.amount, expense.currency, "precision")) score += 100;
  const distance = dayDistance(evidenceDate(evidence), expense.occurredAt);
  if (distance != null && distance <= 3) score += 20;
  else if (distance != null && distance <= 31) score += 10;
  const merchant = normalizedText(expense.merchant);
  const evidenceText = normalizedText(`${evidence.extracted.issuer ?? ""}${evidence.path}`);
  if (merchant.length >= 3 && evidenceText.includes(merchant)) score += 5;
  if (primaryEvidenceFolder(model, expense) === materialFolder(evidence.path)) score += 1;
  return score;
}

/** 云服务支付记录按交易匹配，费用清单走独立的项目关联。 */
function attachCloudServiceEvidence(model: FormalModelState, state: PersistedState, amountMatched: ReadonlySet<string>) {
  for (const evidence of model.evidence.filter((item) => item.typeId === "payment-proof")) {
    if (amountMatched.has(evidence.id) || hasRebookingCue(evidence) || model.links.some((link) => link.evidenceId === evidence.id)) continue;
    const line = state.lines.find((item) => evidence.path.startsWith(`${item.folder}/`));
    if (!line) continue;
    const cloudExpenses = model.expenses.filter((expense) => expense.setId === line.id && expenseTypeHasRuleTag(expense.typeId, "cloud-service")
      && !linkedEvidence(model, expense.id, "payment-proof").length);
    const scored = cloudExpenses.map((expense) => ({ expense, score: cloudEvidenceMatchScore(model, evidence, expense) })).sort((first, second) => second.score - first.score);
    const [best, second] = scored;
    const target = cloudExpenses.length === 1 ? cloudExpenses[0] : best && best.score >= 5 && best.score > (second?.score ?? -1) ? best.expense : undefined;
    if (target) model.links.push({ evidenceId: evidence.id, expenseId: target.id, role: "payment" });
  }
}

/** 低额日常网购商品的订单截图与发票关联；同目录优先，候选唯一时兜底。 */
function attachOnlinePurchaseEvidence(model: FormalModelState, state: PersistedState, amountMatched: ReadonlySet<string>) {
  for (const order of model.evidence.filter((item) => item.typeId === "purchase-order")) {
    if (amountMatched.has(order.id)) continue;
    const line = state.lines.find((item) => order.path.startsWith(`${item.folder}/`));
    if (!line) continue;
    const candidates = model.expenses.filter((expense) => expense.setId === line.id && expenseTypeHasRuleTag(expense.typeId, "online-purchase") && expense.amountCny != null && expense.amountCny < PAYMENT_PROOF_THRESHOLD_CNY && !linkedEvidence(model, expense.id, "purchase-order").length);
    const sameFolder = candidates.filter((expense) => primaryEvidenceFolder(model, expense) === materialFolder(order.path));
    const targets = sameFolder.length === 1 ? sameFolder : candidates.length === 1 ? candidates : [];
    for (const expense of targets) model.links.push({ evidenceId: order.id, expenseId: expense.id, role: "detail" });
  }
}

/** 网约车行程单须与同一笔市内或跨城市网约车支出关联；金额唯一匹配优先，日期相同次之。 */
function attachRideHailingItineraryEvidence(model: FormalModelState, state: PersistedState, amountMatched: ReadonlySet<string>) {
  const types = new Set<ExpenseTypeId>(["intercity-ride-hailing", "local-ride-hailing"]);
  for (const itinerary of model.evidence.filter((item) => item.typeId === "itinerary")) {
    if (amountMatched.has(itinerary.id)) continue;
    const line = state.lines.find((item) => itinerary.path.startsWith(`${item.folder}/`));
    if (!line) continue;
    const candidates = model.expenses.filter((expense) => expense.setId === line.id && types.has(expense.typeId) && !linkedEvidence(model, expense.id, "itinerary").length);
    // 金额匹配优先：行程单日期是行程日、发票日期是开票日，两者通常不对应——金额精确相等（±0.01）且唯一是主判据；
    // 日期相同（行程日恰逢开票日）次之；唯一候选最后兜底。
    const itineraryAmount = itinerary.extracted.amount;
    const sameAmount = itineraryAmount != null
      ? candidates.filter((expense) => expense.amount != null && expense.currency === (itinerary.extracted.currency ?? "CNY")
        && withinAmountTier(itineraryAmount, expense.amount, expense.currency, "precision"))
      : [];
    const sameDate = candidates.filter((expense) => expense.occurredAt && expense.occurredAt === itinerary.extracted.documentDate);
    const targets = sameAmount.length === 1 ? sameAmount : sameDate.length ? sameDate : candidates.length === 1 ? candidates : [];
    for (const expense of targets) model.links.push({ evidenceId: itinerary.id, expenseId: expense.id, role: "itinerary" });
  }
}

/** 跨城市打车说明仅关联跨城市网约车支出；同一票据集唯一候选时安全兜底。 */
function attachIntercityRideHailingExplanation(model: FormalModelState, state: PersistedState) {
  for (const explanation of model.evidence.filter((item) => item.typeId === "explanation")) {
    const line = state.lines.find((item) => explanation.path.startsWith(`${item.folder}/`));
    if (!line) continue;
    const candidates = model.expenses.filter((expense) => expense.setId === line.id && expense.typeId === "intercity-ride-hailing" && !linkedEvidence(model, expense.id, "explanation").length);
    if (candidates.length === 1) model.links.push({ evidenceId: explanation.id, expenseId: candidates[0].id, role: "explanation" });
  }
}

/** 一次性迁移：金额材料各自建立实际消费；辅助材料先保留为未关联证据，后续分类可自动/手动关联。 */
export function migrateLegacyState(state: PersistedState, records: ReceiptRecord[]): FormalModelState {
  const model = emptyFormalModel();
  model.migrated = true;
  model.sets = state.lines;
  model.requirementOverrides = state.requirementOverrides;
  model.batches = state.batches;
  // 前置单证据（elab 报账单/CSF 单）不是消费凭证：清除拦截修复前误建的存量费用/配对链接/证据，
  // 否则 reconcile 只增不删，「缺少关联的支付凭证（elab）」误报永远残留。
  const preapprovalEvidenceIds = new Set(
    records.filter((record) => isPreapprovalEvidence(record)).map((record) => evidenceIdFor(record)),
  );
  if (preapprovalEvidenceIds.size) {
    model.evidence = model.evidence.filter((item) => !preapprovalEvidenceIds.has(item.id));
    model.expenses = model.expenses.filter((expense) => !preapprovalEvidenceIds.has(expense.id.slice("expense:".length)));
    model.links = model.links.filter((link) => !preapprovalEvidenceIds.has(link.evidenceId));
  }
  for (const record of records) {
    const id = recordEvidenceId(record, state.lines);
    if (model.evidence.some((evidence) => evidence.id === id)) continue;
    const typeId = classifyEvidenceType(record);
    model.evidence.push({ id, contentHash: record.contentHash || record.path, path: record.path, typeId, extracted: { amount: record.amount, currency: record.currency, issuer: record.issuer, documentDate: record.invoiceDate, ...(record.paymentDate || record.paymentDateBlocked !== undefined ? { paymentDate: record.paymentDate, paymentDateBlocked: record.paymentDateBlocked } : {}), ...(record.flightSegments ? { flightSegments: record.flightSegments } : {}), ...(record.rebookingFeeAmount !== undefined ? { rebookingFeeAmount: record.rebookingFeeAmount } : {}) }, workflowNodeId: record.classifiedWorkflowNodeId ?? record.classifiedRequirementId, reason: record.classificationReason, ...(typeId === "fee-schedule" ? { feeScheduleReferencedAt: feeScheduleReference(record) } : {}) });
    const line = state.lines.find((item) => record.path.startsWith(`${item.folder}/`));
    if (!line || record.amount == null || !["invoice", "receipt", "transport-ticket"].includes(typeId) || isPreapprovalEvidence(record) || isTransportVoucherNaming(record.name, record.classifiedWorkflowNodeId ?? record.classifiedRequirementId ?? "")) continue;
    const expense = expenseFromRecord(record, line.id, id, model.exchangeRates);
    model.expenses.push(expense);
    model.links.push({ evidenceId: id, expenseId: expense.id, role: "primary" });
  }
  attachSupportEvidence(model, state);
  return model;
}

/** 扫描文件后用内容哈希恢复路径与提取字段；新材料先作为未关联证据保留。 */
/** 2026-09 拆分迁移：原「日常网购商品」发票/截图节点按费用类型重指派——办公用品（直接财务）/ 低值设备（elab 前置）。无费用关联的归办公用品。 */
const OFFICE_NODE_MIGRATION: Record<string, { supplies: string; gear: string }> = {
  "office-purchase-invoice": { supplies: "office-supplies-invoice", gear: "low-value-gear-invoice" },
  "office-purchase-proof": { supplies: "office-supplies-proof", gear: "low-value-gear-proof" },
};

/** 归类节点 → 费用类型，用于日常票据的分类和佐证配对。 */
const NODE_EXPENSE_TYPE_BY_NODE: Partial<Record<string, ExpenseTypeId>> = {
  "office-supplies-invoice": "office-supplies",
  "office-supplies-proof": "office-supplies",
  "low-value-gear-invoice": "low-value-gear",
  "low-value-gear-proof": "low-value-gear",
  "low-value-gear-payment": "low-value-gear",
  "chatgpt-receipt": "ai-subscription",
  "chatgpt-payment": "ai-subscription",
  "cloud-invoice": "cloud-service",
  "cloud-payment": "cloud-service",
  "zhipu-invoice": "cloud-service",
  "zhipu-payment": "cloud-service",
};

function expenseTypeForNode(nodeId?: string) {
  return nodeId ? NODE_EXPENSE_TYPE_BY_NODE[nodeId] : undefined;
}

/** 先用航段消歧。航段冲突或有多个同等候选时，金额不能盖过更强的证据。 */
function flightItineraryMatches(model: FormalModelState, sets: ExpenseLine[], primaryIds: ReadonlySet<string>, evidenceById: ReadonlyMap<string, Evidence>) {
  const matches = new Map<string, string | undefined>();
  const flightExpenses = model.expenses.filter((expense) => expense.typeId === "air-transport" || expense.typeId === "other");
  for (const item of model.evidence) {
    if (primaryIds.has(item.id) || (item.typeId !== "itinerary" && !["outbound-transport", "return-transport"].includes(item.workflowNodeId ?? ""))) continue;
    const segments = normalizeFlightSegments(item.extracted.flightSegments);
    if (!segments) continue;
    const owner = sets.find((set) => set.kind !== "日常" && set.folder && item.path.startsWith(`${set.folder}/`));
    if (!owner) continue;
    const prefix = `${owner.folder}/`;
    const candidates = flightExpenses.filter((expense) => expense.setId === owner.id).flatMap((expense) => {
      const booked = model.links.flatMap((link) => {
        const proof = evidenceById.get(link.evidenceId);
        return link.expenseId === expense.id && link.role === "primary" && proof?.path.startsWith(prefix)
          ? normalizeFlightSegments(proof.extracted.flightSegments) ?? [] : [];
      });
      if (!booked.length) return [];
      const score = Math.min(...segments.map((segment) => Math.max(...booked.map((other) => flightSegmentMatch(segment, other)))));
      return [{ expense, score }];
    });
    if (!candidates.length) continue;
    const bestScore = Math.max(...candidates.map(({ score }) => score));
    const best = candidates.filter(({ score }) => score > 0 && score === bestScore);
    matches.set(item.id, best.length === 1 ? best[0].expense.id : undefined);
  }
  return matches;
}

function attachLegacyExactSupport(model: FormalModelState, sets: ExpenseLine[], primaryByExpense: ReadonlyMap<string, Evidence>, flightMatches: ReadonlyMap<string, string | undefined>) {
  const paymentTypes: Partial<Record<string, ExpenseTypeId>> = {
    "registration-payment": "conference-registration",
    "membership-payment": "membership-fee",
    "hotel-payment": "lodging",
  };
  const linked = new Set(model.links.map((link) => link.evidenceId));
  for (const item of model.evidence) {
    if (item.workflowNodeId || linked.has(item.id) || flightMatches.has(item.id)) continue;
    const name = item.path.split("/").pop() ?? "";
    const typeId = item.typeId === "payment-proof" && !hasRebookingCue(item)
      ? paymentTypes[inferEvidenceNodeId(item.typeId, undefined, name)]
      : item.typeId === "itinerary" && /机票|航班|航空/.test(name) ? "air-transport" : undefined;
    const line = sets.find((set) => set.kind !== "日常" && set.folder && item.path.startsWith(`${set.folder}/`));
    const amount = evidenceAmount(item);
    const { currency } = item.extracted;
    if (!typeId || !line || amount == null || !Number.isFinite(amount) || amount <= 0 || !currency) continue;
    if (item.typeId === "payment-proof" && /已退款|支付失败|交易关闭|\brefunded\b|payment failed/i.test(`${name} ${item.reason ?? ""}`)) continue;
    const candidates = model.expenses.filter((expense) => expense.setId === line.id
      && expense.typeId === typeId && expense.currency === currency && expense.amount != null
      && amountInMinorUnits(expense.amount, currency) === amountInMinorUnits(amount, currency)
      && primaryByExpense.get(expense.id)?.path.startsWith(`${line.folder}/`));
    if (candidates.length === 1) {
      model.links.push({ evidenceId: item.id, expenseId: candidates[0].id, role: item.typeId === "itinerary" ? "itinerary" : "payment" });
    }
  }
}

/** 用已配对的外币支付凭证识别同一交易的人民币扣款。缓存汇率仅校验量级。 */
function attachConvertedPaymentEvidence(model: FormalModelState, sets: ExpenseLine[]) {
  const evidenceById = new Map(model.evidence.map((item) => [item.id, item]));
  const expenseById = new Map(model.expenses.map((expense) => [expense.id, expense]));
  const linked = new Set(model.links.map((link) => link.evidenceId));
  const foreignPayments = model.links.flatMap((link) => {
    const payment = evidenceById.get(link.evidenceId);
    const expense = expenseById.get(link.expenseId);
    if ((link.role !== "payment" && link.role !== "paired-support") || payment?.typeId !== "payment-proof" || payment.extracted.paymentDateBlocked
      || !expense || expense.currency === "CNY" || payment.extracted.currency !== expense.currency
      || expense.amount == null || expense.amountCny == null || expense.amountCny <= 0
      || amountInMinorUnits(evidenceAmount(payment) ?? 0, expense.currency) !== amountInMinorUnits(expense.amount, expense.currency)) return [];
    return [{ payment, expense }];
  });
  const options = model.evidence.flatMap((item) => {
    if (item.typeId !== "payment-proof" || item.extracted.currency !== "CNY" || item.extracted.paymentDateBlocked
      || linked.has(item.id) || hasRebookingCue(item)) return [];
    const owner = sets.find((line) => line.folder && item.path.startsWith(`${line.folder}/`));
    const issuer = normalizedText(item.extracted.issuer);
    const amount = evidenceAmount(item);
    const node = inferEvidenceNodeId(item.typeId, item.workflowNodeId, item.path);
    if (!owner || issuer.length < 3 || amount == null || !Number.isFinite(amount) || amount <= 0 || !node || /退款|支付失败|交易关闭|\brefunded\b|payment failed/i.test(
      `${item.path.split("/").pop() ?? ""} ${item.reason ?? ""}`,
    )) return [];
    const candidates = foreignPayments.filter(({ payment, expense }) =>
      expense.setId === owner.id && payment.path.startsWith(`${owner.folder}/`)
      && normalizedText(payment.extracted.issuer) === issuer
      && inferEvidenceNodeId(payment.typeId, payment.workflowNodeId, payment.path) === node
      && (dayDistance(item.extracted.paymentDate ?? evidenceDate(item), payment.extracted.paymentDate ?? evidenceDate(payment)) ?? Infinity) <= 1
      && withinRelativeAmountTier(amount, expense.amountCny!, "corroborated"));
    return candidates.length === 1 ? [{ item, ...candidates[0] }] : [];
  });
  for (const { item, payment, expense } of options) {
    if (options.filter((option) => option.payment.id === payment.id).length === 1) {
      model.links.push({ evidenceId: item.id, expenseId: expense.id, role: "payment" });
    }
  }
}

function attachSupportEvidence(model: FormalModelState, state: PersistedState) {
  const primaryIds = new Set(model.links.filter((link) => link.role === "primary").map((link) => link.evidenceId));
  const evidenceById = new Map(model.evidence.map((item) => [item.id, item]));
  const flightMatches = flightItineraryMatches(model, state.lines, primaryIds, evidenceById);
  const primaryByExpense = new Map(model.links.flatMap((link) => {
    const item = evidenceById.get(link.evidenceId);
    return link.role === "primary" && item && !["low-value-gear-elab", "cloud-services-csf"].includes(item.workflowNodeId ?? "")
      ? [[link.expenseId, item] as const] : [];
  }));
  const supports = model.evidence.flatMap((item) => {
    if (primaryIds.has(item.id) || flightMatches.has(item.id) || !["purchase-order", "payment-proof", "itinerary"].includes(item.typeId)
      || (item.typeId === "payment-proof" && hasRebookingCue(item))) return [];
    const node = inferEvidenceNodeId(item.typeId, item.workflowNodeId, item.path);
    const owner = state.lines.find((line) => line.folder && item.path.startsWith(`${line.folder}/`));
    const amount = evidenceAmount(item);
    const currency = item.extracted.currency ?? item.path.split("/").pop()?.match(/(CNY|USD|SGD|EUR|GBP|JPY|HKD|THB|AED)[_ -]?\d/i)?.[1]?.toUpperCase();
    if (!owner || amount == null || !Number.isFinite(amount) || amount <= 0 || !currency) return [];
    // 差旅保留既有的分笔/合并支付流程。有日常配对节点的材料也可出现在其他票据集中。
    const managed = (owner.kind === "日常" && !/^(?:transport|airfare|hotel|registration|membership)-/.test(node))
      || Boolean(expenseTypeForNode(node)) || node === "ride-hailing-itinerary";
    return managed ? [{ item, owner, node, amount, currency }] : [];
  });
  const amountMatched = new Set([...supports.map(({ item }) => item.id), ...flightMatches.keys()]);
  const resolved = new Map<string, Expense>();
  const rideTies = new Map<string, Array<{ item: Evidence; candidates: Expense[] }>>();
  const rideCarrier = (value: string) => {
    if (/滴滴/.test(value)) return "滴滴";
    if (/T3出行|领行智享/i.test(value)) return "T3";
  };
  const isRide = (expense: Expense) => expense.typeId === "local-ride-hailing" || expense.typeId === "intercity-ride-hailing";
  const paymentMonth = (evidence: Evidence) => {
    if (evidence.extracted.paymentDateBlocked) return;
    return validPaymentDate(evidence.extracted.paymentDate ?? evidenceDate(evidence))?.slice(0, 7);
  };
  for (const { item, owner, node, amount, currency } of supports) {
    if (item.typeId === "payment-proof" && /已退款|支付失败|交易关闭|\brefunded\b|payment failed/i.test(
      `${item.path.split("/").pop() ?? ""} ${item.reason ?? ""}`,
    )) continue;
    const pool = model.expenses.filter((expense) => expense.setId === owner.id && expense.currency === currency
      && expense.amount != null && primaryByExpense.get(expense.id)?.path.startsWith(`${owner.folder}/`));
    const paidUnits = amountInMinorUnits(amount, currency);
    const sourceLabel = `${item.extracted.issuer ?? ""} ${item.path.split("/").pop() ?? ""}`;
    const source = normalizedText(sourceLabel);
    const issuerMatches = (expense: Expense) => {
      const issuer = normalizedText(expense.merchant ?? primaryByExpense.get(expense.id)?.extracted.issuer);
      return issuer.length >= 3 && source.includes(issuer);
    };
    const ride = item.typeId === "itinerary";
    const sourceCarrier = ride ? rideCarrier(sourceLabel) : undefined;
    const cloud = item.typeId === "payment-proof" && (cloudPaymentNodeKind(node) === "payment" || /ChatGPT|OpenAI/i.test(sourceLabel));
    const month = cloud ? paymentMonth(item) : undefined;
    const candidatesByAmount = pool.filter((expense) => amountInMinorUnits(expense.amount!, currency) === paidUnits);
    const precision = candidatesByAmount.length ? candidatesByAmount : pool.filter((expense) => withinAmountTier(amount, expense.amount!, currency, "precision"));
    const fuzzy = precision.length ? [] : pool.filter((expense) => withinAmountTier(amount, expense.amount!, currency, "nearby"));
    const discounted = precision.length || fuzzy.length ? [] : pool.filter((expense) => issuerMatches(expense)
      && withinAmountTier(amount, expense.amount!, currency, "corroborated"));
    let remaining = [...precision, ...fuzzy, ...discounted];
    // 同额订阅优先取同付款期。开票日只辅助消歧，允许付款和开票跨月。
    if (month) {
      remaining = remaining.filter((expense) => {
        if (!expenseTypeHasRuleTag(expense.typeId, "cloud-service")) return true;
        const primary = primaryByExpense.get(expense.id)!;
        const explicitMonth = validPaymentDate(primary.extracted.paymentDate)?.slice(0, 7);
        return !explicitMonth || explicitMonth === month;
      });
      const sameMonth = remaining.filter((expense) => expenseTypeHasRuleTag(expense.typeId, "cloud-service") && paymentMonth(primaryByExpense.get(expense.id)!) === month);
      if (sameMonth.length) remaining = sameMonth;
    }
    if (sourceCarrier) {
      const carrierFor = (expense: Expense) => rideCarrier(expense.merchant ?? primaryByExpense.get(expense.id)?.path.split("/").pop() ?? "");
      remaining = remaining.filter((expense) => !carrierFor(expense) || carrierFor(expense) === sourceCarrier);
      const sameCarrier = remaining.filter((expense) => carrierFor(expense) === sourceCarrier);
      if (sameCarrier.length) remaining = sameCarrier;
    }
    if (remaining.length > 1) {
      const sameIssuer = remaining.filter(issuerMatches);
      if (sameIssuer.length) remaining = sameIssuer;
    }
    if (!precision.length && remaining.length > 1) {
      const sameCategory = remaining.filter((expense) => ride ? isRide(expense) : expense.typeId === expenseTypeForNode(node));
      if (sameCategory.length) remaining = sameCategory;
    }
    if (remaining.length === 1) resolved.set(item.id, remaining[0]);
    // 两票两行程同额时，先配有平台依据的那对，另一对在同一个闭合组内自动补齐。
    if (ride && candidatesByAmount.length === 2 && candidatesByAmount.every(isRide) && remaining.length) {
      const key = JSON.stringify([owner.id, currency, paidUnits]);
      const group = rideTies.get(key) ?? [];
      group.push({ item, candidates: remaining });
      rideTies.set(key, group);
    }
  }
  for (const group of rideTies.values()) {
    if (group.length !== 2) continue;
    const assigned = group.map(({ item }) => resolved.get(item.id));
    if (assigned.filter(Boolean).length !== 1) continue;
    const pending = group[assigned[0] ? 1 : 0];
    const options = pending.candidates.filter((expense) => !assigned.includes(expense));
    if (options.length === 1) resolved.set(pending.item.id, options[0]);
  }

  // 重算日常金额佐证，替换旧的多挂/误挂，并防止后续无金额兜底再覆盖。
  model.links = model.links.filter((link) => link.role === "primary" || !amountMatched.has(link.evidenceId));
  attachWorkflowPaymentEvidence(model, state, amountMatched);
  attachHotelFolioEvidence(model, state);
  attachSubscriptionFeeSchedules(model, state);
  attachFeeScheduleEvidence(model, state);
  attachRideHailingItineraryEvidence(model, state, amountMatched);
  attachIntercityRideHailingExplanation(model, state);
  attachCloudServiceEvidence(model, state, amountMatched);
  attachOnlinePurchaseEvidence(model, state, amountMatched);
  for (const { item } of supports) {
    const expense = resolved.get(item.id);
    if (expense) {
      model.links.push({ evidenceId: item.id, expenseId: expense.id, role: item.typeId === "itinerary" ? "itinerary" : "paired-support" });
    }
  }
  for (const [evidenceId, expenseId] of flightMatches) {
    if (expenseId) model.links.push({ evidenceId, expenseId, role: "itinerary" });
  }
  attachLegacyExactSupport(model, state.lines, primaryByExpense, flightMatches);
  attachConvertedPaymentEvidence(model, state.lines);
  model.links = [...new Map(model.links.map((link) => [`${link.evidenceId}|${link.expenseId}|${link.role}`, link])).values()];
}

/** 历史自动配对只在材料和支出归属同集时有效。 */
export function withoutCrossSetSupportLinks(
  links: EvidenceLink[],
  evidence: Evidence[],
  expenses: Expense[],
  sets: ReadonlyArray<Pick<ExpenseLine, "id" | "folder">>,
) {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const expenseById = new Map(expenses.map((item) => [item.id, item]));
  return links.filter((link) => {
    if (link.role !== "paired-support") return true;
    const item = evidenceById.get(link.evidenceId);
    const expense = expenseById.get(link.expenseId);
    const owner = item && sets.find((set) => set.folder && item.path.startsWith(`${set.folder}/`));
    return !expense || !owner || expense.setId === owner.id;
  });
}

function migrateOfficePurchaseNodes(model: FormalModelState): FormalModelState {
  const typeIdByEvidence = new Map<string, string>();
  for (const link of model.links) {
    const expense = model.expenses.find((item) => item.id === link.expenseId);
    if (expense) typeIdByEvidence.set(link.evidenceId, expense.typeId);
  }
  let touched = false;
  const evidence = model.evidence.map((item) => {
    const mapping = item.workflowNodeId ? OFFICE_NODE_MIGRATION[item.workflowNodeId] : undefined;
    if (!mapping) return item;
    touched = true;
    return { ...item, workflowNodeId: typeIdByEvidence.get(item.id) === "low-value-gear" ? mapping.gear : mapping.supplies };
  });
  return touched ? { ...model, evidence } : model;
}

export function reconcileFormalModel(model: FormalModelState, state: PersistedState, records: ReceiptRecord[]): FormalModelState {
  model = migrateOfficePurchaseNodes(model);
  const migratedFeeScheduleIds = new Map<string, string>();
  const liveOwners = new Map(state.lines.map((line) => [line.id, line]));
  const expenseOwners = new Map(model.expenses.map((expense) => [expense.id, expense.setId]));
  const storedEvidence = model.evidence.map((item) => {
    if (item.typeId !== "fee-schedule" || item.id !== evidenceIdFor(item)) return item;
    const owner = state.lines.find((line) => line.folder && item.path.startsWith(`${line.folder}/`))
      ?? model.links.filter((link) => link.evidenceId === item.id)
        .map((link) => liveOwners.get(expenseOwners.get(link.expenseId) ?? "")).find(Boolean);
    if (!owner) return item;
    const id = feeScheduleId(item.id, owner.id);
    migratedFeeScheduleIds.set(item.id, id);
    return { ...item, id };
  });
  const folders = state.lines.flatMap((line) => line.folder ? [`${line.folder}/`] : []);
  const hasOwner = (item: Pick<Evidence, "path">) => folders.some((folder) => item.path.startsWith(folder));
  const byId = new Map<string, Evidence>();
  for (const item of storedEvidence) {
    const current = byId.get(item.id);
    // 归档或重命名后的有效路径优先于已脱离票据集的同哈希旧路径。
    if (!current || (!hasOwner(current) && hasOwner(item))) byId.set(item.id, item);
  }
  const ownedRecordIds = new Set(records.filter(hasOwner).map((record) => recordEvidenceId(record, state.lines)));
  for (const record of records) {
    const id = recordEvidenceId(record, state.lines);
    const current = byId.get(id);
    const recordNodeId = record.classifiedWorkflowNodeId ?? record.classifiedRequirementId;
    const next: Evidence = { id, contentHash: record.contentHash || record.path, path: record.path, typeId: classifyEvidenceType(record), extracted: { amount: record.amount, currency: record.currency, issuer: record.issuer, documentDate: record.invoiceDate, ...(record.paymentDate || record.paymentDateBlocked !== undefined ? { paymentDate: record.paymentDate, paymentDateBlocked: record.paymentDateBlocked } : {}), ...(record.flightSegments ? { flightSegments: record.flightSegments } : {}), ...(record.rebookingFeeAmount !== undefined ? { rebookingFeeAmount: record.rebookingFeeAmount } : {}) }, workflowNodeId: recordNodeId, reason: record.classificationReason };
    if (next.typeId === "fee-schedule") next.feeScheduleReferencedAt = record.feeScheduleReferencedAt
      ?? current?.feeScheduleReferencedAt ?? feeScheduleReference(record);
    if (!hasOwner(next) && ownedRecordIds.has(id)) continue;
    if (current) {
      // 手工修正的归类不应被空归类或旧归类的扫描结果覆盖；仅当扫描带来明确新归类时才更新。
      const workflowNodeId = recordNodeId ?? current.workflowNodeId;
      byId.set(id, { ...current, ...next, workflowNodeId, extracted: { ...current.extracted, ...next.extracted } });
    } else byId.set(id, next);
  }
  const evidence = [...byId.values()];
  const missingRates = emptyFormalModel().exchangeRates.filter((rate) => !model.exchangeRates.some((item) => item.currency === rate.currency));
  const exchangeRates = [...model.exchangeRates, ...missingRates];
  const rateByCurrency = new Map(exchangeRates.map((rate) => [rate.currency, rate]));
  const expenses = model.expenses.map((expense) => {
    if (expense.status !== "needs-rate" || expense.amount == null) return expense;
    const rate = rateByCurrency.get(expense.currency);
    return rate ? { ...expense, amountCny: expense.amount * rate.cnyRate, exchangeRate: { cnyRate: rate.cnyRate, cachedAt: rate.updatedAt, source: rate.source }, status: "identified" as const } : expense;
  });
  // 归类节点 → 费用类型纠正：AI 费用分类为 other/未识别时，按证据的归类节点语义派生
  // （low-value-gear-invoice 证据对应的费用即 low-value-gear），保证分组/前置校验按正确类型走。
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const setIds = new Set(state.lines.map((line) => line.id));
  const expensesTyped = expenses.map((expense) => {
    const primary = model.links.find((link) => link.expenseId === expense.id && link.role === "primary");
    const item = primary && evidenceById.get(primary.evidenceId);
    // 历史拆分可能注销旧集。原始主凭证仍在现有集时，以其目录恢复归属。
    const owner = !setIds.has(expense.setId) && item && expense.id === `expense:${item.id}`
      ? state.lines.find((line) => line.folder && item.path.startsWith(`${line.folder}/`))
      : undefined;
    const owned = owner ? { ...expense, setId: owner.id } : expense;
    if (owned.typeId !== "other" && owned.typeId) return owned;
    const typeId = expenseTypeForNode(item?.workflowNodeId);
    return typeId ? { ...owned, typeId, merchant: owned.merchant ?? item?.extracted.issuer, occurredAt: owned.occurredAt ?? item?.extracted.documentDate } : owned;
  });
  // 费用去重：同一票据集内类型+金额一致的费用合并为一条（rename 后 contentHash 回退 path、
  // AI 多轮识别曾把同一张发票生成多笔费用），冗余费用的链接并入保留条后删除。
  // key 必须含 occurredAt：逐月同额订阅（8 月与 9 月各一笔 SGD30→158.53）是不同消费，
  // 缺时间维度会把后者当「同一张发票的多轮识别重复」合并删除，证据 primary 链接被 remap 到前者，
  // 此后补建逻辑被「已有 primary」永久挡住（2026-09 9 月 ChatGPT 费用凭空消失实证）。
  const expenseKey = (expense: Expense) => `${expense.setId ?? ""}|${expense.typeId}|${expense.amountCny ?? ""}|${expense.occurredAt ?? ""}|${expense.merchant ?? ""}`;
  const evidenceKeyOf = (expenseId: string) => {
    const first = (model.links ?? []).find((link) => link.expenseId === expenseId && link.role === "primary");
    return first?.evidenceId ?? "";
  };
  const keptExpenseByKey = new Map<string, { id: string }>();
  const remapExpense = new Map<string, string>();
  const dedupedExpenses: typeof expensesTyped = [];
  for (const expense of expensesTyped) {
    const key = expenseKey(expense);
    const kept = keptExpenseByKey.get(key);
    if (kept) console.debug("[dedupe] 合并", expense.merchant, expense.amountCny, expense.occurredAt, "→", kept.id.slice(-8));
    if (!kept) {
      keptExpenseByKey.set(key, { id: expense.id });
      dedupedExpenses.push(expense);
    } else {
      remapExpense.set(expense.id, kept.id);
    }
  }
  const expensesFinal = remapExpense.size ? dedupedExpenses : expensesTyped;

  // 链接清洗：proof 证据与费用金额不一致的链接一律移除——磁盘修正会被浏览器旧会话回写恢复，
  // 放进 reconcile 让前端每次加载自愈（错配曾让数据线费用挂着显示器截图，圆环虚降 3/4）。
  const expenseById = new Map(expensesTyped.map((expense) => [expense.id, expense]));
  const migratedLinks = model.links.map((link) => {
    const evidenceId = migratedFeeScheduleIds.get(link.evidenceId);
    return evidenceId ? { ...link, evidenceId } : link;
  });
  const links = withoutCrossSetSupportLinks(migratedLinks, evidence, expensesTyped, state.lines).filter((link) => {
    // primary 是费用与凭证的本体绑定，永不清洗——原币 extracted（如 SGD 765.9）与换算 CNY（729.23）
    // 天然有差，清洗会把 primary 删掉，尾循环随即重建同 id 费用，逐轮追加曾把费用刷到 9452 条。
    if (link.role === "primary") {
      // 原始凭证由 ID 确认，开票时间和消费时间可以不同。只清理去重后错挂到其他费用的主凭证。
      if (link.expenseId === `expense:${link.evidenceId}`) return true;
      const linkedEvidenceItem = evidenceById.get(link.evidenceId);
      const linkedExpenseItem = expenseById.get(link.expenseId);
      const evidenceDay = linkedEvidenceItem && evidenceDate(linkedEvidenceItem);
      if (linkedEvidenceItem && linkedExpenseItem && evidenceDay && linkedExpenseItem.occurredAt && evidenceDay !== linkedExpenseItem.occurredAt) return false;
      return true;
    }
    const evidenceItem = evidenceById.get(link.evidenceId);
    const expenseItem = expenseById.get(link.expenseId);
    if (!evidenceItem || !expenseItem) return true;
    if (evidenceItem.typeId === "fee-schedule") return true;
    const amount = evidenceItem.extracted?.amount;
    if (amount == null || expenseItem.amountCny == null) return true;
    return Math.abs(amount - expenseItem.amountCny) < 1;
  });
  // 去重重映射：冗余费用的链接指向保留条
  if (remapExpense.size) {
    for (const link of links) link.expenseId = remapExpense.get(link.expenseId) ?? link.expenseId;
  }
  const next = { ...model, sets: state.lines, batches: state.batches, requirementOverrides: state.requirementOverrides, evidence, expenses: expensesFinal, exchangeRates, links };
  for (const record of records) {
    const id = evidenceIdFor(record);
    const line = state.lines.find((item) => record.path.startsWith(`${item.folder}/`));
    const typeId = classifyEvidenceType(record);
    if (!line || record.amount == null || !["invoice", "receipt", "transport-ticket"].includes(typeId) || isPreapprovalEvidence(record) || isTransportVoucherNaming(record.name, record.classifiedWorkflowNodeId ?? record.classifiedRequirementId ?? "") || next.links.some((link) => link.evidenceId === id && link.role === "primary")) continue;
    const expense = expenseFromRecord(record, line.id, id, next.exchangeRates);
    if (!next.expenses.some((existing) => existing.id === expense.id)) next.expenses.push(expense);
    if (!next.links.some((link) => link.evidenceId === id && link.expenseId === expense.id)) {
      next.links.push({ evidenceId: id, expenseId: expense.id, role: "primary" });
    }
  }
  attachSupportEvidence(next, state);
  return next;
}

export function uniqueMaterialExpenseLinks(model: FormalModelState | null, setId: string) {
  const result = new Map<string, { expenseId: string; primary: boolean }>();
  if (!model) return result;
  const setExpenseIds = new Set(model.expenses.filter((expense) => expense.setId === setId).map((expense) => expense.id));
  const pathsById = new Map(model.evidence.map((evidence) => [evidence.id, evidence.path]));
  const ambiguous = new Set<string>();
  for (const link of model.links) {
    if (!setExpenseIds.has(link.expenseId)) continue;
    const filePath = pathsById.get(link.evidenceId);
    if (!filePath || ambiguous.has(filePath)) continue;
    const previous = result.get(filePath);
    if (previous && previous.expenseId !== link.expenseId) {
      result.delete(filePath);
      ambiguous.add(filePath);
    } else {
      result.set(filePath, { expenseId: link.expenseId, primary: Boolean(previous?.primary || link.role === "primary") });
    }
  }
  return result;
}

export function materialRowNumber(
  files: readonly Pick<ReceiptRecord, "path" | "contentHash">[],
  index: number,
  links: ReturnType<typeof uniqueMaterialExpenseLinks>,
  isPayment: boolean,
) {
  if (files.length <= 1) return;
  const file = files[index];
  const link = file && links.get(file.path);
  if (!link || (isPayment && link.primary)) return;
  const distinct = new Set<string>();
  for (const candidate of files) {
    const candidateLink = links.get(candidate.path);
    if (candidateLink?.expenseId === link.expenseId && !(isPayment && candidateLink.primary)) {
      distinct.add(candidate.contentHash || candidate.path);
    }
  }
  if (distinct.size > 1) return [...distinct].indexOf(file.contentHash || file.path) + 1;
}

export function linkedEvidence(model: FormalModelState, expenseId: string, typeId?: EvidenceTypeId) {
  const linkedIds = new Set(model.links.filter((link) => link.expenseId === expenseId).map((link) => link.evidenceId));
  return model.evidence.filter((item) => linkedIds.has(item.id) && (!typeId || item.typeId === typeId));
}

/** Payment months for cloud-service receipts, invoices and payment files in one set. */
export function cloudPaymentMonths(model: FormalModelState | null, setId: string, records: readonly ReceiptRecord[]) {
  const result = new Map<string, string>();
  const setMonth = (filePath: string, date?: string) => {
    const month = validPaymentDate(date?.slice(0, 10))?.slice(5, 7);
    if (month) result.set(filePath, `${Number(month)}月`);
  };
  const filesByPath = new Map(records.map((record) => [record.path, record]));
  for (const record of records) {
    const node = record.classifiedWorkflowNodeId ?? record.classifiedRequirementId ?? "";
    if (record.paymentDateBlocked) continue;
    if (record.paymentDate && cloudPaymentNodeKind(node)) setMonth(record.path, record.paymentDate);
    else if (record.paymentDateBlocked === undefined && cloudPaymentNodeKind(node) === "payment") setMonth(record.path, record.invoiceDate ?? record.name.match(/\d{4}-\d{2}-\d{2}/)?.[0]);
  }
  if (!model) return result;
  const evidenceById = new Map(model.evidence.filter((item) => filesByPath.has(item.path)).map((item) => [item.id, item]));
  const cloudExpenseIds = new Set(model.expenses.filter((expense) => expense.setId === setId
    && expenseTypeHasRuleTag(expense.typeId, "cloud-service")).map((expense) => expense.id));
  const evidenceDates = new Map<string, CloudMaterialDate>();
  for (const link of model.links) {
    if (!cloudExpenseIds.has(link.expenseId)) continue;
    const evidence = evidenceById.get(link.evidenceId);
    if (!evidence || evidenceDates.has(link.evidenceId)) continue;
    const file = filesByPath.get(evidence.path);
    const requirementId = evidence.workflowNodeId ?? file?.classifiedWorkflowNodeId ?? file?.classifiedRequirementId ?? "";
    const kind = cloudPaymentNodeKind(requirementId);
    if ((kind === "primary" && link.role !== "primary")
      || (kind === "payment" && (evidence.typeId !== "payment-proof" || (link.role !== "payment" && link.role !== "paired-support")))
      || !kind) continue;
    const documentDate = evidenceDate(evidence) ?? file?.invoiceDate;
    const paymentDateBlocked = file?.paymentDateBlocked ?? evidence.extracted.paymentDateBlocked;
    const paymentDate = paymentDateBlocked ? undefined : file?.paymentDate ?? evidence.extracted.paymentDate ?? (kind === "payment" && paymentDateBlocked === undefined ? documentDate : undefined);
    if (paymentDate) setMonth(evidence.path, paymentDate);
    evidenceDates.set(evidence.id, { requirementId, documentDate, paymentDate, paymentDateBlocked,
      amount: file?.amount ?? evidence.extracted.amount, currency: evidence.extracted.currency ?? file?.currency });
  }
  const allDates = [...evidenceDates.values()];
  for (const link of model.links) {
    if (link.role !== "primary" || !cloudExpenseIds.has(link.expenseId)) continue;
    const primary = evidenceById.get(link.evidenceId);
    const material = evidenceDates.get(link.evidenceId);
    if (!primary || !material || result.has(primary.path)) continue;
    const payments = model.links.filter((entry) => entry.expenseId === link.expenseId)
      .flatMap((entry) => evidenceDates.get(entry.evidenceId) ?? []);
    setMonth(primary.path, cloudPaymentDateForImport(material, payments, allDates));
  }
  return result;
}

/** 汇总本集以本组材料为主凭证的支出。佐证材料只参与核验。 */
export function groupAmountCny(model: FormalModelState, setId: string, materialPaths: string[]) {
  const paths = new Set(materialPaths);
  const evidenceIds = new Set(model.evidence.filter((item) => paths.has(item.path)).map((item) => item.id));
  const expenseIds = new Set(model.links.filter((link) => link.role === "primary" && evidenceIds.has(link.evidenceId)).map((link) => link.expenseId));
  return dedupedAmountCny(model.expenses.filter((expense) => expense.setId === setId && expenseIds.has(expense.id) && expense.amountCny != null));
}

/** 全局政策：除转采购流程的日常实物网购外，超过门槛的费用须有链接到自身的支付凭证。 */
export function expenseNeedsPaymentProof(expense: Expense) {
  // 高额日常实物网购应转采购流程，不能在票据簿里被误判为“缺支付凭证”。
  return expense.amountCny != null
    && expense.amountCny >= PAYMENT_PROOF_THRESHOLD_CNY
    && !expenseTypeHasRuleTag(expense.typeId, "online-purchase");
}

/** 全局材料闭环：所有住宿发票形成的住宿支出均须有同笔酒店水单。 */
export function expenseNeedsHotelFolio(expense: Expense) {
  return expense.typeId === "lodging";
}

export function expenseNeedsFeeSchedule(expense: Expense) {
  return expense.typeId === "conference-registration" || expense.typeId === "membership-fee";
}

export function expenseNeedsRideHailingItinerary(expense: Expense) {
  return expense.typeId === "intercity-ride-hailing" || expense.typeId === "local-ride-hailing";
}

export function expenseNeedsIntercityRideHailingExplanation(expense: Expense) {
  return expense.typeId === "intercity-ride-hailing";
}

export function expenseNeedsCloudServicePayment(expense: Expense) {
  return expenseTypeHasRuleTag(expense.typeId, "cloud-service");
}

export function expenseNeedsOnlinePurchaseProof(expense: Expense, invoice?: Evidence) {
  // 2026-11 定案（结合节点既有口径）：非上海税务局监制的发票须与购买截图成对提供，与金额无关；上海监制可免。
  // 监制地取自发票规范文件名的「上海监制」段；无发票或监制地未知时保守要求（校验三态：无法判定=要求）。
  if (!expenseTypeHasRuleTag(expense.typeId, "online-purchase")) return false;
  return !(invoice && /上海监制/.test(invoice.path));
}

/** 单笔费用金额达到 CNY 1,000（含）的低值设备支出须关联支付记录（财务处 2023-11-24 通知：单张或同一单位累计 1000 含以上要支付凭证）。 */
export function expenseNeedsLowValuePaymentProof(expense: Expense) {
  return expense.typeId === "low-value-gear" && expense.amountCny != null && expense.amountCny >= PAYMENT_PROOF_THRESHOLD_CNY;
}

/** 采购流程提示不属于票据簿的缺件，不能阻塞报销递交。 */
export function expenseNotices(expense: Expense) {
  if (expense.typeId === "books-materials"
    && expense.amountCny != null
    && expense.amountCny >= BOOK_LIBRARY_ACCEPTANCE_THRESHOLD_CNY) {
    return [`该图书资料单册或单套达到 CNY ${BOOK_LIBRARY_ACCEPTANCE_THRESHOLD_CNY.toLocaleString("zh-CN")}；报销前请完成图书馆验收。`];
  }
  if (expense.typeId === "low-value-gear"
    && expense.amountCny != null
    && expense.amountCny < PAYMENT_PROOF_THRESHOLD_CNY) {
    return ["低值易耗设备：递交财务前先在 elab（zcgl）提交材料易耗品低值品报账（整单 < CNY 10,000 经费负责人审批即过，达到 CNY 10,000 须装备处审批），凭通过的报账单随发票报销；报账单进度可在票据卡「elab 前置报账单」登记。"];
  }
  if (expenseTypeHasRuleTag(expense.typeId, "cloud-service")) {
    return ["云服务/AI 订阅：报销前先在 elab.ecnu.edu.cn/wxzc（无形资产系统）报账管理 → 软件服务报账填「软件服务费报账单」，科技处审核通过后再走财务；进度可在票据卡「elab 前置报账单」登记。"];
  }
  if (expenseTypeHasRuleTag(expense.typeId, "online-purchase")
    && expense.amountCny != null
    && expense.amountCny >= PAYMENT_PROOF_THRESHOLD_CNY) {
    return [`该实物商品单笔金额达到或超过 CNY 1,000：单价 ≥ 1,000 的设备须转设备申购（elab 提交申购单，验收后走固定资产报账），不在票据簿内报销；若为多件低值单品（单价 < 1,000）合计达标，仍走低值通道，但须提供同笔支付记录。`];
  }
  return [];
}

/** 同类低值设备批量兜底：单价 <1,000 但同一票据集内合计 ≥3 万时视同固定资产（指南第 2 页）。 */
export function lowValueGearBatchNotice(expenses: Expense[]): string[] {
  const total = expenses
    .filter((expense) => expense.typeId === "low-value-gear" && expense.amountCny != null && expense.amountCny < PAYMENT_PROOF_THRESHOLD_CNY)
    .reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0);
  if (total >= LOW_VALUE_FIXED_ASSET_BATCH_CNY) {
    return [`本票据集低值设备合计 CNY ${total.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}，已达到同类批量 CNY 30,000 兜底线：视同固定资产管理，请改走 elab 设备申购 + 固定资产报账，不进材料易耗品低值品通道。`];
  }
  return [];
}

export { samePaymentEvent, dedupeExpenses, dedupedAmountCny } from "./dedupe-expenses";

/** 递交分组：同组费用共用一张报销单（含同一 elab 前置）。 */
export type SubmissionGroup = {
  group: FinancialFlowGroup;
  label: string;
  hint: string;
  expenses: Expense[];
  amountCny: number;
  /** 该组的前置声明（direct 组无）。 */
  pre?: ReturnType<typeof elabPreapprovalFor>;
  /** 该组内未满足前置的费用缺口。 */
  gaps: ElabGap[];
};

/**
 * 递交分组计算：去重后的费用按财务流程组拆分（每组一张报销单）。
 * CSF（云服务/AI 订阅）与 HC（低耗）组须前置单覆盖；direct 组直接开单；固定资产组走设备申购流程。
 */
export function submissionGroups(line: Pick<ExpenseLine, "id" | "elabBills">, expenses: Expense[]): SubmissionGroup[] {
  const kept = dedupeExpenses(expenses).kept.filter((expense) => expense.setId === line.id);
  const gaps = elabPreapprovalGaps(line, expenses);
  const groups: SubmissionGroup[] = [];
  for (const group of Object.keys(FINANCIAL_FLOW_GROUPS) as FinancialFlowGroup[]) {
    const groupExpenses = kept.filter((expense) => financialFlowGroup(expense.typeId) === group);
    if (!groupExpenses.length) continue;
    groups.push({
      group,
      label: FINANCIAL_FLOW_GROUPS[group].label,
      hint: FINANCIAL_FLOW_GROUPS[group].hint,
      expenses: groupExpenses,
      amountCny: groupExpenses.reduce((sum, expense) => sum + (expense.amountCny ?? normalizeExpenseAmount({ amount: expense.amount, currency: expense.currency, name: "" })), 0),
      pre: groupExpenses.map((expense) => elabPreapprovalFor(expense.typeId)).find(Boolean),
      gaps: gaps.filter((gap) => groupExpenses.some((expense) => expense.id === gap.expense.id)),
    });
  }
  return groups;
}

/** 单笔费用未满足 elab/wxzc 前置报账单的缺口：missing = 未登记；pending = 已登记未审核通过。 */
export type ElabGap = {
  expense: Expense;
  pre: NonNullable<ReturnType<typeof elabPreapprovalFor>>;
  state: "missing" | "pending";
  billNo?: string;
  billStatus?: ElabBillRecord["status"];
};

/**
 * elab 前置核验：低耗（zcgl 材料易耗品报账）与云服务/AI 订阅（wxzc 软件服务报账）的费用，
 * 每笔必须被一张 approved 状态的报账单覆盖（draft/submitted 记 pending，rejected 视同未登记）。
 * 线上递交财务前须 gaps 为空——elab 报账单是财务报销前置（《软件相关费用审核区分》+ 装备处手册第 22 页）。
 */
export function elabPreapprovalGaps(line: Pick<ExpenseLine, "id" | "elabBills">, expenses: Expense[]): ElabGap[] {  const bills = line.elabBills ?? [];
  return expenses
    .filter((expense) => expense.setId === line.id)
    .flatMap((expense): ElabGap[] => {
      const pre = elabPreapprovalFor(expense.typeId);
      if (!pre) return [];
      const covering = bills.filter((bill) => bill.system === pre.system && bill.expenseIds.includes(expense.id));
      if (covering.some((bill) => bill.status === "approved")) return [];
      const latest = covering[covering.length - 1];
      if (latest && latest.status !== "rejected") {
        return [{ expense, pre, state: "pending", billNo: latest.billNo, billStatus: latest.status }];
      }
      return [{ expense, pre, state: "missing" }];
    });
}

export function expenseIssues(model: FormalModelState, expense: Expense, requirementOverrides: Record<string, boolean> = {}) {
  const issues: string[] = [];
  // 缺件提示标注具体支出：商户与金额让人一眼看出是哪笔费用缺材料。
  const at = `（${[expense.merchant, expense.amountCny != null ? `CNY ${Math.round(expense.amountCny).toLocaleString("zh-CN")}` : expense.amount != null ? `${expense.currency} ${expense.amount}` : ""].filter(Boolean).join(" · ")}）`;
  const push = (message: string) => issues.push(`${message}${at}`);
  // 人工确认（override=true）与真实文件等效：线下已提供但未扫描的材料不再拦截递交。
  const lineOverride = (nodeId: string) => requirementOverrides[`${expense.setId}:${nodeId}`] === true;
  if (expenseNeedsPaymentProof(expense) && !linkedEvidence(model, expense.id, "payment-proof").length && !lineOverride("hotel-payment") && !lineOverride("transport-payment") && !lineOverride("registration-payment") && !lineOverride("membership-payment")) push("缺少关联的支付凭证");
  if (expenseNeedsHotelFolio(expense) && !linkedEvidence(model, expense.id, "hotel-folio").length && !lineOverride("hotel-folio") && !lineOverride("folio")) push("缺少关联的酒店水单");
  if (expenseNeedsFeeSchedule(expense) && !linkedEvidence(model, expense.id, "fee-schedule").length && !lineOverride("registration-fee-list") && !lineOverride("registration-fee") && !lineOverride("membership-fee-list") && !lineOverride("cloud-fee-schedule") && !lineOverride("chatgpt-fee-schedule")) push(expense.typeId === "membership-fee" ? "缺少关联的会员费标准清单" : "缺少关联的注册费用清单");
  if (expenseNeedsRideHailingItinerary(expense) && !linkedEvidence(model, expense.id, "itinerary").length && !lineOverride("ride-hailing-itinerary")) push("缺少关联的网约车行程单");
  if (expenseNeedsIntercityRideHailingExplanation(expense) && !linkedEvidence(model, expense.id, "explanation").length && !lineOverride("taxi-note")) push("缺少关联的跨城市打车往返说明");
  if (expenseNeedsCloudServicePayment(expense) && !linkedEvidence(model, expense.id, "payment-proof").length && !lineOverride("cloud-payment") && !lineOverride("chatgpt-payment") && !lineOverride("zhipu-payment")) push("缺少关联的云服务支付记录");
  if (expenseNeedsCloudServicePayment(expense) && !linkedEvidence(model, expense.id, "fee-schedule").length && !lineOverride("cloud-fee-schedule") && !lineOverride("chatgpt-fee-schedule") && !lineOverride("zhipu-fee-schedule")) push("缺少关联的云服务费用清单");
  if (expenseNeedsOnlinePurchaseProof(expense, linkedEvidence(model, expense.id, "invoice")[0]) && !linkedEvidence(model, expense.id, "purchase-order").length && !lineOverride("office-purchase-proof") && !lineOverride("low-value-gear-proof")) push("缺少关联的日常网购商品购买截图");
  if (expenseNeedsLowValuePaymentProof(expense) && !linkedEvidence(model, expense.id, "payment-proof").length && !lineOverride("low-value-gear-payment")) push("缺少关联的低值设备支付记录");
  return issues;
}

export function attachEvidence(model: FormalModelState, evidenceId: string, expenseId: string, role?: EvidenceRole): FormalModelState {
  if (!model.evidence.some((evidence) => evidence.id === evidenceId) || !model.expenses.some((expense) => expense.id === expenseId)) return model;
  if (model.links.some((link) => link.evidenceId === evidenceId && link.expenseId === expenseId)) return model;
  const evidence = model.evidence.find((item) => item.id === evidenceId)!;
  return { ...model, links: [...model.links, { evidenceId, expenseId, role: role ?? roleFor(evidence.typeId) }] };
}

export function normalizeExpenseAmount(record: Pick<ReceiptRecord, "amount" | "currency" | "name">) {
  return estimateAmountInCny(record);
}
