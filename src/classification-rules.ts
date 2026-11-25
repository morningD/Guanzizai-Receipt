import { validPaymentDate } from "./cloud-payment";
import type { ClassificationAssignment, ReceiptMeta } from "./types";

export function forcedClassificationRequirement(text: string, availableIds: Set<string>) {
  const normalized = text.replace(/\s+/g, " ");
  if (
    availableIds.has("transport-invoice")
    && /电子发票/.test(normalized)
    && /(航空运输电子客票行程单|铁路电子客票)/.test(normalized)
  ) return "transport-invoice";

  // 旅行社开具的交通电子发票（代订机票/退改费等）是发票而非支付截图，必须进交通发票。
  if (
    availableIds.has("transport-invoice")
    && /电子发票|数电发票/.test(normalized)
    && /(代订机票|代订交通|退改|机票|航空旅客|铁路)/.test(normalized)
  ) return "transport-invoice";

  if (
    availableIds.has("membership-receipt")
    && /\b(?:ACM|IEEE|CCF)\b/i.test(normalized)
    && /\bReceipt\b|Receipt Detail|Amount Paid|Payment Information/i.test(normalized)
  ) return "membership-receipt";

  if (
    availableIds.has("zhipu-invoice")
    && /智谱华章|智谱\s*BigModel|BigModel/i.test(normalized)
    && /数电发票|电子发票|增值税(?:专用|普通)发票/.test(normalized)
    && /发票号码|开票日期|价税合计/.test(normalized)
    // 支付截图（实付金额/付款方式/交易单号）不是发票，交给语义层配对支付记录。
    && !/实付金额|付款方式|交易单号|支付时间/.test(normalized)
  ) return "zhipu-invoice";

  // elab 报账单（版式固定：标题 + 报账单编号 + 承诺文案），按单号前缀分流 HC=低值品 / CSF=软件服务费。
  if (
    availableIds.has("low-value-gear-elab")
    && /HC\d{7}/.test(normalized)
    && /(材料、?\s*易耗品、?\s*低值品报账单|报账单编号)/.test(normalized)
  ) return "low-value-gear-elab";

  if (
    availableIds.has("cloud-services-csf")
    && (/CSF\d{7}/.test(normalized) || /软件服务费报账单/.test(normalized))
    && /(报账单编号|软件服务费)/.test(normalized)
  ) return "cloud-services-csf";

  return "";
}

/** elab 报账单单号提取：HC（材料易耗品低值品）/ CSF（软件服务费）。 */
export function elabBillNoFromText(text: string): string {
  return text.match(/(?:HC|CSF)\d{7}/)?.[0] ?? "";
}

/** elab 报账单总价提取：紧邻「总价」后的金额。 */
export function elabTotalFromText(text: string): string {
  const normalized = text.replace(/\s+/g, "");
  return normalized.match(/总价[大写]?(\d+(?:\.\d{1,2})?)/)?.[1] ?? "";
}

/** elab 报账单是否已审核通过（审核意见含「经费负责人审批 通过」或状态「已审核」）。 */
export function elabApprovedFromText(text: string): boolean {
  return /经费负责人审批\s*通过/.test(text.replace(/\s+/g, "")) || /已审核/.test(text);
}

/**
 * 铁路电子客票发票：全国统一固定版式，本地文本解析即可 100% 识别，不依赖 AI。
 * 版式特征：标题"电子发票（铁路电子客票）"+ 发票号码 + 出发/到达站 + 车次 + 开车时间 + 票价。
 * pdftotext 提取该版式输出全角字符（２０２６、Ｇ２６、￥６６１．００），fitz 输出半角；先归一化再解析。
 */
