import type {
  ReceiptCategory,
  Requirement,
  RequirementGroup,
} from "./types";
import { groupsFor, requirementsFor } from "./node-registry";

export const requirement = (
  id: string,
  label: string,
  hint: string,
  keywords: string[],
  optional = false,
  templateId?: Requirement["templateId"],
): Requirement => ({ id, label, hint, keywords, optional, templateId });

export const INTERNATIONAL_REQUIREMENTS: Requirement[] = [
  requirement("approval", "因公出国申请单", "外事系统审批通过后打印，作为报销凭证", ["因公出国申请单", "出国申请单"]),
  requirement("approval-notice", "出访批件", "学校或上级主管部门批复的出境批文，与申请单分属两种凭证", ["出访批件", "批件"]),
  requirement("invitation", "会议邀请", "邀请函及中文翻译", ["邀请函.pdf"]),
  requirement("registration", "注册费票据", "注册费发票或收据", [
    "注册费发票",
  ]),
  requirement("registration-payment", "支付凭证", "可随时补充注册费支付截图；金额超过门槛时必需", ["注册费支付", "注册支付"], true),
  requirement("registration-fee-list", "注册费用清单", "会议注册费标准或收费说明", ["会议注册费标准", "注册费用清单", "收费标准"]),
  {
    ...requirement("membership-invoice", "会员费收据", "如为参会新购或续费会员，附会员费收据", ["CCF会员", "IEEE会员", "ACM会员", "会员费发票", "会员费收据"], true),
    paymentProofKeywords: ["会员费支付", "会员支付"],
  },
  requirement("membership-payment", "支付凭证", "可随时补充会员费支付截图；金额超过门槛时必需", ["会员费支付", "会员支付"], true),
  requirement("membership-fee-list", "会员费标准清单", "如报销会员费，附会员等级与收费标准", ["会员费标准", "会员收费标准", "会员费清单"], true),
  requirement("outbound-transport", "去程国际交通凭证", "去程机票、电子行程单或订单", ["去程与返程机票行程单", "去程", "出发"]),
  requirement("return-transport", "返程国际交通凭证", "返程机票、电子行程单或订单", ["去程与返程机票行程单", "返程", "返回"]),
  requirement("airfare-invoice", "往返机票发票", "往返机票报销发票", ["往返机票发票"]),
  requirement("airfare-payment", "支付凭证", "可随时补充交通支付截图；金额超过门槛时必需", ["机票支付", "交通支付", "旅行社支付"], true),
  requirement("travel-insurance", "旅行保险发票", "如购买旅行保险，附保险发票", ["旅行保险发票"], true),
  requirement("hotel", "住宿发票", "境外住宿发票", ["住宿发票"]),
  requirement("hotel-payment", "支付凭证", "可随时补充住宿支付截图；金额超过门槛时必需", ["住宿支付", "酒店支付"], true),
  requirement("folio", "酒店水单", "住宿日期与房费明细", ["住宿水单"]),
  requirement("entry", "出入境记录", "护照首页及出入境记录", [
    "护照及出入境记录.pdf",
  ]),
  requirement("return", "结团确认单", "因公出国境结团确认单，作为出访完成后的报销凭证", [
    "因公出国境结团确认单",
    "结团确认单",
  ]),
  {
    ...requirement("consent", "因公出国知情同意书", "与结团确认单一并归档的报销凭证", ["知情同意书"]),
    templateId: "foreign-travel-consent",
  },
];

export const INTERNATIONAL_ATTACHMENTS: Requirement[] = [
  requirement("conference-agenda", "会议日程", "随项目归档，不计入报销必填", ["会议日程", "会议议程", "agenda"]),
  { ...requirement("return-summary", "归团总结报告", "结团确认单的前置文件；完成后随项目附件归档", ["归团总结报告"]), templateId: "return-summary" },
  requirement("overseas-talent-contact", "海外人才接洽情况表", "按本人学院的要求填写并提交", ["海外人才接洽情况表", "接洽海外高层次人才"]),
  requirement("overseas-visit-summary", "出国小结", "说明本次出访情况，按本人学院要求审核和提交", ["出国小结"]),
];

export const DOMESTIC_CONFERENCE_REQUIREMENTS: Requirement[] = requirementsFor("国内会议");

export const DOMESTIC_TRIP_REQUIREMENTS: Requirement[] = requirementsFor("国内差旅");

