import { filenamePart } from "./filename-utils";
import { validPaymentDate } from "./cloud-payment";

export function suggestImportedFilename(filename: string, extractedText: string, destinationFolder = "") {
  if (!filename.toLowerCase().endsWith(".pdf")) return null;

  if (extractedText.includes("因公出国境结团确认单")) {
    const returnDate = extractedText.match(/实际回国日期[\s\S]{0,180}?(\d{4})\s+(\d{1,2})\s+(\d{1,2})/)?.slice(1);
    if (!returnDate) return null;
    const [year, month, day] = returnDate;
    const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const prefix = destinationFolder.includes("ICME泰国学术会议") ? "ICME泰国_" : "";
    return `${date}_${prefix}因公出国境结团确认单.pdf`;
  }

  if (!extractedText.includes("全国性社会团体会费统一票据") || !extractedText.includes("中国计算机学会")) return null;

  const date = extractedText.match(/开票日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1];
  const amount = extractedText.match(/金额（元）\s*([0-9]+(?:\.[0-9]{1,2})?)/)?.[1];
  if (!date || !amount) return null;

  return `${date}_CCF_会员费收据_CNY${Number(amount).toFixed(2)}.pdf`;
}

export type ClassificationNaming = {
  /** 旧文件扩展名（含点），如 ".jpg"；命名重建不改变文件格式。 */
  ext: string;
  documentDate?: string;
  paymentDate?: string;
  issuer?: string;
  amount?: string;
  currency?: string;
  /** AI 每次重新生成的自由备注段（≤12 字，如会议简称、"往返合一"）；不从旧文件名继承。 */
  note?: string;
  /** 商品品名（发票明细，如 扩展坞/移动硬盘）——让文件名直接可见"买了什么"。 */
  goodsName?: string;
};

/**
 * AI 归类后的规范文件名：整体重新生成，旧文件名不参与（堆叠物理上不可能）。
 * 结构：日期_主体_类别_备注_金额.ext；自由备注也是本轮 AI 输出，非旧名残留。
 */
export function automaticClassificationName(label: string, info: ClassificationNaming) {
  const ext = info.ext || "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(info.documentDate ?? "") ? `${info.documentDate}_` : "";
  const safeLabel = filenamePart(label);
  const safeIssuer = info.issuer ? filenamePart(info.issuer) : "";
  const numericAmount = info.amount?.replace(/[^0-9.]/g, "") ?? "";
  const safeCurrency = /^(CNY|USD|SGD|EUR|THB)$/i.test(info.currency ?? "") ? info.currency!.toUpperCase() : "";
  const amountPart = numericAmount && safeCurrency ? `${safeCurrency}${numericAmount}` : "";
  const safeNote = info.note ? filenamePart(info.note).slice(0, 24) : "";
  const safeGoodsName = info.goodsName ? filenamePart(info.goodsName).slice(0, 12) : "";
  const paymentDate = validPaymentDate(info.paymentDate);
  const paymentMonth = paymentDate ? `${Number(paymentDate.slice(5, 7))}月付款` : "";
  return `${date}${[safeIssuer, safeGoodsName, safeLabel, paymentMonth, safeNote, amountPart].filter(Boolean).join("_") || safeLabel}${ext}`;
}
