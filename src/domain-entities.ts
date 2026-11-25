export type DomainEntityId =
  | "reimbursement-set"
  | "expense"
  | "evidence"
  | "evidence-link"
  | "exchange-rate-cache"
  | "workflow";

export type DomainEntity = {
  id: DomainEntityId;
  label: string;
  formalName: string;
  definition: string;
  attributes: Array<{ name: string; meaning: string }>;
  relations: string[];
};

/** 运行时模型中可被规则、流程与分类体系共同引用的实体目录。 */
export const DOMAIN_ENTITIES: DomainEntity[] = [
  {
    id: "reimbursement-set",
    label: "票据集",
    formalName: "ReimbursementSet",
    definition: "一次可独立递交、观察和归档的报销事项，例如一次会议或一批日常票据。",
    attributes: [
      { name: "id", meaning: "稳定身份" },
      { name: "kind", meaning: "国际会议、国内会议、国内差旅或日常" },
      { name: "status", meaning: "进行中、已递交或已归档" },
    ],
    relations: ["一个票据集包含多笔 Expense", "一个票据集选择一个 Workflow"],
  },
  {
    id: "expense",
    label: "支出事项",
    formalName: "Expense",
    definition: "一笔独立、可报销的实际消费或付款，例如一次酒店住宿、一次会议注册或一个月的 AI 订阅。金额规则始终对 Expense 求值，而不是对文件求值。",
    attributes: [
      { name: "amount + currency", meaning: "原始金额及币种" },
      { name: "amountCny", meaning: "按该笔消费锁定汇率折合的人民币金额" },
      { name: "typeId", meaning: "费用事项分类，例如 lodging 或 conference-registration" },
      { name: "status", meaning: "草稿、已识别、待汇率、可递交、已递交或已归档" },
    ],
    relations: ["属于一个 ReimbursementSet", "通过 EvidenceLink 关联一份或多份 Evidence", "使用 ExchangeRateCache 锁定外币换算"],
  },
  {
    id: "evidence",
    label: "材料证据",
    formalName: "Evidence",
    definition: "本机的一份原始文件，例如发票、收据、行程单、水单、支付截图或会议日程。内容哈希而非文件名决定其身份。",
    attributes: [
      { name: "contentHash", meaning: "文件内容身份；改名或移动后仍可识别" },
      { name: "typeId", meaning: "证据类型，例如 invoice、payment-proof 或 itinerary" },
      { name: "extracted", meaning: "识别出的金额、币种、商户和日期" },
    ],
    relations: ["可通过 EvidenceLink 支持一笔或多笔 Expense", "payment-proof 是 Evidence 的一种 typeId，不是独立实体"],
  },
  {
    id: "evidence-link",
    label: "证据关联",
    formalName: "EvidenceLink",
    definition: "将一份 Evidence 明确关联到一笔 Expense，并说明它在该笔支出中的角色。它避免把同一支付截图误用于不相关支出。",
    attributes: [
      { name: "evidenceId", meaning: "被引用的材料证据" },
      { name: "expenseId", meaning: "被支持的支出事项" },
      { name: "role", meaning: "主票据、支付凭证、行程单、水单、收费标准、说明或归档附件" },
    ],
    relations: ["连接 Evidence 与 Expense", "高额支付凭证规则要求 role = payment 且关联到同一 Expense"],
  },
  {
    id: "exchange-rate-cache",
    label: "汇率缓存",
    formalName: "ExchangeRateCache",
    definition: "按“1 外币 = CNY”的统一口径保存的本地换算数据，用于建立 Expense 时计算 amountCny。",
    attributes: [
      { name: "currency + cnyRate", meaning: "币种与折合人民币汇率" },
      { name: "source", meaning: "本位币、初始参考、在线缓存或手动覆盖" },
      { name: "effectiveDate", meaning: "汇率源的生效日期" },
    ],
    relations: ["Expense 在创建时锁定该汇率快照", "更新缓存不回算已有 Expense"],
  },
  {
    id: "workflow",
    label: "流程定义",
    formalName: "Workflow",
    definition: "票据集类型对应的可执行流程图，定义材料节点、前置关系、成对关系和条件触发关系。",
    attributes: [
      { name: "nodes", meaning: "材料、附件、外部动作或递交节点" },
      { name: "edges", meaning: "前置、产出、成对、触发或归档关联" },
      { name: "version", meaning: "流程定义的版本号" },
    ],
    relations: ["被 ReimbursementSet 选用", "节点可引用费用和证据 taxonomy，并受 Rule 约束"],
  },
];