export const DAILY_REQUIREMENTS: Requirement[] = [
  requirement("chatgpt-receipt", "ChatGPT Pro 收据", "识别到该订阅后，需与支付记录成对", ["ChatGPT-Pro_收据", "ChatGPT Pro 收据"], true),
  requirement("chatgpt-payment", "ChatGPT Pro 支付记录", "识别到该订阅后，需与收据成对", ["ChatGPT-Pro_支付记录", "ChatGPT Pro 支付记录"], true),
  requirement("chatgpt-fee-schedule", "ChatGPT Pro 费用清单", "套餐价格或订阅费用截图", ["ChatGPT-Pro_套餐价格截图", "套餐价格截图", "ChatGPT Pro 套餐价格截图"], true),
  requirement("cloud-invoice", "六六云账单", "识别到该云服务后，需与支付记录成对", ["六六云_韩国云服务_账单", "六六云账单"], true),
  requirement("cloud-payment", "六六云支付记录", "识别到该云服务后，需与账单成对", ["六六云_韩国云服务_支付记录", "六六云支付记录"], true),
  requirement("cloud-fee-schedule", "云服务费用清单", "产品页面或服务价格截图", ["六六云_韩国云服务_产品页面截图", "产品页面截图"], true),
  // keywords 是无归类记录时的文件名兜底：必须同时含旧命名惯例（下划线连接）与 label 原文（空格分隔，
  // automaticClassificationName 现行口径）两种形态；「智谱华章」是 issuer 名——发票与支付记录都命中，已删
  // （2026-11-21 支付记录被兜底误挂到账单行实证）。
  requirement("zhipu-invoice", "智谱 BigModel 发票", "数电发票，需与支付记录成对", ["智谱BigModel_发票", "智谱 BigModel 发票", "智谱BigModel_账单", "智谱 BigModel 账单"], true),
  requirement("zhipu-payment", "智谱 BigModel 支付记录", "识别到该云服务后，需与发票成对", ["智谱BigModel_支付记录", "智谱 BigModel 支付记录"], true),
  requirement("zhipu-fee-schedule", "智谱 BigModel 费用清单", "套餐价格或费用清单截图", ["智谱BigModel_费用清单", "BigModel费用清单", "智谱 BigModel 费用清单"], true),
  requirement("ride-hailing-itinerary", "网约车行程单", "网约车报销时，提供对应行程单", ["网约车行程单", "滴滴行程单", "行程单"], true),
  requirement("ride-hailing-invoice", "网约车发票", "网约车报销时，提供对应发票（平台代开的出租车发票同为网约车凭证）", ["网约车发票", "滴滴发票", "打车发票", "出租车发票", "出租车"], true),
  requirement("office-supplies-invoice", "办公用品发票", "网购办公用品（文具、纸张、日用耗材等）的电子发票，直接走财务", ["办公用品发票", "办公耗材发票", "文具发票", "日用品发票"]),
  requirement("office-supplies-proof", "办公用品购买截图", "上海税务局监制的发票可免；其他省市发票必须提供", ["办公用品订单", "办公耗材订单", "文具订单"]),
  requirement("low-value-gear-invoice", "低值设备发票", "低值易耗设备（移动硬盘、扩展坞、台灯、随身WiFi 等）的电子发票；走财务前先完成 elab 材料易耗品报账", ["低值设备发票", "移动硬盘发票", "扩展坞发票", "台灯发票", "随身WiFi发票", "数据线发票", "转接头发票", "充电器发票", "U盘发票", "读卡器发票", "鼠标垫发票", "插线板发票"]),
  requirement("low-value-gear-proof", "低值设备购买截图", "上海税务局监制的发票可免；其他省市发票必须提供（订单详情页：商品、规格、单价、订单编号）", ["低值设备订单", "移动硬盘订单", "扩展坞订单", "台灯订单", "随身WiFi订单"]),
  requirement("low-value-gear-payment", "低值设备支付记录", "微信/支付宝等平台的账单详情或付款成功页（支付金额、交易状态、支付方式、交易单号）；单笔费用金额达到 CNY 1,000 时必需——多件合计达标同样适用；与购买截图不同——订单截图证明买了什么，支付记录证明实际付款", ["低值设备支付记录", "设备支付截图", "微信支付账单", "支付宝账单", "账单详情"], true),
  requirement("low-value-gear-elab", "elab 资产入账单", "低值设备 elab（zcgl）前置报账单：AI 填报 → 自动提交 → 自动审核 → 追踪通过后随财务报销单作为附件", ["elab", "资产入账单", "低值品报账单"], false, "preapproval"),
  requirement("cloud-services-csf", "软件服务费报账单", "软件/云服务 wxzc 前置报账单（科技处审核，同类可合并一单）", ["软件服务费", "软件服务费报账单"], false, "preapproval"),
];

const byId = (requirements: Requirement[], id: string) => {
  const requirementItem = requirements.find((item) => item.id === id);
  if (!requirementItem) throw new Error(`Missing requirement: ${id}`);
  return requirementItem;
};

