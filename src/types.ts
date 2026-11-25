export type ViewId = "active" | "submitted" | "archived";

export type MaterialFile = {
  path: string;
  name: string;
  folder: string;
  ext: string;
  size: number;
  modifiedAt: string;
  /** 原始内容 SHA-256；文件改名或移动后仍可用于恢复材料身份。 */
  contentHash?: string;
  isSymbolicLink?: boolean;
};

export type ReceiptCategory =
  | "差旅"
  | "AI 订阅"
  | "云服务"
  | "市内交通"
  | "办公用品"
  | "低值易耗品"
  | "图书资料"
  | "知识产权"
  | "其他";

/**
 * 费用事项比展示用大类更细；同一笔支出的发票、行程单与支付凭证共用该分类。
 */
export type ExpenseClassification =
  | "会议注册费"
  | "学会会员费"
  | "航空交通费"
  | "铁路交通费"
  | "跨城市网约车费"
  | "市内网约车费"
  | "市内出租车费"
  | "住宿费"
  | "旅行保险费"
  | "AI 订阅费"
  | "云服务费"
  | "办公用品"
  | "低值易耗设备"
  | "办公设备"
  | "图书资料费"
  | "知识产权服务费"
  | "其他支出";

export type ReceiptStatus =
  | "待识别"
  | "待补件"
  | "可提交"
  | "已入批次"
  | "已归档";

export type CurrencyCode = "CNY" | "USD" | "SGD" | "AED" | "THB" | "EUR" | "JPY" | "HKD" | "GBP";

export type FlightSegment = { from?: string; to?: string; travelDate?: string; flightNumber?: string };

export type ReceiptMeta = {
  category?: ReceiptCategory;
  expenseClassification?: ExpenseClassification;
  status?: ReceiptStatus;
  amount?: number;
  currency?: CurrencyCode;
  issuer?: string;
  invoiceDate?: string;
  /** 实际付款日期，独立于开票日期。 */
  paymentDate?: string;
  /** 已识别到冲突日期或未成功付款，禁止以旧凭证日期代替。 */
  paymentDateBlocked?: boolean;
  flightSegments?: FlightSegment[];
  /** 发票逐项列出的含税改签费。 */
  rebookingFeeAmount?: number;
  note?: string;
  batchId?: string;
  /** AI 自动归类到当前票据集中的材料项；不依赖文件名关键词。 */
  classifiedRequirementId?: string;
  /** 图谱化分类 ID；与旧的 classifiedRequirementId 兼容读取。 */
  classifiedWorkflowNodeId?: string;
  classificationReason?: string;
  feeScheduleReferencedAt?: string;
};

export type ClassificationAssignment = {
  path: string;
  requirementId: string;
  reason?: string;
  documentDate?: string;
  paymentDate?: string;
  paymentDateBlocked?: boolean;
  flightSegments?: FlightSegment[];
  rebookingFeeAmount?: number;
  issuer?: string;
  amount?: string;
  currency?: string;
};

export type ReceiptRecord = MaterialFile &
  Required<Pick<ReceiptMeta, "category" | "status" | "currency">> &
  Omit<ReceiptMeta, "category" | "status" | "currency">;

export type Requirement = {
  id: string;
  label: string;
  hint: string;
  keywords: string[];
  optional?: boolean;
  matchAll?: boolean;
  paymentProofKeywords?: string[];
  requiredPaths?: string[];
  templateId?: "foreign-travel-consent" | "traffic-explanation" | "rebooking-explanation" | "return-summary" | "preapproval";
};

export type WorkflowScope = "finance" | "process" | "archive";
export type WorkflowNodeKind = "evidence" | "attachment" | "external-action" | "submission";
export type WorkflowRelation = "input" | "produces" | "paired-with" | "activates" | "archives-with";
export type WorkflowNodeStatus = "inactive" | "missing" | "ready" | "complete" | "blocked" | "manually-confirmed";

export type WorkflowCondition =
  | { kind: "always" }
  | { kind: "source-complete"; sourceIds: string[]; mode?: "any" | "all" }
  | { kind: "source-at-least-threshold"; sourceId: string; thresholdCny: number };

export type WorkflowNode = Requirement & {
  kind: WorkflowNodeKind;
  scope: WorkflowScope;
  collection: string;
  required: "always" | "when-active" | "never";
  activation?: WorkflowCondition;
  visibleWhen?: "always" | "active";
  /** 外部动作可由其产物文件自动完成，例如结团确认单。 */
  completedBy?: string[];
  /** 形式化绑定：节点所接收的证据类型、作用的费用事项和控制它的规则。 */
  evidenceTypes?: EvidenceTypeId[];
  expenseTypes?: ExpenseTypeId[];
  ruleIds?: string[];
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  relation: WorkflowRelation;
  /** 若关系由一条全局规则定义，引用其规则 ID，避免在规则库重复展示。 */
  ruleId?: string;
  condition?: WorkflowCondition;
  pairing?: { strategy: "transaction-first" | "same-day" | "project-first" };
};

export type WorkflowCollection = {
  id: string;
  label: string;
  hint: string;
  scope: WorkflowScope;
  nodeIds: string[];
};

export type WorkflowDefinition = {
  id: string;
  version: 1;
  kind: ExpenseLine["kind"];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  collections: WorkflowCollection[];
};

export type ResolvedWorkflowNode = WorkflowNode & {
  status: WorkflowNodeStatus;
  active: boolean;
  requiredForSubmission: boolean;
  file?: ReceiptRecord;
  /** 该材料项匹配到的全部文件；多项凭证（如多笔支付）并存时全部展示。 */
  files: ReceiptRecord[];
  blockers: string[];
};

