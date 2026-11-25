import type { CurrencyCode, ExpenseClassification, ReceiptCategory } from "./types";

export type ExpenseTypeId =
  | "conference-registration" | "membership-fee" | "air-transport" | "rail-transport"
  | "intercity-ride-hailing" | "lodging" | "travel-insurance" | "ai-subscription"
  | "cloud-service" | "local-ride-hailing" | "office-supplies"
  | "low-value-gear" | "office-equipment" | "books-materials" | "intellectual-property" | "other";

/** 规则不直接依赖具体供应商；费用类型通过标签加入可扩展的规则范围。 */
export type ExpenseRuleTag = "cloud-service" | "online-purchase";

export type EvidenceTypeId =
  | "invoice" | "receipt" | "payment-proof" | "transport-ticket" | "itinerary"
  | "hotel-folio" | "purchase-order" | "fee-schedule" | "invitation" | "agenda"
  | "approval-form" | "entry-exit-record" | "closure-confirmation" | "explanation"
  | "archive-attachment" | "other";

/** elab/wxzc 前置报账单声明：线上递交财务前必须审核通过的外部流程（依据《软件相关费用审核区分》与装备处报账门槛）。 */
export type ElabPreapproval = {
  /** zcgl = 设备与实验室管理平台（材料易耗品）；wxzc = 无形资产（软件）系统（软件服务费）。 */
  system: "zcgl" | "wxzc";
  systemLabel: string;
  billKind: string;
  /** 报账单号前缀（HC / CSF）。 */
  billPrefix: "HC" | "CSF";
  entry: string;
  approver: string;
  /** 填报格式提示。 */
  referenceBill: string;
};

export type ExpenseTaxonomyEntry = {
  id: ExpenseTypeId;
  label: ExpenseClassification;
  category: ReceiptCategory;
  scope: "差旅与会议" | "日常";
  keywords: string[];
  evidence: string;
  ruleTags?: ExpenseRuleTag[];
  elab?: ElabPreapproval;
};

export const ELAB_PREAPPROVALS: Record<"zcgl-cl" | "wxzc-csf", ElabPreapproval> = {
  "zcgl-cl": {
    system: "zcgl", systemLabel: "设备与实验室管理平台（elab.ecnu.edu.cn/zcgl）",
    billKind: "材料易耗品低值品报账单", billPrefix: "HC",
    entry: "报账管理 → 材料易耗品低值品报账 → 个人新增材料、易耗品、低值品报账单",
    approver: "整单 < CNY 10,000 经费负责人自批；≥ CNY 10,000 装备处审批（约 1 个工作日）",
    referenceBill: "名称格式「分类目录*商品名」，如计算机外部设备*扩展坞",
  },
  "wxzc-csf": {
    system: "wxzc", systemLabel: "无形资产（软件）系统（elab.ecnu.edu.cn/wxzc）",
    billKind: "软件服务费报账单（测试服务费）", billPrefix: "CSF",
    entry: "报账管理 → 软件服务报账 → 个人新增测试服务费报账单",
    approver: "科技处审批",
    referenceBill: "可将多笔同类账单合并，明细填写「软件服务费」",
  },
};

export type EvidenceTaxonomyEntry = {
  id: EvidenceTypeId;
  label: string;
  description: string;
};

export const EVIDENCE_TAXONOMY: EvidenceTaxonomyEntry[] = [
  { id: "invoice", label: "发票", description: "电子或纸质报销发票" },
  { id: "receipt", label: "收据", description: "注册费、会员费或订阅收据" },
  { id: "payment-proof", label: "支付凭证", description: "银行、支付平台或订单付款记录" },
  { id: "transport-ticket", label: "交通票据", description: "机票、高铁票或铁路电子客票" },
  { id: "itinerary", label: "行程单", description: "交通或网约车行程明细" },
  { id: "hotel-folio", label: "住宿水单", description: "住宿日期与房费明细" },
  { id: "purchase-order", label: "订单/购买截图", description: "网购订单或购买记录" },
  { id: "fee-schedule", label: "收费标准", description: "注册费、会员费或服务收费清单" },
  { id: "invitation", label: "邀请函", description: "会议邀请或住宿安排" },
  { id: "agenda", label: "会议日程", description: "会议议程或日程安排" },
  { id: "approval-form", label: "审批单", description: "因公出国申请单等审批材料" },
  { id: "entry-exit-record", label: "出入境记录", description: "护照及出入境记录" },
  { id: "closure-confirmation", label: "结团确认单", description: "因公出国境结团确认材料" },
  { id: "explanation", label: "说明", description: "交通情况说明等书面说明" },
  { id: "archive-attachment", label: "归档附件", description: "仅随项目归档的材料" },
  { id: "other", label: "其他材料", description: "尚未识别的材料" },
];