export function parseRailwayInvoice(rawText: string): { invoiceNo: string; from: string; to: string; trainNo: string; date: string; amount: number } | null {
  const text = rawText.replace(/[０-９Ａ-Ｚａ-ｚ：．（）]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  if (!/电子发票[（(]铁路电子客票[）)]/.test(text)) return null;
  const invoiceNo = text.match(/发票号码[:：]\s*(\d{20})/)?.[1] ?? "";
  const amount = Number(text.match(/￥\s*(\d+(?:\.\d+)?)|票价[:：]\s*(\d+(?:\.\d+))/)?.slice(1).find(Boolean) ?? Number.NaN);
  const stationPattern = /([\u4e00-\u9fa5]{2,10}(?:站|虹桥|南|北|东|西|西站|东站|南站|北站))\s*(?:Station)?/g;
  const stations: string[] = [];
  for (let match = stationPattern.exec(text); match; match = stationPattern.exec(text)) stations.push(match[1]);
  // 版式里两站名先出发后到达；取文本顺序前两个互不相同的站名。
  const from = stations[0] ?? "";
  let to = "";
  for (const station of stations.slice(1)) { if (station !== from) { to = station; break; } }
  const trainNo = text.match(/\b([GDC]\d{1,5})\b/)?.[1] ?? "";
  // 版式中开票日期在前、乘车日期在后；乘车日期带"HH:MM开"的开车时间，以此锚定。
  const date = text.match(/(\d{4}年\d{2}月\d{2}日)\s*\d{1,2}:\d{2}开/)?.[1]?.replace(/年|月/g, "-").replace("日", "") ?? text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
  if (!from || !to) return null;
  return { invoiceNo, from, to, trainNo, date, amount: Number.isFinite(amount) ? amount : Number.NaN };
}

/** 方向判定：出发站是常住地→去程；到达站是常住地→返程。站名用"包含"匹配（常住地"上海"匹配"上海虹桥"）。 */
export function railwayTravelDirection(from: string, to: string, homeCity: string): "outbound" | "return" | "" {
  if (homeCity && from.includes(homeCity)) return "outbound";
  if (homeCity && to.includes(homeCity)) return "return";
  return "";
}

/**
 * 已归类文件的排他归属例外：铁路电子客票发票一张顶两张（交通发票 + 对应方向的乘車凭证）。
 * workflow.ts / App.tsx / store.ts 三处归属判定共用，保证流程图、进度环与递交检查一致。
 */
export function classifiedFileAlsoMatches(classifiedId: string, requirementId: string, filename: string): boolean {
  if (classifiedId !== "transport-invoice") {
    // 往返订单/行程单一张顶两张：归类到任一方向交通凭证、文件名含"往返"时，另一方向也点亮。
    return (classifiedId === "outbound-transport" || classifiedId === "return-transport")
      && (requirementId === "outbound-transport" || requirementId === "return-transport")
      && classifiedId !== requirementId
      && filename.includes("往返");
  }
  if (requirementId !== "outbound-transport" && requirementId !== "return-transport") return false;
  if (!filename.includes("铁路电子客票")) return false;
  return requirementId === "outbound-transport" ? filename.includes("去程") : filename.includes("返程");
}

/**
 * 无归类历史票据按文件名推断归属节点：票据名前缀决定配对方向，避免人工命名的历史文件配不上对。
 * 已有归类（workflowNodeId）时优先返回原值；推断不出返回空串。
 */
export function inferEvidenceNodeId(typeId: string, workflowNodeId: string | undefined, filename: string): string {
  if (workflowNodeId) return workflowNodeId;
  const name = filename.split("/").pop() ?? "";
  if (typeId === "payment-proof") {
    if (/注册费支付|注册支付/.test(name)) return "registration-payment";
    if (/会员费支付|会员支付/.test(name)) return "membership-payment";
    if (/住宿支付|酒店&支付|酒店支付/.test(name)) return "hotel-payment";
    if (/机票支付|交通支付|旅行社/.test(name)) return "transport-payment";
    if (/云服务|BigModel/.test(name)) return "cloud-payment";
    return "";
  }
  if (typeId === "fee-schedule") {
    if (/注册费.*清单|收费标准/.test(name)) return "registration-fee-list";
    if (/会员费标准|会员费清单/.test(name)) return "membership-fee-list";
    if (/智谱|bigmodel/i.test(name)) return "zhipu-fee-schedule";
    if (/chatgpt|openai/i.test(name)) return "chatgpt-fee-schedule";
    if (/套餐价格|订阅价格/.test(name)) return "chatgpt-fee-schedule";
    if (/产品页面|服务价格/.test(name)) return "cloud-fee-schedule";
  }
  return "";
}

/** 发票金额本地兜底：AI 未给出金额时，从发票文本的"价税合计/小写金额"抓取。 */
export function invoiceTotalFromText(text: string): string {
  if (!text) return "";
  // （小写）¥ 后紧跟价税合计，优先于"价税合计"后的不含税"金额"字段，避免误抓税前值。
  for (const pattern of [
    /[（(]\s*小写\s*[）)]\s*[¥￥]?\s*([0-9]+(?:\.[0-9]+)?)/,
    /[¥￥]\s*([0-9]+\.[0-9]{2})\s*$/m,
  ]) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}

/** 数电发票项目行末依次为不含税金额、税率和税额。 */
export function invoiceRebookingFeeFromText(text: string): number | undefined {
  const rows = text.normalize("NFKC").split(/\r?\n/).flatMap((line) => {
    if (!/退改费|改签费/.test(line)) return [];
    const match = line.match(/(?<![\d.,-])([\d,]+\.\d{2})\s+(?:\d+(?:\.\d+)?%)\s+([\d,]+\.\d{2})\s*$/);
    return match ? [Number(match[1].replaceAll(",", "")) + Number(match[2].replaceAll(",", ""))] : [];
  });
  const total = rows.reduce((sum, amount) => sum + amount, 0);
  return Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : undefined;
}

export function classifiedReceiptMetadata(previous: ReceiptMeta | undefined, assignment: ClassificationAssignment): ReceiptMeta {
  const rawAmount = assignment.amount?.replace(/[,\s]/g, "");
  const amount = rawAmount ? Number(rawAmount) : NaN;
  const paymentDateBlocked = assignment.paymentDateBlocked ?? previous?.paymentDateBlocked;
  return {
    ...previous,
    classifiedRequirementId: assignment.requirementId,
    classifiedWorkflowNodeId: assignment.requirementId,
    classificationReason: assignment.reason ?? previous?.classificationReason,
    invoiceDate: validPaymentDate(assignment.documentDate) ?? previous?.invoiceDate,
    paymentDateBlocked,
    paymentDate: paymentDateBlocked ? undefined : validPaymentDate(assignment.paymentDate) ?? previous?.paymentDate,
    ...(assignment.flightSegments ? { flightSegments: assignment.flightSegments } : {}),
    ...(Number.isFinite(assignment.rebookingFeeAmount) && assignment.rebookingFeeAmount! > 0
      ? { rebookingFeeAmount: assignment.rebookingFeeAmount } : {}),
    issuer: assignment.issuer?.trim() || previous?.issuer,
    amount: Number.isFinite(amount) ? amount : previous?.amount,
    currency: ["CNY", "USD", "SGD", "AED", "THB", "EUR", "JPY", "HKD", "GBP"].includes(assignment.currency ?? "")
      ? assignment.currency as ReceiptMeta["currency"] : previous?.currency,
  };
}