export type ResolvedWorkflow = {
  definition: WorkflowDefinition;
  nodes: Record<string, ResolvedWorkflowNode>;
  submissionReady: boolean;
};

export type RequirementGroup = {
  id: string;
  label: string;
  hint: string;
  requirements: Requirement[];
  optional?: boolean;
};

export type TravelCase = {
  id: string;
  title: string;
  destination: string;
  period: string;
  dueDate: string;
  status: "active" | "archived";
  folder?: string;
  match?: RegExp;
  requirements: Requirement[];
  attachments?: Requirement[];
};

/** elab/wxzc 前置报账单的登记状态。 */
export type ElabBillStatus = "draft" | "submitted" | "approved" | "rejected";

/** 票据集内登记的 elab/wxzc 前置报账单（低耗→zcgl HC 单；云服务/AI 订阅→wxzc CSF 单）。 */
export type ElabBillRecord = {
  id: string;
  system: "zcgl" | "wxzc";
  /** 报账单号（HC / CSF）。 */
  billNo: string;
  status: ElabBillStatus;
  /** 覆盖的费用事项 id（formal-model expense id）；同类多笔费用可合并一张单。 */
  expenseIds: string[];
  /** 报账单金额（元）；与覆盖费用合计对照防漏报。 */
  amountCny?: number;
  submittedAt?: string;
  approvedAt?: string;
  /** 审核链：经费负责人审批（常规品目自批）/ 实验室与装备处审批（非常规品目人工审）——sync 回填 */
  stage?: string;
  /** elab 内部 wid（打印报账单 PDF 用）——sync 回填 */
  wid?: string;
  note?: string;
};

/** 递交投递参数（随每次递交绑定在票据集上；线上递交时作为开单参数传给财务系统自动化）。 */
export type LineDelivery = {
  /** 报销单投递校区。 */
  campus: "" | "普陀校区" | "闵行校区";
  /** 是否委托财务打印纸质材料。 */
  printByFinance: boolean;
  /** 协同审批人（与财务系统一致的单栏，格式为工号/姓名）。 */
  approver: string;
};

/** 单张报销单的轮询快照（poll_daily merge_status 写入，billNo 为键）。 */
export type TreasuryBillRecord = {
  billNo: string;
  status?: string;
  appliedAt?: string;
  postedAt?: string;
  voucherNo?: string;
  amountCny?: number;
  /** 该张报销单使用的经费项目号。 */
  projectCode?: string;
  /** 开单系统：YBX=智能报销平台（自动开单），YB6=老系统预约报销（历史单）。开单后不变，仅空时补写。 */
  system?: "YBX" | "YB6";
  /** 单当前所在视图（轮询按命中数据面写入，随状态刷新更新）：YBX-全部报销单 / YB6-报销单管理 / YB6-历史报销单。 */
  view?: "YBX-全部报销单" | "YB6-报销单管理" | "YB6-历史报销单";
};

export type ExpenseLine = {
  id: string;
  title: string;
  kind: "国际会议" | "国内会议" | "国内差旅" | "日常";
  createdAt: string;
  submittedAt?: string;
  /** 票据簿归档操作的时间戳（ISO 8601）。 */
  archivedAt?: string;
  /** 最近一次从归档区还原的时间，以及当时的归档时间（如有）。 */
  lastArchiveRestore?: { archivedAt?: string; restoredAt: string };
  status: "active" | "submitted" | "archived";
  folder: string;
  requirements: Requirement[];
  groups?: RequirementGroup[];
  attachments?: Requirement[];
  workflowId?: string;
  /** 快照对应的注册表版本；落后于 node-registry WORKFLOWS.version 时自动对齐。 */
  workflowVersion?: number;
  /** 财务系统对齐：递交时登记的报销单号（预约报销平台 req_no）。 */
  treasuryBillNo?: string;
  /** 拆单报销时一张票据集对应多张报销单。 */
  treasuryBillNos?: string[];
  /** 每张报销单的实时状态（轮询写入；多单票据集各单独立跟踪，顶层 treasury* 字段保存主单（treasuryBillNo）的值）。 */
  treasuryBills?: TreasuryBillRecord[];
  /** 财务侧最近一次状态（来自预约物流/历史报销单查询）。 */
  treasuryStatus?: string;
  treasuryStatusAt?: string;
  /** 财务凭证号（入账后回填，如 "2026 7A 4716"）。 */
  treasuryVoucherNo?: string;
  /** 财务入账日期（YYYY-MM-DD）。 */
  treasuryPostedAt?: string;
  /** 报销单申请金额（元，来自财务系统"申请金额"列；拆单时为多单合计）。 */
  treasuryAmountCny?: number;
  /** 投递参数：递交对话框内编辑，随递交留痕（未设置时用全局上次值预填）。 */
  delivery?: LineDelivery;
  /** 线上递交使用的预算项目（data/budgets 里的 projectId）。 */
  projectId?: string;
  /** elab/wxzc 前置报账单登记（低耗/云服务/AI 订阅线上递交前须全部 approved）。 */
  elabBills?: ElabBillRecord[];
};

export type SubmissionBatch = {
  id: string;
  title: string;
  createdAt: string;
  submittedAt?: string;
  status: "draft" | "submitted";
  receiptPaths: string[];
};

export type PersistedState = {
  metadata: Record<string, ReceiptMeta>;
  requirementOverrides: Record<string, boolean>;
  batches: SubmissionBatch[];
  lines: ExpenseLine[];
  /** 用户显式移出系统的材料路径；磁盘文件保留，票据集归档时才一并清理。 */
  removedPaths?: Record<string, true>;
};
import type { EvidenceTypeId, ExpenseTypeId } from "./expense-taxonomy";