export type ExchangeRateTaxonomyEntry = {
  currency: CurrencyCode;
  cnyRate?: number;
  status: "base" | "reference" | "manual" | "online";
  note: string;
};

/** 金额阈值判断只使用已配置的参考汇率；未配置币种保持人工确认，绝不静默估算。 */
export const EXCHANGE_RATE_TAXONOMY: ExchangeRateTaxonomyEntry[] = [
  { currency: "CNY", cnyRate: 1, status: "base", note: "本位币" },
  { currency: "USD", cnyRate: 7.2, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "EUR", cnyRate: 7.85, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "GBP", cnyRate: 9.15, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "JPY", cnyRate: 0.047, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "HKD", cnyRate: 0.92, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "SGD", cnyRate: 5.55, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "THB", cnyRate: 0.2, status: "reference", note: "初始参考缓存，可手动更新" },
  { currency: "AED", cnyRate: 1.96, status: "reference", note: "初始参考缓存，可手动更新" },
];

/** 单笔支出词表：材料文件先归属一笔费用，再由流程图判断材料关系。 */
export const EXPENSE_TAXONOMY: ExpenseTaxonomyEntry[] = [
  { id: "conference-registration", label: "会议注册费", category: "差旅", scope: "差旅与会议", keywords: ["注册费", "registration"], evidence: "收据或发票、收费标准；支付凭证按金额规则触发" },
  { id: "membership-fee", label: "学会会员费", category: "差旅", scope: "差旅与会议", keywords: ["会员费", "ccf会员", "ieee会员", "acm会员"], evidence: "会员费收据与会员等级/收费标准" },
  { id: "air-transport", label: "航空交通费", category: "差旅", scope: "差旅与会议", keywords: ["机票", "航空", "flight"], evidence: "去返行程、机票发票；支付凭证按金额规则触发" },
  { id: "rail-transport", label: "铁路交通费", category: "差旅", scope: "差旅与会议", keywords: ["高铁", "火车", "铁路"], evidence: "去返车票或行程单；支付凭证按金额规则触发" },
  { id: "intercity-ride-hailing", label: "跨城市网约车费", category: "差旅", scope: "差旅与会议", keywords: ["跨城市打车", "跨城网约车"], evidence: "发票与行程单成对；另附交通情况说明" },
  { id: "lodging", label: "住宿费", category: "差旅", scope: "差旅与会议", keywords: ["住宿", "酒店", "水单", "folio"], evidence: "住宿发票与水单成对；支付凭证按金额规则触发" },
  { id: "travel-insurance", label: "旅行保险费", category: "差旅", scope: "差旅与会议", keywords: ["旅行保险", "保险发票"], evidence: "按实际发生提供保险发票" },
  // 低值易耗设备在云服务之前匹配：随身WiFi/移动WiFi 是硬件，避免被云服务的裸 wifi 关键词吃掉。
  { id: "low-value-gear", label: "低值易耗设备", category: "低值易耗品", scope: "日常", keywords: ["随身wifi", "移动wifi", "5g随身", "转接头", "充电器", "扩展坞", "移动硬盘", "台灯", "u盘", "数据线", "读卡器", "鼠标垫", "插线板"], evidence: "非上海监制发票须配购买截图（与金额无关，上海监制可免）；单笔费用金额 ≥ CNY 1,000 须支付记录；递交财务前先在 elab 提交材料易耗品低值品报账（整单 ≥ CNY 10,000 须装备处审批），凭通过的报账单报销；同类批量 ≥ CNY 30,000 视同固定资产，改走设备申购", ruleTags: ["online-purchase"], elab: ELAB_PREAPPROVALS["zcgl-cl"] },
  { id: "ai-subscription", label: "AI 订阅费", category: "AI 订阅", scope: "日常", keywords: ["chatgpt", "openai", "claude", "anthropic"], evidence: "订阅收据/发票与支付记录", ruleTags: ["cloud-service"], elab: ELAB_PREAPPROVALS["wxzc-csf"] },
  { id: "cloud-service", label: "云服务费", category: "云服务", scope: "日常", keywords: ["六六云", "云服务", "cloud", "vpn", "wifi", "aws", "azure", "阿里云", "腾讯云", "digitalocean", "vultr", "linode", "hetzner"], evidence: "账单/发票与支付记录", ruleTags: ["cloud-service"], elab: ELAB_PREAPPROVALS["wxzc-csf"] },
  { id: "local-ride-hailing", label: "市内网约车费", category: "市内交通", scope: "日常", keywords: ["滴滴", "网约车", "行程单"], evidence: "发票与行程单成对" },
  // 出租车费用类型已移除：上传的打车发票（含票面写「出租车」的网约出租车）一律按 local-ride-hailing 处理；纸质出租车发票走线下财务
  { id: "office-supplies", label: "办公用品", category: "办公用品", scope: "日常", keywords: ["文具", "办公用品", "纸张", "饮用水", "咖啡", "订书机", "文件夹", "墨盒", "硒鼓", "笔记本芯"], evidence: "单价 < CNY 1,000：发票与购买截图成对；不属装备处审核范围，直接走财务报销", ruleTags: ["online-purchase"] },
  { id: "office-equipment", label: "办公设备", category: "办公用品", scope: "日常", keywords: ["显示器", "键盘", "鼠标", "设备"], evidence: "单价 ≥ CNY 1,000 转学校采购流程：先在 elab 设备申购，验收后在固定资产报账，再随资产标签走财务" },
  { id: "books-materials", label: "图书资料费", category: "图书资料", scope: "日常", keywords: ["图书", "书籍", "教材"], evidence: "单册/套 CNY 500 以下附购书清单或书名；CNY 500 及以上须图书馆验收" },
  { id: "intellectual-property", label: "知识产权服务费", category: "知识产权", scope: "日常", keywords: ["专利", "实审费", "初审", "代理"], evidence: "按实际发生留存发票或缴费凭据" },
  { id: "other", label: "其他支出", category: "其他", scope: "日常", keywords: [], evidence: "需要人工确认费用事项与适用材料" },
];