export const ICME_REQUIREMENT_GROUPS: RequirementGroup[] = [
  {
    id: "air-travel",
    label: "往返国际交通",
    hint: "行程单、机票发票与支付凭证",
    requirements: [
      byId(INTERNATIONAL_REQUIREMENTS, "outbound-transport"),
      byId(INTERNATIONAL_REQUIREMENTS, "return-transport"),
      { ...byId(INTERNATIONAL_REQUIREMENTS, "airfare-invoice"), paymentProofKeywords: ["支付", "机票"] },
      byId(INTERNATIONAL_REQUIREMENTS, "airfare-payment"),
    ],
  },
  {
    id: "registration",
    label: "会议注册",
    hint: "发票、收费清单与高额支付凭证",
    requirements: [
      { ...byId(INTERNATIONAL_REQUIREMENTS, "registration"), paymentProofKeywords: ["注册费支付记录"] },
      byId(INTERNATIONAL_REQUIREMENTS, "registration-fee-list"),
      byId(INTERNATIONAL_REQUIREMENTS, "registration-payment"),
    ],
  },
  {
    id: "membership",
    label: "会员费",
    hint: "新购或续费会员时提供发票与收费标准",
    optional: true,
    requirements: [
      byId(INTERNATIONAL_REQUIREMENTS, "membership-invoice"),
      byId(INTERNATIONAL_REQUIREMENTS, "membership-fee-list"),
      byId(INTERNATIONAL_REQUIREMENTS, "membership-payment"),
    ],
  },
  {
    id: "hotel",
    label: "住宿",
    hint: "住宿发票、水单与支付凭证",
    requirements: [
      { ...byId(INTERNATIONAL_REQUIREMENTS, "hotel"), paymentProofKeywords: ["支付", "住宿"] },
      byId(INTERNATIONAL_REQUIREMENTS, "folio"),
      byId(INTERNATIONAL_REQUIREMENTS, "hotel-payment"),
    ],
  },
  {
    id: "travel-approval",
    label: "出访与出入境",
    hint: "审批、出入境、知情同意与归团材料",
    requirements: [
      byId(INTERNATIONAL_REQUIREMENTS, "approval"),
      byId(INTERNATIONAL_REQUIREMENTS, "approval-notice"),
      byId(INTERNATIONAL_REQUIREMENTS, "invitation"),
      byId(INTERNATIONAL_REQUIREMENTS, "entry"),
      byId(INTERNATIONAL_REQUIREMENTS, "consent"),
      byId(INTERNATIONAL_REQUIREMENTS, "return"),
    ],
  },
  {
    id: "travel-insurance",
    label: "旅行保险",
    hint: "购买保险时提供保险发票",
    optional: true,
    requirements: [byId(INTERNATIONAL_REQUIREMENTS, "travel-insurance")],
  },
];

export const DOMESTIC_CONFERENCE_GROUPS: RequirementGroup[] = groupsFor("国内会议");

export const DOMESTIC_TRIP_GROUPS: RequirementGroup[] = groupsFor("国内差旅");

/** 日常工作流快照版本：拆组/加节点时 +1，存量票据集按 upgradeLegacyLineRequirements 自动对齐。 */
export const DAILY_WORKFLOW_VERSION = 4;

export const DAILY_REQUIREMENT_GROUPS: RequirementGroup[] = [
  {
    id: "cloud-services",
    label: "云服务",
    hint: "订阅或云服务的账单/收据、支付记录与费用清单",
    optional: true,
    requirements: DAILY_REQUIREMENTS.filter((item) => ["chatgpt-receipt", "chatgpt-payment", "chatgpt-fee-schedule", "cloud-invoice", "cloud-payment", "cloud-fee-schedule", "zhipu-invoice", "zhipu-payment", "zhipu-fee-schedule", "cloud-services-csf"].includes(item.id)),
  },
  {
    id: "local-transport",
    label: "市内交通",
    hint: "网约车：行程单与发票；出租车：仅发票",
    optional: true,
    requirements: DAILY_REQUIREMENTS.filter((item) => ["ride-hailing-itinerary", "ride-hailing-invoice"].includes(item.id)),
  },
  {
    id: "office-supplies",
    label: "办公用品",
    hint: "直接走财务；上海监制发票可免截图",
    optional: true,
    requirements: DAILY_REQUIREMENTS.filter((item) => ["office-supplies-invoice", "office-supplies-proof"].includes(item.id)),
  },
  {
    id: "low-value-gear",
    label: "低值易耗设备",
    hint: "先 elab（zcgl）报账再走财务；外省发票须配截图",
    optional: true,
    requirements: DAILY_REQUIREMENTS.filter((item) => ["low-value-gear-invoice", "low-value-gear-proof", "low-value-gear-payment", "low-value-gear-elab"].includes(item.id)),
  },
];

export const DAILY_CATEGORIES: ReceiptCategory[] = [
  "AI 订阅",
  "云服务",
  "市内交通",
  "办公用品",
  "低值易耗品",
  "图书资料",
  "知识产权",
  "其他",
];