export function inferExpenseClassification(value: string): ExpenseTaxonomyEntry {
  const normalized = value.toLowerCase();
  return EXPENSE_TAXONOMY.find((entry) => entry.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())))
    ?? EXPENSE_TAXONOMY.find((entry) => entry.id === "other")!;
}

export function expenseTypeIdForClassification(classification?: ExpenseClassification): ExpenseTypeId {
  return EXPENSE_TAXONOMY.find((entry) => entry.label === classification)?.id ?? "other";
}

export function expenseTypeHasRuleTag(typeId: ExpenseTypeId, tag: ExpenseRuleTag) {
  return EXPENSE_TAXONOMY.find((entry) => entry.id === typeId)?.ruleTags?.includes(tag) ?? false;
}

/** 该费用类型是否须先在 elab/wxzc 完成前置报账单（低耗→zcgl；云服务/AI 订阅→wxzc）。 */
export function elabPreapprovalFor(typeId: ExpenseTypeId): ElabPreapproval | undefined {
  return EXPENSE_TAXONOMY.find((entry) => entry.id === typeId)?.elab;
}

/** 财务流程组：同类费用共用一张报销单与同一前置流程（分组递交的依据）。 */
export type FinancialFlowGroup = "direct" | "csf" | "hc" | "fixed-asset";

export const FINANCIAL_FLOW_GROUPS: Record<FinancialFlowGroup, { label: string; hint: string }> = {
  direct: { label: "直接财务", hint: "无 elab 前置，财务系统直接开单" },
  csf: { label: "软件服务（CSF）", hint: "前置 wxzc 软件服务费报账单（同类可合并一单）" },
  hc: { label: "低值易耗品（HC）", hint: "前置 zcgl 材料易耗品低值品报账单（整单 ≥1 万装备处审批）" },
  "fixed-asset": { label: "固定资产", hint: "先设备申购+建卡验收，凭资产标签报账（非前置报账流程）" },
};

/** 费用 → 财务流程组：按 elab 前置声明派生，固定资产按学校采购流程单列。 */
export function financialFlowGroup(typeId: ExpenseTypeId): FinancialFlowGroup {
  if (typeId === "office-equipment") return "fixed-asset";
  const pre = elabPreapprovalFor(typeId);
  if (pre?.system === "wxzc") return "csf";
  if (pre?.system === "zcgl") return "hc";
  return "direct";
}
