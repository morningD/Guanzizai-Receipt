import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants, createReadStream, existsSync, promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { existsSync as fsSyncExists, readFileSync as fsReadSync, copyFileSync as fsCopySync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { classifiedReceiptMetadata, elabApprovedFromText, elabBillNoFromText, elabTotalFromText, forcedClassificationRequirement, invoiceTotalFromText, invoiceRebookingFeeFromText, parseRailwayInvoice, railwayTravelDirection } from "../src/classification-rules";
import { flightSegmentsFromText, normalizeFlightSegments } from "../src/flight-segments";
import { FINANCE_ATTACHMENT_LIMIT } from "../src/reimbursement-policy";
import { applySearchReply, feeScheduleCandidates, isFeeScheduleLike, parseEvidenceSearchReply, type EvidenceIndexItem } from "../src/evidence-search";
import { automaticClassificationName, suggestImportedFilename, type ClassificationNaming } from "../src/import-naming";
import { cloudPaymentDateForImport, cloudPaymentNodeKind, readCloudPaymentDate, validPaymentDate } from "../src/cloud-payment";
import type { ClassificationAssignment, ReceiptMeta } from "../src/types";
import { filenamePart } from "../src/filename-utils";
import { dedupeExpenses, type DedupeExpenseLike } from "../src/dedupe-expenses";
import { withoutCrossSetSupportLinks, type FormalModelState } from "../src/formal-model";
import { canArchivePostedLine, isArchiveLocked, lineTreasuryBills, mergeTreasurySnapshot, restoreArchiveDestination } from "../src/treasury-sync";
import { elabPreapprovalFor, EXPENSE_TAXONOMY } from "../src/expense-taxonomy";
import { quarterKeyOf, quarterOfKey, DF_DEFAULT_SPECIAL_DEDUCTION } from "../src/df";
import { isLaborGenerationDue, laborMonthKey, laborRowsFromMembers, parseLaborMonthKey, type LaborMember } from "../src/labor";
import { expenseCollectionLabel, NODE_BINDINGS, workflowForLine } from "../src/workflows";
import { DAILY_REQUIREMENT_GROUPS, DAILY_REQUIREMENTS, DAILY_WORKFLOW_VERSION } from "../src/data";
import { emptyDelivery, normalizeFirstRunInput } from "../src/first-run";
import { emptyUserProfile } from "../src/user-profile";
import { createCredentialStore } from "./credential-store";
import { runSchoolPython, runSchoolScript, schoolCodeRoot, schoolRuntimeStatus, startSchoolScript } from "./school-runtime";
import { parseDeveloperLogSettings } from "../src/log-settings";
import { createDiagnostics } from "./diagnostics";
import { createVisionSample } from "./vision-sample";

const serverRoot = path.resolve(process.env.RECEIPT_DATA_ROOT || process.cwd());
const developerLogs = process.env.RECEIPT_RUNTIME !== "portable";
export const diagnostics = createDiagnostics(serverRoot, undefined, developerLogs);
const credentials = createCredentialStore(serverRoot, schoolCodeRoot);

const MATERIAL_ROOTS = ["01_报销材料"];
const API_KEYCHAIN_SERVICE = "guanzizai-receipt-openai-api-key";
const SCHOOL_SSO_KEYCHAIN_SERVICE = "guanzizai-receipt-school-sso-password";
const LEGACY_FINANCE_KEYCHAIN_SERVICE = "guanzizai-receipt-finance-password";
const LEGACY_FOREIGN_AFFAIRS_KEYCHAIN_SERVICE = "guanzizai-receipt-foreign-affairs-password";
const ECNU_PORTAL_URL = "https://portal2023.ecnu.edu.cn/portal/home";
const CODEX_MODELS_CACHE = path.join(homedir(), ".codex", "models_cache.json");
const CODEX_RUNTIME_DIRECTORY = path.join(tmpdir(), "guanzizai-codex-runtime");
const CODEX_MINIMAL_HOME = path.join(CODEX_RUNTIME_DIRECTORY, "codex-home");
const OPENCODE_RUNTIME_DIRECTORY = path.join(tmpdir(), "guanzizai-opencode-runtime");
const OPENCODE_MODELS_CACHE_FILENAME = "opencode-models-cache.json";
const AI_SETTINGS_FILENAME = "ai-settings.json";
const FORMAL_MODEL_FILENAME = path.join("data", "reimbursement-model.json");
const PRINT_SETTINGS_FILENAME = path.join(".guanzizai", "print-settings.json");
const PRINT_LOG_FILENAME = path.join(".guanzizai", "print-log.json");
/** CUPS 可直接打印的材料格式；docx/ofd 等需先导出 PDF。 */
const PRINTABLE_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const EXCHANGE_RATE_API = "https://api.frankfurter.dev/v2/rates";
const ONLINE_RATE_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "HKD", "SGD", "THB", "AED"] as const;
const TEMPLATE_LIBRARY = path.join(serverRoot, "01_报销材料", "99_政策与模板", "02_报销模板");
const TEMPLATE_SOURCES = {
  "foreign-travel-consent": {
    source: path.join(TEMPLATE_LIBRARY, "因公出国知情同意书_外事系统模板.docx"),
    filename: "因公出国知情同意书.docx",
  },
  "traffic-explanation": {
    source: path.join(TEMPLATE_LIBRARY, "交通情况说明_跨城网约车说明模板.docx"),
    filename: "交通情况说明.docx",
  },
  "return-summary": {
    source: process.env.RECEIPT_RUNTIME === "portable"
      ? path.join(TEMPLATE_LIBRARY, "归团总结报告.docx")
      : path.join(serverRoot, "01_报销材料", "10_办理中", "2026-07_ICME泰国学术会议", "04_归团材料_待完成", "2026-07_ICME_归团总结报告_模板.docx"),
    filename: "归团总结报告.docx",
  },
} as const;

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".ofd",
  ".jpg",
  ".jpeg",
  ".png",
  ".doc",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
]);

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".ofd": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain; charset=utf-8",
};

const execFileAsync = promisify(execFile);
let browserInstall: Promise<void> | null = null;
let browserInstallError = "";

/** Vite 从 Finder/登录项启动时，PATH 往往不包含 nvm；显式解析 Codex CLI。 */
async function resolveCodexExecutable() {
  const direct = [
    process.env.CODEX_BIN,
    path.join(path.dirname(process.execPath), "codex"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of direct) if (existsSync(candidate)) return candidate;

  const nvmRoot = path.join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = await fs.readdir(nvmRoot, { withFileTypes: true });
    const candidates = versions
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(nvmRoot, entry.name, "bin", "codex"))
      .filter(existsSync)
      .sort()
      .reverse();
    if (candidates[0]) return candidates[0];
  } catch { /* nvm is optional. */ }
  throw new Error("未找到 Codex CLI；请安装 Codex，或设置 CODEX_BIN 为其绝对路径");
}

function finalCodexMessage(stdout: string, allowUnfinished = false) {
  const markers = Array.from(stdout.matchAll(/(?:^|\n)codex\r?\n/g));
  const marker = markers[markers.length - 1];
  if (!marker || marker.index == null) return "";
  const response = stdout.slice(marker.index + marker[0].length);
  const ending = response.search(/\n(?:hook:|tokens used)/);
  return (ending >= 0 ? response.slice(0, ending) : allowUnfinished ? response : "").trim();
}

async function runCodexCli(args: string[], timeout: number, promptFromStdin = "") {
  await fs.mkdir(CODEX_RUNTIME_DIRECTORY, { recursive: true });
  // Keep the user's authentication, but isolate this background task from the
  // interactive Codex configuration (MCP servers and skills can block a short task).
  await fs.mkdir(CODEX_MINIMAL_HOME, { recursive: true });
  await fs.copyFile(path.join(homedir(), ".codex", "auth.json"), path.join(CODEX_MINIMAL_HOME, "auth.json"));
  // Model metadata is non-sensitive and avoids a remote refresh on each short-lived call.
  await fs.copyFile(path.join(homedir(), ".codex", "models_cache.json"), path.join(CODEX_MINIMAL_HOME, "models_cache.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs.writeFile(path.join(CODEX_MINIMAL_HOME, "config.toml"), "model_reasoning_effort = \"low\"\n", { mode: 0o600 });
  return new Promise<string>((resolve, reject) => {
    const isolatedArgs = args[0] === "exec"
      ? ["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--color", "never", ...args.slice(1)]
      : args;
    const start = async () => {
      const executable = await resolveCodexExecutable();
      return spawn(executable, isolatedArgs, { cwd: CODEX_RUNTIME_DIRECTORY, env: { ...process.env, CODEX_HOME: CODEX_MINIMAL_HOME }, stdio: ["pipe", "pipe", "pipe"] });
    };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const responseFromOutput = (allowUnfinished = false) => finalCodexMessage(`${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`, allowUnfinished);
    const resolveIfComplete = () => {
      const response = responseFromOutput();
      if (response) finish(() => resolve(response));
    };
    let child: ReturnType<typeof spawn> | undefined;
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
      finish(() => reject(new Error("Codex CLI 响应超时")));
    }, timeout);
    void start().then((started) => {
      child = started;
      started.stdin?.end(promptFromStdin);
      started.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        resolveIfComplete();
      });
      started.stderr?.on("data", (chunk: Buffer) => { stderr.push(chunk); resolveIfComplete(); });
      started.once("error", (error) => finish(() => reject(error)));
      started.once("close", (code) => {
        const response = responseFromOutput(true);
        if (response) {
          finish(() => resolve(response));
          return;
        }
        const message = Buffer.concat(stderr).toString("utf8").trim();
        finish(() => reject(new Error(message || (code === 0 ? "Codex CLI 未返回模型输出" : "Codex CLI 执行失败"))));
      });
    }).catch((error) => finish(() => reject(error)));

    // Prompts are normally positional; visual batches use stdin after a `-- -` separator.
  });
}

function stripAnsiCodes(value: string) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Vite 从 Finder/登录项启动时，PATH 往往不包含用户级安装目录；显式解析 opencode CLI。 */
async function resolveOpencodeExecutable() {
  const direct = [
    process.env.OPENCODE_BIN,
    path.join(homedir(), ".opencode", "bin", "opencode"),
    path.join(homedir(), ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of direct) if (existsSync(candidate)) return candidate;

  const nvmRoot = path.join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = await fs.readdir(nvmRoot, { withFileTypes: true });
    const candidates = versions
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(nvmRoot, entry.name, "bin", "opencode"))
      .filter(existsSync)
      .sort()
      .reverse();
    if (candidates[0]) return candidates[0];
  } catch { /* nvm is optional. */ }
  throw new Error("未找到 opencode CLI；请安装 opencode，或设置 OPENCODE_BIN 为其绝对路径");
}

/** `opencode run --format json` 输出 NDJSON 事件流；拼接全部 text 事件即模型回复。 */
function finalOpencodeMessage(stdout: string) {
  return stdout
    .split("\n")
    .map((line) => {
      try {
        const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
        return event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string" ? event.part.text : "";
      } catch {
        return "";
      }
    })
    .join("")
    .trim();
}

async function runOpencodeCli(args: string[], timeout: number) {
  await fs.mkdir(OPENCODE_RUNTIME_DIRECTORY, { recursive: true });
  return new Promise<string>((resolve, reject) => {
    // `--pure` skips external plugins while keeping the global model configuration
    // and credentials in ~/.config/opencode, so short tasks start without MCP delays.
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
      finish(() => reject(new Error("opencode CLI 响应超时")));
    }, timeout);
    void resolveOpencodeExecutable().then((executable) => {
      child = spawn(executable, ["run", "--pure", "--format", "json", ...args], { cwd: OPENCODE_RUNTIME_DIRECTORY, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => {
        const response = finalOpencodeMessage(Buffer.concat(stdout).toString("utf8"));
        if (response) {
          finish(() => resolve(response));
          return;
        }
        const message = stripAnsiCodes(`${Buffer.concat(stderr).toString("utf8")}\n${Buffer.concat(stdout).toString("utf8")}`).trim();
        finish(() => reject(new Error(message.slice(-400) || (code === 0 ? "opencode CLI 未返回模型输出" : "opencode CLI 执行失败"))));
      });
    }).catch((error) => finish(() => reject(error)));
  });
}

type MaterialFile = {
  path: string;
  name: string;
  folder: string;
  ext: string;
  size: number;
  modifiedAt: string;
  contentHash: string;
};

async function fileContentHash(absolutePath: string) {
  return createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
}

/** 从发票文本抽商品品名：数电/电子发票明细形如 *分类目录*品名*规格，取第一个非空的 *…* 段。 */
function goodsNameFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const matches = [...text.matchAll(/\*([^*\n]{2,12})\*/g)].map((match) => match[1].trim()).filter((part) => part && !/^(\d+(\.\d+)?|小计|合计|税率|税额)%?$/.test(part));
  return matches[0] || undefined;
}

function toPosix(filePath: string) {
  return filePath.split(path.sep).join("/");
}

async function* materialPaths(root: string, directory: string): AsyncGenerator<string> {
  const absoluteDirectory = path.join(root, directory);
  if (!existsSync(absoluteDirectory)) return;
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = toPosix(path.join(directory, entry.name));
    if (entry.isDirectory()) {
      yield* materialPaths(root, relativePath);
    } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield relativePath;
    }
  }
}

async function scanDirectory(root: string, directory: string): Promise<MaterialFile[]> {
  const files: MaterialFile[] = [];
  for await (const relativePath of materialPaths(root, directory)) {
    const absolutePath = path.join(root, relativePath);
    const stat = await fs.stat(absolutePath);
    const isSymbolicLink = (await fs.lstat(absolutePath)).isSymbolicLink();
    files.push({
      path: relativePath,
      name: path.basename(relativePath),
      folder: relativePath.split("/").slice(0, -1).join("/"),
      ext: path.extname(relativePath).slice(1).toLowerCase(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      contentHash: await fileContentHash(absolutePath),
      ...(isSymbolicLink ? { isSymbolicLink } : {}),
    });
  }

  return files;
}

function formalModelPath(root: string) {
  return path.join(root, FORMAL_MODEL_FILENAME);
}

/** 数据文件原子写：唯一临时名 + rename，防并发 PUT 交错把文件写成两段拼接的损坏 JSON。 */
async function atomicWriteJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(tmp, file);
}

// Every in-process receipt metadata read/modify/write must see the previous completed write.
let receiptMetaWrites: Promise<unknown> = Promise.resolve();
function withReceiptMetaWrite<T>(update: () => Promise<T>): Promise<T> {
  const pending = receiptMetaWrites.then(update);
  receiptMetaWrites = pending.catch(() => undefined);
  return pending;
}

async function readFormalModel(root: string) {
  try {
    const value = JSON.parse(await fs.readFile(formalModelPath(root), "utf8")) as unknown;
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 手工标注字段：系统 OCR 拒绝解析（日配额/重复票）时，e2e 用这些字段自动填「手工标注」表单。 */
type InvoiceMetaField = {
  path: string; name: string; invoiceType: string; invoiceNo: string;
  invoiceDate: string; saleName: string; buyerName: string; total: string;
  source: "pdf-text" | "vision" | "vision-crop";
};

const INVOICE_TYPE_RULES: Array<[RegExp, string]> = [
  [/专用发票/, "增值税专用发票"],
  [/航空运输电子客票行程单|航空.{0,6}行程单/, "飞机行程单"],
  [/铁路电子客票|铁路.{0,4}车票/, "火车票"],
  [/出租/, "出租车票"],
  [/电子发票（普通发票）|电子发票\(普通发票\)|普通发票/, "增值税普通发票"],
];

function invoiceTypeFromText(text: string) {
  for (const [pattern, type] of INVOICE_TYPE_RULES) if (pattern.test(text)) return type;
  return "增值税普通发票";
}

/** 数电票文本层解析（pdftotext 输出顺序有乱序，用宽松锚定）。 */
function parseInvoiceText(text: string) {
  const noMatch = text.match(/\b(\d{20})\b/);
  const dateMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const saleMatch = text.match(/[\u4e00-\u9fa5（）()]{4,24}(?:有限公司|酒店|宾馆|旅馆|商行|饭店)/);
  // 价税合计 = 票面上最大的 ¥ 金额（> 税额 > 不含税额）；文本乱序时「最后一个」会抓到税额
  const totals = [...text.matchAll(/[¥￥]\s*([\d,]+\.\d{2})/g)].map((m) => Number(m[1].replace(/,/g, "")));
  const total = totals.length ? Math.max(...totals).toFixed(2) : "";
  return {
    invoiceNo: noMatch?.[1] ?? "",
    invoiceDate: dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}` : "",
    saleName: saleMatch?.[0] ?? "",
    total,
    invoiceType: invoiceTypeFromText(text),
  };
}

/** 提取手工标注字段：PDF→pdftotext 文本层（免 AI、秒回）；图片→视觉模型 JSON。 */
async function buildInvoiceMeta(root: string, paths: string[]): Promise<Record<string, InvoiceMetaField>> {
  const meta: Record<string, InvoiceMetaField> = {};
  let visionReady: { provider: ReturnType<typeof apiProviderForApiKey>; apiKey: string; model: string } | null = null;
  for (const rel of paths) {
    const abs = path.join(root, rel);
    const name = rel.split("/").pop() ?? rel;
    const base: InvoiceMetaField = { path: rel, name, invoiceType: "增值税普通发票", invoiceNo: "", invoiceDate: "", saleName: "", buyerName: "华东师范大学", total: "", source: "pdf-text" };
    try {
      if (/\.pdf$/i.test(name)) {
        const stdout = await pdfText(abs);
        const parsed = parseInvoiceText(stdout);
        Object.assign(base, parsed, { source: "pdf-text" });
      } else if (/\.(jpe?g|png)$/i.test(name)) {
        if (!visionReady) {
          const apiKey = await readSavedApiKey();
          if (!apiKey) throw new Error("no-api-key");
          const provider = apiProviderForApiKey(apiKey, (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl);
          visionReady = { provider, apiKey, model: (await readAiSettings(root) ?? normalizeAiSettings({})).model || provider.defaultModel };
        }
        const prompt = `识别这张中国发票/行程单图片，只返回 JSON（禁止 Markdown 代码块）：{"invoiceType":"增值税普通发票|增值税专用发票|火车票|飞机行程单|出租车票|其他行程票 之一","invoiceNo":"发票号码(数字)","invoiceDate":"YYYY-MM-DD","saleName":"销售方名称","buyerName":"购买方名称","total":"价税合计数字不带符号"}。看不清的字段填空字符串。`;
        const raw = await callChatModel(visionReady.provider, visionReady.apiKey, { model: visionReady.model, prompt, maxTokens: 512, temperature: 0.1, disableThinking: true });
        const json = JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim()) as Record<string, string>;
        base.invoiceType = json.invoiceType || base.invoiceType;
        base.invoiceNo = (json.invoiceNo || "").replace(/\D/g, "");
        base.invoiceDate = json.invoiceDate || "";
        base.saleName = json.saleName || "";
        base.buyerName = json.buyerName || base.buyerName;
        base.total = (json.total || "").replace(/[¥￥,\s]/g, "");
        base.source = "vision";
        // 整图读号失败：裁右上角（发票号区域）放大重读——整图小字易漏位（诺华 20 位读成 19 位实证）
        if (!base.invoiceNo) {
          const { execFile } = await import("node:child_process");
          const promisified = promisify(execFile);
          const cropped = `${abs}.crop.jpg`;
          try {
            await promisified("sips", ["-c", `${Math.round(240)},${Math.round(640)}`, "--cropOffset", "0", `${Math.round(0)}`, abs, "--out", cropped], { timeout: 8000 }).catch(async () => {
              // sips 裁剪参数不通用时退化为 resize 放大
              await promisified("sips", ["-Z", "2400", abs, "--out", cropped], { timeout: 10000 });
            });
            const cropB64 = (await fs.readFile(cropped)).toString("base64");
            const cropRaw = await callChatModel(visionReady.provider, visionReady.apiKey, { model: visionReady.model, prompt: `图中是发票右上角放大区域。「发票号码」是 20 位纯数字（26 开头）。逐位仔细读，特别注意连续 0 的个数。只输出 20 位数字本身。`, maxTokens: 64, temperature: 0, disableThinking: true });
            const digits = cropRaw.replace(/\D/g, "");
            if (/^\d{20}$/.test(digits)) { base.invoiceNo = digits; base.source = "vision-crop"; }
            await fs.rm(cropped, { force: true });
          } catch { /* 裁剪重读失败保留整图结果 */ }
        }
      }
    } catch (error) {
      serverTrace({ level: "warn", scope: "online-submit", event: "invoice-meta", detail: `${name}: ${error instanceof Error ? error.message : "提取失败"}`, task: "手工标注字段" });
    }
    meta[name] = base;
  }
  return meta;
}

/** 线上递交清单：递交前生成、面板确认后原样递交（路径始终由服务端按 meta 重建，文本字段允许清单覆盖）。 */
/** links 缺失时的节点语义回退：节点 id → 费用类型（用于发票分组判定）。 */
const NODE_EXPENSE_FALLBACK: Record<string, string> = {
  "registration-invoice": "conference-registration",
  "membership-invoice": "membership-fee",
  "transport-invoice": "air-transport",
  "hotel-invoice": "lodging",
  "intercity-taxi-invoice": "intercity-ride-hailing",
};

/** 文件名兜底（日常票据按规范命名，含 label 词）：无法从 links/节点判定组时使用。 */
const FILENAME_GROUP_FALLBACK: Array<[RegExp, string]> = [
  [/chatgpt|openai|claude|anthropic|智谱|bigmodel|ai\s*订阅/i, "云服务"],
  [/云服务|六六云|阿里云|腾讯云|digitalocean|vultr|hetzner/i, "云服务"],
  [/随身\s*wifi|扩展坞|转接头|移动硬盘|低值|易耗/i, "低值易耗设备"],
  [/显示器|设备申购|固定资产/i, "其它（直接财务）"],
];

async function buildSubmitPlan(root: string, lineId: string, applicantName: string, employeeNo: string, group?: string, deliveryHint?: { campus?: string; approver?: string }) {
  const model = await readFormalModel(root) as Partial<FormalModelState> | null;
  const linesDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
  const metaDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-meta.json"), "utf8").catch(() => "{}")) as { metadata?: Record<string, Record<string, unknown>> };
  const line = (linesDoc.lines ?? []).find((entry) => entry.id === lineId) as Record<string, unknown> | undefined;
  if (!line) throw new Error("票据集不存在");
  const folder = typeof line.folder === "string" ? line.folder : "";
  if (!folder) throw new Error("票据集缺少材料目录");
  const delivery = line.delivery as { campus?: string; approver?: string } | undefined;
  // 预览一致性：票据集未存过投递设置时，用前端面板当前值（全局记忆预填）生成预览——面板显示什么，这里就写什么。
  const planCampus = delivery?.campus || deliveryHint?.campus || "";
  const planApprover = delivery?.approver || deliveryHint?.approver || "";
  // 发票 vs 附件：按 meta 归类拆分（invoice 类进开票池，其余作报销附件）。
  // meta 里有已删除文件的历史残留，必须过滤磁盘存在性，否则 e2e 断言直接失败。
  // 收据/账单也是开单上传凭证（云服务/AI 订阅的报销凭证是 receipt 类，如 ChatGPT 收据）——仅支付记录/清单/截图作附件。
  const invoiceRe = /invoice|receipt/i;
  // 文件 → 票据集组（与首页票据集分类一致）：model links（evidence.path ↔ expense.typeId）最权威；meta 节点语义与文件名 label 词兜底；无法判定保守归「其它（直接财务）」。
  const collections = (workflowForLine(line as never).collections as Array<{ id: string; label: string; scope: string; nodeIds: readonly string[] }>).filter((collection) => collection.scope === "finance");
  const groupOfType = (typeId: string) => expenseCollectionLabel(typeId, collections) ?? "其它（直接财务）";
  const expenseTypeById = new Map<string, string>();
  for (const expense of model?.expenses ?? []) {
    if (typeof expense.id === "string" && typeof expense.typeId === "string") expenseTypeById.set(expense.id, expense.typeId);
  }
  const evidenceTypeById = new Map<string, string>();
  for (const evidence of model?.evidence ?? []) {
    if (typeof evidence.id === "string" && typeof evidence.path === "string") evidenceTypeById.set(evidence.id, evidence.path);
  }
  const pathToGroup = new Map<string, string>();
  for (const link of model?.links ?? []) {
    const tid = expenseTypeById.get(String(link.expenseId ?? ""));
    const p = evidenceTypeById.get(String(link.evidenceId ?? ""));
    if (p && tid) pathToGroup.set(p, groupOfType(tid));
  }
  const groupOfPath = (p: string, node: string): string => {
    const viaLink = pathToGroup.get(p);
    if (viaLink) return viaLink;
    const viaNode = NODE_BINDINGS[node]?.expenseTypes?.[0] ?? NODE_EXPENSE_FALLBACK[node];
    if (viaNode) return groupOfType(viaNode);
    const name = p.split("/").pop() ?? "";
    for (const [re, g] of FILENAME_GROUP_FALLBACK) if (re.test(name)) return g;
    return "其它（直接财务）";
  };
  const invoicePaths: string[] = [];
  const attachmentPaths: string[] = [];
  const groupStats = new Map<string, { invoices: number; attachments: number }>();
  for (const [p, m] of Object.entries(metaDoc.metadata ?? {})) {
    if (!p.startsWith(`${folder}/`)) continue;
    if (!existsSync(path.join(root, p))) continue;
    const node = String(m.classifiedRequirementId ?? m.classifiedWorkflowNodeId ?? "");
    const g = groupOfPath(p, node);
    const stats = groupStats.get(g) ?? { invoices: 0, attachments: 0 };
    // 凭证判定：节点名优先（invoice/receipt 类）；节点未归类时按文件名（账单/收据/发票是开单主凭证，支付记录/清单/截图作附件）。
    const name = p.split("/").pop() ?? "";
    const isVoucher = (node && invoiceRe.test(node)) || (!node && /发票|收据|账单/.test(name));
    if (isVoucher) { stats.invoices += 1; if (!group || group === g) invoicePaths.push(p); }
    else { stats.attachments += 1; if (!group || group === g) attachmentPaths.push(p); }
    groupStats.set(g, stats);
  }
  // 分组总览：每组笔数/金额/前置覆盖（approved elabBills 覆盖全部费用才算就绪），供递交面板按组递交。
  const lineExpenses = (model?.expenses ?? []).filter((expense) => expense.setId === lineId);
  const approvedExpenseIds = new Set(((line as { elabBills?: Array<{ status?: string; expenseIds?: string[] }> }).elabBills ?? []).filter((bill) => bill.status === "approved").flatMap((bill) => bill.expenseIds ?? []));
  const noPreapproval = (typeId: string) => !elabPreapprovalFor(typeId as never);
  const groupsOverview = [
    ...collections.map((collection) => collection.label),
    "其它（直接财务）",
  ]
    .map((g) => {
      const groupExpenses = lineExpenses.filter((expense) => {
        const tid = String(expense.typeId ?? "");
        return groupOfType(tid) === g && typeof expense.amountCny === "number";
      });
      if (!groupExpenses.length && !groupStats.get(g)) return null;
      const needsPreapproval = groupExpenses.length > 0 && groupExpenses.some((expense) => !noPreapproval(String(expense.typeId ?? "")));
      return {
        group: g,
        label: g,
        hint: needsPreapproval ? "须有已审核 elab 前置单覆盖全部费用" : "无 elab 前置，财务系统直接开单",
        expenseCount: groupExpenses.length,
        amountCny: groupExpenses.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0),
        preapproved: !needsPreapproval || (groupExpenses.length > 0 && groupExpenses.every((expense) => approvedExpenseIds.has(String(expense.id)))),
        invoiceCount: groupStats.get(g)?.invoices ?? 0,
        attachmentCount: groupStats.get(g)?.attachments ?? 0,
      };
    })
    .filter(Boolean);
  const groupExpenseTypeIds = new Set<string>();
  for (const expense of lineExpenses) {
    const tid = String(expense.typeId ?? "");
    if (!group || groupOfType(tid) === group) groupExpenseTypeIds.add(tid);
  }
  const expensesTotal = lineExpenses.filter((expense) => typeof expense.amountCny === "number" && (!group || groupExpenseTypeIds.has(String(expense.typeId ?? "")))).reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0);
  // 附件补充说明（递交清单可编辑）：按材料构成 + 出差基本信息自动草拟，递交前经用户确认。
  const materials: Array<{ node: string; name: string; issuer: string }> = [];
  for (const [p, m] of Object.entries(metaDoc.metadata ?? {})) {
    if (!p.startsWith(`${folder}/`)) continue;
    if (!existsSync(path.join(root, p))) continue;
    materials.push({ node: String(m.classifiedWorkflowNodeId ?? m.classifiedRequirementId ?? ""), name: p.split("/").pop() ?? "", issuer: String(m.issuer ?? "") });
  }
  const has = (node: string) => materials.some((mat) => mat.node === node);
  const parts: string[] = [];
  if (has("conference-notice")) parts.push("会议通知及日程");
  if (has("registration-fee")) parts.push("注册费标准");
  if (has("registration-invoice")) parts.push(`注册费发票${has("registration-payment") ? "及支付记录" : ""}`);
  const invNodes = materials.filter((mat) => mat.node === "transport-invoice").map((mat) => mat.name);
  if (invNodes.length) parts.push(`${invNodes.some((name) => name.includes("机票") || name.includes("航空")) ? "机票发票" : "交通发票"}`);
  if (has("transport-payment") && !invNodes.length) parts.push("交通支付凭证");
  if (has("hotel-invoice")) parts.push(`住宿发票${has("hotel-folio") ? "及水单" : ""}`);
  const vouchers = materials.filter((mat) => mat.node === "outbound-transport" || mat.node === "return-transport");
  if (vouchers.length) {
    const roundTrip = vouchers.some((mat) => mat.name.includes("往返")) || (vouchers.some((mat) => mat.node === "outbound-transport") && vouchers.some((mat) => mat.node === "return-transport"));
    parts.push(`${vouchers.length > 1 ? "" : ""}${roundTrip ? "往返" : "去程"}交通凭证`);
  }
  if (has("lodging-payment") && !has("hotel-invoice")) parts.push("住宿支付凭证");
  // 会议信息：主办方取会议通知 issuer，活动简称取文件名中的拉丁活动段（如 NEW-data 2026）。
  const notice = materials.find((mat) => mat.node === "conference-notice");
  const activity = notice?.name.match(/_([A-Za-z][A-Za-z0-9-]*(?: ?\d{4})?)[._]/)?.[1] ?? "";
  const organizer = notice?.issuer ?? "";
  // 差旅补贴（华师财〔2024〕2号 第19/21条，贵阳单实测 180/天 ×2 吻合）：伙食 100/天 + 市内交通 80/天；藏青新伙食 120/天 → 200/天。
  // 天数 = 出差自然天数包干，由费用发生日期（票据日期）首末推断。
  // 出差天数以费用日期 + 去/返程凭证日期并集的首末推断（费用日期可能只覆盖落脚日；删掉某笔费用不应改变包干天数——贵阳携程凭证 8/25 即出发日）。
  const occurredDates = [...new Set([
    ...(model?.expenses ?? []).filter((expense) => expense.setId === lineId && expense.occurredAt).map((expense) => String(expense.occurredAt).slice(0, 10)),
    ...Object.entries(metaDoc.metadata ?? {})
      .filter(([p, m]) => p.startsWith(`${folder}/`) && ["outbound-transport", "return-transport"].includes(String(m.classifiedWorkflowNodeId ?? m.classifiedRequirementId ?? "")))
      .flatMap(([p]) => (p.split("/").pop() ?? "").match(/\d{4}-\d{2}-\d{2}/) ?? []),
  ])].sort();
  const subsidyDays = occurredDates.length ? Math.round((Date.parse(occurredDates[occurredDates.length - 1]) - Date.parse(occurredDates[0])) / 86_400_000) + 1 : 0;
  const subsidyPerDay = /西藏|青海|新疆/.test(String(line.title ?? "")) ? 200 : 180;
  // 差旅补贴只属差旅/会议票据集（华师财〔2024〕2号按出差天数包干）；日常票据（云服务/低耗等）无补贴。
  const isTravelLine = /差旅|会议/.test(String(line.kind ?? ""));
  const subsidy = isTravelLine ? subsidyDays * subsidyPerDay : 0;
  // 摘要惯例（历史报销单核实，2026-09-01）：{姓名}{目的地}差旅，如「张三上海差旅」；目的地取标题首个纯中文段（去掉可能带上的年/月前缀）。
  // 姓名由前端传入（用户信息设置的活动 profile），后端不落任何个人硬编码。
  const destMatch = String(line.title ?? "").match(/[\u4e00-\u9fa5]{2,8}/);
  const dest = destMatch ? destMatch[0].replace(/^[年月度]+/, "") : "";
  // 分组递交（日常票据）：摘要带票据集组语义（如「张三日常票据·低值易耗设备」），与其它组区分，也避免撤旧查重互相误伤。
  // 摘要惯例（旧系统历史报销单 17 笔实证，bx-conventions.json）：日常报销 = 组内费用科目去重拼接
  // （「市内交通费」「市内交通费、材料费、图书费」）；差旅 = 「{姓名}{目的地}差旅」。
  const SUBJECT_BY_TYPE: Record<string, string> = {
    "local-ride-hailing": "市内交通费", "local-taxi": "市内交通费", "low-value-gear": "材料费",
    "office-supplies": "办公用品", "books-materials": "图书费", "ai-subscription": "云服务费", "cloud-service": "云服务费",
  };
  const groupSubjects = lineExpenses
    .filter((expense) => typeof expense.amountCny === "number" && (!group || groupExpenseTypeIds.has(String(expense.typeId ?? ""))))
    .map((expense) => SUBJECT_BY_TYPE[String(expense.typeId ?? "")] || null)
    .filter((s): s is string => Boolean(s));
  const groupSummary = [...new Set(groupSubjects)].join("、");
  const summary = group
    ? (groupSummary || `${applicantName ?? ""}${group}`)
    : applicantName && dest && isTravelLine ? `${applicantName}${dest}差旅`
      : (groupSubjects.length ? [...new Set(groupSubjects)].join("、") : `${applicantName ?? ""}${String(line.title ?? "")}`);
  // 出差时间段复用补贴天数口径（费用日期 ∪ 凭证文件名日期首末）；住宿晚数 = 天数 - 1。
  const stay = subsidyDays > 1 ? `，住宿 ${subsidyDays - 1} 晚` : "";
  const period = occurredDates.length ? `（${occurredDates[0]} 至 ${occurredDates[occurredDates.length - 1]}，共 ${subsidyDays} 天${stay}）` : "";
  const composition = parts.length ? `材料含：${parts.join("、")}。` : "";
  // 附件合并判定（2026-10-16 财务上限，用户定案）：「是否合并」用变量表达单一事实源，
  // 补充说明 stats 与 formFields 预览一律读变量——不在文案处重复内联判断。
  // 上限常量统一取自 reimbursement-policy.ts（与规则库/递交面板同源）；daily_bx_draft.py 侧同名常量需同步。
  // 合并只能压附件：合并后总数 = 发票数 + 1。发票数无法用合并缩减——
  // 若发票 + 合并附件 1 份仍超限（发票数已顶满/超出），合并救不了，只能拆单递交。
  const overLimit = invoicePaths.length + attachmentPaths.length > FINANCE_ATTACHMENT_LIMIT;
  const splitRequired = overLimit && invoicePaths.length + 1 > FINANCE_ATTACHMENT_LIMIT;
  const willMergeAttachments = overLimit && !splitRequired;
  const stats = `共发票 ${invoicePaths.length} 份、附件 ${willMergeAttachments ? `1 份（${attachmentPaths.length} 份材料合并 PDF）` : `${attachmentPaths.length} 份`}。`;
  const attachmentDesc = notice
    ? `本人为参加${organizer}${activity ? `「${activity}」` : ""}会议赴${dest}出差${period}。${composition}${stats}`
    : occurredDates.length && (has("hotel-invoice") || materials.some((mat) => mat.node === "transport-invoice"))
      ? `本人赴${dest}出差${period}。${composition}${stats}`
      : `本人课题日常支出报销材料。${composition}${stats}`;
  return {
    lineId,
    title: String(line.title ?? ""),
    // 票据集类型（差旅/日常）决定 e2e 引擎分派：全量口径（未选组）也必须按 kind 分派，不能都塞给差旅引擎。
    kind: String(line.kind ?? ""),
    // 分组递交：group 为空 = 全部（旧行为）；指定时发票/附件/金额均按该财务流程组过滤。
    group: group ?? "",
    groupLabel: group ? group : "全部费用",
    groupsOverview,
    attachmentDesc,
    invoicePaths,
    attachmentPaths,
    summary,
    payRemark: String(line.title ?? "").replace(/^\d{4}\s*/, "").slice(0, 12),
    campus: planCampus,
    approver: planApprover,
    projectId: String(line.projectId ?? ""),
    // 乘坐人=报销人本人（e2e 填单"乘坐人"段）；不再是脚本内硬编码。
    travelerName: applicantName,
    travelerSno: employeeNo,
    invoiceCount: invoicePaths.length,
    attachmentCount: attachmentPaths.length,
    expensesTotal,
    subsidyDays,
    subsidyPerDay,
    subsidy,
    expectedAmount: (expensesTotal + subsidy).toFixed(2),
    // 财务系统填写预览：与 e2e 实际写入项一一对应，递交前肉眼核对；空值由前端标红。
    formFields: [
      { label: "摘要", value: summary },
      { label: "申请人（报销人/乘坐人）", value: applicantName },
      { label: "工号", value: employeeNo },
      { label: "投递校区", value: planCampus },
      { label: "协同审批人", value: planApprover },
      { label: "报销项目", value: String(line.projectId ?? "") || "（单据默认项目）" },
      { label: "支付金额", value: `转卡 ${(expensesTotal + subsidy).toFixed(2)}（票面 ${expensesTotal.toFixed(2)} + 补贴 ${subsidy.toFixed(2)}）` },
      { label: "支付附言", value: String(line.title ?? "").replace(/^\d{4}\s*/, "").slice(0, 12) || summary },
      { label: "发票 / 附件", value: `${invoicePaths.length} 份 / ${willMergeAttachments ? `1 份（${attachmentPaths.length} 份合并 PDF，财务上限 ${FINANCE_ATTACHMENT_LIMIT}）` : `${attachmentPaths.length} 份`}` },
      // 拆单警示（2026-10-16 用户定案：附件可合并、发票不能——发票+1 仍超限 = 合并救不了，必须拆单）
      ...(splitRequired ? [{ label: "⚠ 必须拆单", value: `发票 ${invoicePaths.length} 份 + 合并附件 1 份 = ${invoicePaths.length + 1} 仍超财务上限 ${FINANCE_ATTACHMENT_LIMIT}，请拆成多张报销单递交` }] : []),
    ],
  };
}

/** 在线任务共享类型：全流程 running→awaiting→submitting/withdrawing→submitted/withdrawn，任一步失败 failed；人工停止 stopped。 */
type OnlineJob = {
  state: "running" | "awaiting" | "submitting" | "submitted" | "withdrawing" | "withdrawn" | "failed" | "stopped";
  mode: "full" | "submit" | "cleanup";
  lineId?: string;
  step: string;
  progress?: number;
  billNo?: string;
  evidence?: string;
  error?: string;
  log: string[];
  startedAt: number;
  child?: ReturnType<typeof spawn>;
  stopRequested?: boolean;
  autoSubmitted?: boolean;
  group?: string;
  projectCode?: string;
};

/** e2e 段落号 → 0-16 均匀进度：#5 段（识别+行程+前往报销）占时最长，按细分动作摊开；缺 #11/#85 等警告段不影响映射。 */
const STEP_PROGRESS: Array<[RegExp, number]> = [
  [/^#0 /, 1], [/^#1 /, 2], [/^#2 /, 3], [/^#3 /, 4], [/^#4 /, 5],
  [/^#5 .*识别/, 7], [/^#5 .*手工标注/, 9], [/^#5 .*缺行程/, 8], [/^#5 .*行程修复/, 9], [/^#5 .*行程/, 9],
  [/^#5 .*前往报销/, 10], [/^#6 /, 11], [/^#7 /, 12], [/^#85 /, 13], [/^#8 /, 13],
  [/^#9 /, 14], [/^#10 /, 14], [/^#11 /, 15], [/^#12 /, 15], [/^#13 /, 15], [/^#14 /, 16], [/^#15 /, 16], [/^#16 /, 16],
];
function stepProgress(step: string): number {
  for (const [pattern, value] of STEP_PROGRESS) if (pattern.test(step)) return value;
  return 0;
}


/** 递交成功后把报销单号登记进票据集（model sets），状态置已递交——前端 model-state merge 自动吸收，轮询自此接管跟踪。 */
/** elab HC 单（材料易耗品低值品报账）填报计划：递交前确定全部参数，与线上递交两段式同构。 */
/** elab 非常规材料（低值品/易耗品）的通用购买理由：提交校验要求备注购买理由 */
const ELAB_PURCHASE_REASON = "用于实验室建设";
/** 装备处《材料易耗品低值品-办公用品分类》：各类办公用品不在设备与实验室管理平台（elab）填写——
 * 台灯（辅助用品）、打印复印纸、文件夹、订书机等命中即从 HC 计划排除，直接走财务报账（部分辅助用品曾被转装备处人工审核） */
const ELAB_OFFICE_SUPPLIES_EXCLUDE = ["台灯", "打印复印纸", "照片纸", "文件夹", "订书机", "计算器", "账本", "报事贴", "便利贴", "便签", "抽纸", "卷筒纸", "大盘纸", "卫生纸", "纸巾", "湿巾", "毛巾", "中性笔", "圆珠笔", "签字笔", "铅笔", "白板笔", "荧光笔", "钢笔", "记号笔", "水彩笔", "橡皮", "修正液", "修正带", "胶棒", "胶水", "胶带", "票夹", "美工刀", "剪刀", "打孔器", "起钉器", "削笔刀", "笔筒", "笔袋", "报刊架", "杂志架", "白板", "证件卡", "台座", "证书", "钥匙管理", "杯子", "茶", "咖啡", "饮用水", "印章", "号码机", "印台", "印油", "支票夹", "复写纸", "凭证", "单据", "票据装订机"];

type ElabHcPlan = {
  lineId: string; title: string; jfly: string; jflyProject: string;
  bills: Array<{ name: string; dj: string; sl: string; fph: string; invoiceFile: string; fphSource: string; bz: string }>;
  attachments: string[]; expenseIds: string[]; total: number; warnings: string[];
};

/** 文件名品名段：规范命名 `日期_商户_品名_低值设备发票_…` 第 3 段；分类目录按历史单映射。 */
function elabHcGoodsFromFilename(name: string): { goods: string; category: string } {
  const parts = name.replace(/\.[a-z]+$/i, "").split("_");
  const goods = (parts[2] ?? parts[1] ?? "低值设备").trim();
  const category = /数据线|线缆|电缆/.test(goods) ? "电线电缆" : "计算机外部设备";
  return { goods, category };
}

async function buildElabHcPlan(root: string, lineId: string, expenseIdsFilter?: string[]): Promise<ElabHcPlan> {
  const model = (await readFormalModel(root)) as {
    sets?: Array<Record<string, unknown>>;
    expenses?: Array<Record<string, unknown>>;
    evidence?: Array<Record<string, unknown>>;
    links?: Array<Record<string, unknown>>;
  } | null;
  const linesDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
  const line = (linesDoc.lines ?? []).find((entry) => entry.id === lineId) as Record<string, unknown> | undefined;
  if (!line) throw new Error("票据集不存在");
  const folder = typeof line.folder === "string" ? line.folder : "";
  const modelSet = (model?.sets ?? []).find((entry) => entry.id === lineId) ?? {};
  const jfly = typeof line.projectId === "string" && line.projectId ? line.projectId : String(modelSet.projectId ?? "");
  if (!jfly) throw new Error("票据集未设置报销项目（projectId）——先在投递设置中选择项目");
  // 经费卡交叉验证：必须命中项目预算表（排除间接经费）
  if (!existsSync(path.join(root, "data", "budgets", `${jfly}.json`))) {
    throw new Error(`经费卡 ${jfly} 不在项目预算表（疑似间接经费）——请改用直接经费项目`);
  }
  const budget = JSON.parse(await fs.readFile(path.join(root, "data", "budgets", `${jfly}.json`), "utf8").catch(() => "{}")) as { projectName?: string };

  // 待覆盖费用：本集低值设备费用，防御性去重（同 setId+typeId+金额合一）
  const seen = new Set<string>();
  const expenses = (model?.expenses ?? []).filter((expense) => {
    if (expense.setId !== lineId || expense.typeId !== "low-value-gear") return false;
    if (expenseIdsFilter?.length && !expenseIdsFilter.includes(String(expense.id))) return false;
    const key = `${expense.setId}|${expense.typeId}|${expense.amountCny}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!expenses.length) throw new Error("该票据集没有低值易耗设备费用，无需 HC 前置单");

  // 发票证据：金额配对（±0.02）
  const invoices = (model?.evidence ?? []).filter((evidence) => evidence.workflowNodeId === "low-value-gear-invoice" && typeof evidence.path === "string" && (!folder || String(evidence.path).startsWith(folder)));
  const warnings: string[] = [];
  const bills: ElabHcPlan["bills"] = [];
  const usedInvoice = new Set<string>();
  let total = 0;
  const expenseIds: string[] = [];
  for (const expense of expenses) {
    const amount = Number(expense.amountCny ?? 0);
    total += amount;
    if (typeof expense.id === "string") expenseIds.push(expense.id);
    const invoice = invoices.find((evidence) => {
      if (usedInvoice.has(String(evidence.id))) return false;
      const evAmount = Number((evidence.extracted as Record<string, unknown> | undefined)?.amount ?? NaN);
      return Math.abs(evAmount - amount) < 0.02;
    });
    if (!invoice) {
      warnings.push(`费用 CNY ${amount.toFixed(2)} 未找到金额匹配的发票材料，已跳过`);
      continue;
    }
    usedInvoice.add(String(invoice.id));
    const rel = String(invoice.path);
    const name_ = rel.split("/").pop() ?? rel;
    const { goods, category } = elabHcGoodsFromFilename(name_);
    // 办公用品不在 elab 平台填写（装备处官方分类）——排除并提示走财务直报
    if (ELAB_OFFICE_SUPPLIES_EXCLUDE.some((keyword) => goods.includes(keyword) || name_.includes(keyword))) {
      warnings.push(`${goods || name_} 属办公用品（装备处分类），不在 elab 平台填写——请走财务直接报账，已从 HC 计划排除`);
      continue;
    }
    // 发票号三级来源：evidence meta（双源验证定稿）→ buildInvoiceMeta（PDF 文本层/图片视觉）
    const metaInvoiceNo = String((invoice.extracted as Record<string, unknown> | undefined)?.invoiceNumber ?? "");
    let fph = metaInvoiceNo;
    let fphSource = metaInvoiceNo ? "meta-verified" : "";
    if (!fph) {
      const meta = await buildInvoiceMeta(root, [rel]);
      fph = meta[name_]?.invoiceNo ?? "";
      fphSource = meta[name_]?.source ?? "";
    }
    if (!fph) warnings.push(`发票 ${name_} 未能提取发票号——需双源人工确认后才能填报`);
    bills.push({ name: `${category}*${goods}`, dj: amount.toFixed(2), sl: "1", fph, invoiceFile: rel, fphSource, bz: ELAB_PURCHASE_REASON });
  }
  if (!bills.length) throw new Error("没有可填报的明细（费用均无匹配发票）");
  return {
    lineId, title: String(line.title ?? ""), jfly, jflyProject: budget.projectName ?? jfly,
    bills, attachments: bills.map((bill) => bill.invoiceFile), expenseIds, total: Number(total.toFixed(2)), warnings,
  };
}

/** elab CSF（wxzc 软件服务费报账单）计划：云服务 + AI 订阅费用 → 「软件服务费」明细。
 * 与 HC 的关键差异：无经费来源字段（CSF 单不填 JFLY，历史单实证）；发票号留空合法（境外服务无中国发票）；
 * 附件只取 invoice/receipt 类材料（用户定案：价格截图/产品页面/费用清单不传，支付记录可选）。 */
async function buildElabCsfPlan(root: string, lineId: string, expenseIdsFilter?: string[]) {
  const model = (await readFormalModel(root)) as {
    expenses?: Array<Record<string, unknown>>;
    evidence?: Array<Record<string, unknown>>;
  } | null;
  const linesDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
  const line = (linesDoc.lines ?? []).find((entry) => entry.id === lineId) as Record<string, unknown> | undefined;
  if (!line) throw new Error("票据集不存在");
  const folder = typeof line.folder === "string" ? line.folder : "";

  const expenses = (model?.expenses ?? []).filter((expense) => {
    if (expense.setId !== lineId) return false;
    if (expense.typeId !== "cloud-service" && expense.typeId !== "ai-subscription") return false;
    if (expenseIdsFilter?.length && !expenseIdsFilter.includes(String(expense.id))) return false;
    return true;
  });
  if (!expenses.length) throw new Error("该票据集没有云服务/AI 订阅费用，无需 CSF 前置单");
  const expenseIds = expenses.map((expense) => String(expense.id));

  // 防重：已有 wxzc 登记覆盖本次费用（rejected 视同未登记）→ 拒绝重复开单
  const existingBills = (Array.isArray(line.elabBills) ? line.elabBills : []) as Array<Record<string, unknown>>;
  const activeWxzc = existingBills.filter((bill) => bill.system === "wxzc" && bill.status !== "rejected" && typeof bill.billNo === "string" && String(bill.billNo).trim());
  const overlap = activeWxzc.filter((bill) => ((bill.expenseIds as string[]) ?? []).some((id) => expenseIds.includes(id)));
  if (overlap.length) {
    throw new Error(`已有 wxzc 登记覆盖本次费用：${overlap.map((bill) => bill.billNo).join("、")}——如需重开，请先撤销 elab 草稿并删除该登记`);
  }

  const warnings: string[] = [];
  const bills = expenses.map((expense) => {
    const amountCny = Number(expense.amountCny ?? 0);
    const merchant = String(expense.merchant ?? "").replace(/(股份)?有限公司$/, "");
    const occurredAt = String(expense.occurredAt ?? "").slice(0, 7);
    const currency = String(expense.currency ?? "CNY");
    const currencyPart = currency !== "CNY" ? `（${currency}${Number(expense.amount ?? 0).toFixed(0)} 汇率折算）` : "";
    return {
      name: "软件服务费",
      dj: amountCny.toFixed(2),
      sl: "1",
      fph: "",
      bz: `${merchant} 软件服务费 ${occurredAt}${currencyPart}`.trim(),
      invoiceFile: "",
      merchant,
    };
  });
  const total = Number(bills.reduce((sum, bill) => sum + Number(bill.dj), 0).toFixed(2));

  // 附件：云服务/AI 订阅的 invoice/receipt 节点白名单（chatgpt-receipt/cloud-invoice/zhipu-invoice），
  // 目录段精确匹配（startsWith 会把「·低值易耗设备-2」等后缀目录误收进来）。价格截图/费用清单/支付记录不传（用户定案）。
  const CSF_ATTACH_NODE_IDS = new Set(["chatgpt-receipt", "cloud-invoice", "zhipu-invoice"]);
  const folderSeg = folder ? folder.replace(/\/$/, "").split("/") : [];
  const attachEvidence = (model?.evidence ?? []).filter((evidence) => {
    if (typeof evidence.path !== "string") return false;
    if (!CSF_ATTACH_NODE_IDS.has(String(evidence.workflowNodeId ?? ""))) return false;
    if (folder) {
      const seg = String(evidence.path).split("/");
      seg.pop();
      const inFolder = seg.length >= folderSeg.length && folderSeg.every((part, i) => seg[i] === part);
      if (!inFolder) return false;
    }
    return true;
  });
  const attachments = attachEvidence.map((evidence) => String(evidence.path));
  if (!attachments.length) warnings.push("未找到 invoice/receipt 类材料——请先在票据集内归档账单/收据，或递交后人工补传");

  return { lineId, title: String(line.title ?? ""), jfly: "", jflyProject: "", bills, attachments, expenseIds, total, warnings };
}

/** elab HC 报填任务：spawn auto_elab_hc_e2e.py，解析 BZDBH，完成后回填 line.elabBills（状态=填写中）。 */
type ElabHcJob = {
  state: "running" | "draft_saved" | "submitted" | "failed" | "stopped";
  submitted?: boolean;
  lineId: string; step: string; log: string[]; startedAt: number;
  billNo: string; error?: string; child?: ReturnType<typeof spawn>; stopRequested?: boolean;
};
const elabHcJobs = new Map<string, ElabHcJob>();

async function registerElabBill(root: string, lineId: string, billNo: string, expenseIds: string[], amountCny: number, status: "draft" | "submitted" = "draft", system: "zcgl" | "wxzc" = "zcgl") {
  // 前端读的是 ExpenseLine.elabBills（receipt-lines.json），不是 model.sets——回填必须写到前端数据源。
  const file = path.join(root, "data", "receipt-lines.json");
  const doc = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
  const line = (doc.lines ?? []).find((entry) => entry.id === lineId);
  if (!line) throw new Error(`line 不存在: ${lineId}`);
  const bills = Array.isArray(line.elabBills) ? (line.elabBills as Array<Record<string, unknown>>) : [];
  if (bills.some((entry) => entry.billNo === billNo)) return;
  bills.push({
    id: `elab-${Date.now()}`, system, billNo, status,
    expenseIds, amountCny, registeredVia: "auto", createdAt: new Date().toISOString(),
  });
  line.elabBills = bills;
  await atomicWriteJson(file, doc);
  serverTrace({ level: "info", scope: "elab-hc", event: "bill-registered", detail: `${lineId} <- ${billNo}（${expenseIds.length} 笔 · CNY ${amountCny.toFixed(2)} · ${status}）`, task: "elab前置单" });
}

/** elab 状态 → 观自在状态映射。 */
function mapElabStatus(raw: string): "draft" | "submitted" | "approved" | "rejected" | null {
  if (!raw) return null;
  if (raw.includes("填写中")) return "draft";
  if (raw.includes("退回")) return "rejected";
  if (raw.includes("已审核") || raw.includes("通过")) return "approved";
  if (raw.includes("审核") || raw.includes("待审")) return "submitted";
  return null;
}

/** elab 状态同步：spawn sync 脚本抓列表 {单号: 状态}，回写 line.elabBills。 */
/** 金额变化后重新匹配覆盖费用：本单旧覆盖作废，在未被其它单覆盖的同类型费用中找合计等额的组合（全取/单笔/子集和，均不中则空 + note 人工核对）。 */
function rematchExpenseIds(model: { expenses?: Array<Record<string, unknown>> } | null, lineId: string, bills: Array<Record<string, unknown>>, bill: Record<string, unknown>, total: number): string[] {
  const typeId = bill.system === "zcgl" ? "low-value-gear" : null;
  const pool = (model?.expenses ?? []).filter((expense) => expense.setId === lineId && (!typeId || expense.typeId === typeId));
  const coveredByOthers = new Set(bills.filter((entry) => entry !== bill).flatMap((entry) => Array.isArray(entry.expenseIds) ? entry.expenseIds as string[] : []));
  const candidates = pool.filter((expense) => !coveredByOthers.has(String(expense.id)) && Number(expense.amountCny ?? 0) > 0);
  const ids = candidates.map((expense) => String(expense.id));
  const amounts = candidates.map((expense) => Number(expense.amountCny ?? 0));
  if (Math.abs(amounts.reduce((sum, value) => sum + value, 0) - total) < 0.02) return ids;
  const single = amounts.findIndex((value) => Math.abs(value - total) < 0.02);
  if (single >= 0) return [ids[single]];
  const dfs = (index: number, remaining: number, picked: number[]): number[] | null => {
    if (Math.abs(remaining) < 0.02) return picked;
    if (index >= amounts.length || remaining < -0.02) return null;
    return dfs(index + 1, remaining - amounts[index], [...picked, index]) ?? dfs(index + 1, remaining, picked);
  };
  const found = dfs(0, total, []);
  return found ? found.map((i) => ids[i]) : [];
}

async function syncElabStatus(root: string, lineId: string, system: "zcgl" | "wxzc" = "zcgl") {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = startSchoolScript(root, "tools/sync_elab_hc_status.py", ["--system", system]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { out += `\nstderr: ${chunk.toString().slice(0, 200)}`; });
    void child.on("close", (code) => {
      const jsonLine = out.trim().split("\n").reverse().find((line) => line.trim().startsWith("{"));
      if (code === 0 && jsonLine) resolve(jsonLine);
      else reject(new Error(out.trim().slice(-200)));
    });
  });
  const statusMap = JSON.parse(stdout.trim()) as Record<string, { status: string; total: string; stage?: string; wid?: string }>;
  // 空列表 = 抓取失败（锚点失效/登录态过期），绝不能当作「全部单据已删除」清空登记——避免误删已审核登记
  if (!Object.keys(statusMap).length) throw new Error("elab 列表抓取结果为空，跳过状态同步以防误删登记");
  const file = path.join(root, "data", "receipt-lines.json");
  const doc = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
  const line = (doc.lines ?? []).find((entry) => entry.id === lineId);
  if (!line) throw new Error(`line 不存在: ${lineId}`);
  const model = (await readFormalModel(root)) as { expenses?: Array<Record<string, unknown>> } | null;
  const bills = Array.isArray(line.elabBills) ? (line.elabBills as Array<Record<string, unknown>>) : [];
  const updated: Array<{ billNo: string; status: string }> = [];
  // ① 状态更新：本地已有单据对齐 elab 真实状态
  for (const bill of [...bills]) {
    const no = String(bill.billNo ?? "");
    const raw = statusMap[no];
    if (!raw) {
      // 本 system 列表里不存在：非手动登记的单视为已在 elab 侧删除——移除登记，解除费用覆盖
      // （必须按 system 过滤：sync 只抓了一个 system 的列表，跨 system 登记不可判）
      if ((bill.system ?? "zcgl") === system && bill.registeredVia !== "manual") {
        bills.splice(bills.indexOf(bill), 1);
        updated.push({ billNo: no, status: "已删除（elab 系统中不存在）" });
        serverTrace({ level: "warn", scope: "elab-hc", event: "bill-removed", detail: `${lineId}: ${no} 在 elab 列表中不存在，已移除登记`, task: "elab前置单" });
      }
      continue;
    }
    const mapped = mapElabStatus(raw.status);
    if (mapped && mapped !== bill.status) {
      bill.status = mapped;
      if (mapped === "approved" && !bill.approvedAt) bill.approvedAt = new Date().toISOString().slice(0, 10);
      updated.push({ billNo: no, status: mapped });
    }
    const stage = String(raw.stage ?? "").trim();
    if (stage && stage !== (bill.stage ?? "")) {
      bill.stage = stage;
      if (!updated.some((u) => u.billNo === no)) updated.push({ billNo: no, status: `${mapped ?? String(bill.status)}（环节 ${stage}）` });
    }
    const rawWid = String(raw.wid ?? "").trim();
    if (rawWid && bill.wid !== rawWid) bill.wid = rawWid;
    // 金额一致性约束：本地登记金额必须跟随 elab 实况——单据在审核后仍可能被修改，登记不跟随时覆盖关系（expenseIds）与报账单 PDF 全部过时
    const rawTotal = Number(raw.total || 0);
    if (rawTotal > 0 && Math.abs(rawTotal - Number(bill.amountCny ?? 0)) > 0.02) {
      bill.amountCny = rawTotal;
      const rematched = rematchExpenseIds(model, lineId, bills, bill, rawTotal);
      bill.expenseIds = rematched;
      if (rematched.length) delete bill.note;
      else bill.note = `金额 CNY ${rawTotal}（elab 侧变更后未匹配到等额费用组合，覆盖关系需手动核对）`;
      updated.push({ billNo: no, status: `金额校准 CNY ${rawTotal}` });
      serverTrace({ level: "warn", scope: "elab-hc", event: "amount-realigned", detail: `${lineId}: ${no} 登记金额与 elab 实况不符，已校准为 CNY ${rawTotal} 并重配 ${rematched.length} 笔覆盖`, task: "elab前置单" });
    }
    // 已审核 → 自动打印报账单 PDF 入集（文件缺失或金额过时则重打）
    if (mapped === "approved" && rawWid) {
      const folder = typeof line.folder === "string" ? line.folder : "";
      if (folder) {
        const folderAbs = path.join(root, folder);
        try {
          if (existsSync(folderAbs)) {
            const billSystem = String(bill.system ?? "zcgl");
            const printKind = billSystem === "wxzc" ? "报账单" : "资产入账单";
            const metaNode = billSystem === "wxzc" ? "cloud-services-csf" : "low-value-gear-elab";
            const expectedAmount = Number(bill.amountCny ?? 0).toFixed(2);
            const existing = (await fs.readdir(folderAbs)).filter((name) => name.includes(`elab_${no}_${printKind}`));
            // 已打印 PDF 的金额与登记实况不符（单据后经修改）→ 删旧重打
            const stale = existing.filter((name) => !name.includes(`CNY${expectedAmount}`));
            for (const name of stale) await fs.rm(path.join(folderAbs, name)).catch(() => undefined);
            if (!existing.length || stale.length) {
              const amountPart = bill.amountCny != null ? expectedAmount : "";
              const printProc = startSchoolScript(root, "tools/print_elab_bill.py", ["--wid", rawWid, "--billno", no, "--folder", folder, "--amount", amountPart, "--system", billSystem]);
              printProc.stdout.on("data", (chunk: Buffer) => {
                const text = chunk.toString().trim();
                if (text.startsWith("OK:")) {
                  serverTrace({ level: "info", scope: "elab-hc", event: "bill-printed", detail: `${lineId} <- ${no} 报账单已打印入集`, task: "elab前置单" });
                  // 打印的报账单写入归类 meta（否则 record 无 classified，行内不显示、重建还会丢 workflowNodeId）
                  const printedRel = text.slice(4).trim();
                  void (async () => {
                    try {
                      await withReceiptMetaWrite(async () => {
                        const metaPath = path.join(root, "data", "receipt-meta.json");
                        const metaDoc = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}")) as { metadata?: Record<string, Record<string, unknown>> };
                        metaDoc.metadata = metaDoc.metadata ?? {};
                        metaDoc.metadata[printedRel] = { ...(metaDoc.metadata[printedRel] ?? {}), classifiedRequirementId: metaNode, classifiedWorkflowNodeId: metaNode };
                        await atomicWriteJson(metaPath, metaDoc);
                      });
                    } catch { /* meta 写入失败不影响打印 */ }
                  })();
                }
              });
            }
          }
        } catch { /* 打印失败不影响同步 */ }
      }
    }
  }
  // ② 发现式补登：elab 列表有、本地没有的 HC 单自动登记（覆盖费用按金额匹配本集未覆盖费用）
  const zcglExpenses = (model?.expenses ?? []).filter((expense) => expense.setId === lineId && expense.typeId === "low-value-gear");
  for (const [no, info] of Object.entries(statusMap)) {
    if (!no.startsWith("HC") || bills.some((entry) => entry.billNo === no)) continue;
    const mapped = mapElabStatus(info.status);
    if (!mapped) continue;
    const total = Number(info.total || 0);
    const uncovered = zcglExpenses.filter((expense) => !bills.some((bill) => Array.isArray(bill.expenseIds) && (bill.expenseIds as string[]).includes(String(expense.id))));
    const matched = uncovered.filter((expense) => Number(expense.amountCny ?? 0) > 0);
    const matchedTotal = matched.reduce((sum, expense) => sum + Number(expense.amountCny ?? 0), 0);
    const expenseIds = Math.abs(matchedTotal - total) < 0.02 ? matched.map((expense) => String(expense.id)) : [];
    if (!expenseIds.length) {
      // 金额与本项目任何费用组合都对不上（如历史票据集的已审核单）——不属于本集，不补登
      continue;
    }
    bills.push({
      id: `elab-${Date.now()}-${no}`, system: "zcgl", billNo: no, status: mapped,
      expenseIds, amountCny: total || undefined, registeredVia: "sync",
      createdAt: new Date().toISOString(),
      note: expenseIds.length ? undefined : `金额 CNY ${total}（未匹配到等额费用组合，覆盖关系需手动核对）`,
    });
    updated.push({ billNo: no, status: `${mapped}（新发现）` });
    serverTrace({ level: "info", scope: "elab-hc", event: "bill-discovered", detail: `${lineId} <- ${no}（${info.status} · CNY ${total} · 覆盖 ${expenseIds.length} 笔）`, task: "elab前置单" });
  }
  if (updated.length) await atomicWriteJson(file, doc);
  serverTrace({ level: "info", scope: "elab-hc", event: "status-synced", detail: `${lineId}: ${updated.map((u) => `${u.billNo}→${u.status}`).join(", ") || "无变化"}`, task: "elab前置单" });
  return { updated, elabBills: bills, statusMap };
}

function startElabHcJob(root: string, job: ElabHcJob, jobId: string, config: Record<string, unknown>) {
  const configPath = path.join(root, "data", "autobx_logs", `elab_hc_${jobId}.json`);
  void (async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    const child = startSchoolScript(root, "tools/auto_elab_hc_e2e.py", ["--config", configPath]);
    job.child = child;
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) {
        if (!text.trim()) continue;
        job.log.push(text.slice(0, 300));
        const step = text.match(/\[(?:elab-hc)\] (.+)$/);
        if (step) job.step = step[1].slice(0, 60);
        const bill = text.match(/BZDBH=(HC\d+)/);
        if (bill) job.billNo = bill[1];
        if (text.includes("##ELABSUBMITTED##")) job.submitted = true;
        serverTrace({ level: "info", scope: "elab-hc", event: "log", detail: text.slice(0, 200), task: "elab前置单" });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      job.log.push(`stderr: ${chunk.toString().slice(0, 300)}`);
    });
    void child.on("close", AsyncLocalStorage.bind((code: number | null) => {
      if (job.stopRequested) {
        job.state = "stopped";
        job.error = "已人工停止。elab 可能残留草稿单，请在 elab 列表页核对。";
      } else if (code !== 0) {
        job.state = "failed";
        job.error = job.log.filter((entry) => entry.includes("FAIL") || entry.startsWith("stderr:")).slice(-1)[0] ?? `退出码 ${code}`;
      } else if (job.billNo && job.submitted) {
        job.state = "submitted";
      } else {
        job.state = job.billNo ? "draft_saved" : "failed";
        if (!job.billNo) job.error = "流程结束但未捕获 BZDBH 单号";
      }
      serverTrace({ level: job.state === "failed" ? "error" : job.state === "stopped" ? "warn" : "info", scope: "elab-hc", event: job.state, detail: job.billNo ? `草稿单号 ${job.billNo}` : job.error ?? "", durationMs: Date.now() - job.startedAt, exitCode: code ?? undefined, task: "elab前置单" });
      if (job.billNo && job.lineId) {
        const config_ = config as { bills?: Array<{ dj?: string; sl?: string }>; expenseIds?: string[] };
        const amount = (config_.bills ?? []).reduce((sum, bill) => sum + Number(bill.dj ?? 0) * Number(bill.sl ?? 1), 0);
        void registerElabBill(root, job.lineId, job.billNo, config_.expenseIds ?? [], Number(amount.toFixed(2)), job.submitted ? "submitted" : "draft")
          .catch((error) => serverTrace({ level: "error", scope: "elab-hc", event: "bill-registered", detail: String(error).slice(0, 120), task: "elab前置单" }));
      }
    }));
  })();
}

/** elab CSF 报填任务：spawn auto_elab_csf_e2e.py，解析 ##BILL##，完成后回填 line.elabBills（system=wxzc）。
 * CSF 到保存草稿为止绝不提交（科技处审核，提交由用户人工发起）。 */
function startElabCsfJob(root: string, job: ElabHcJob, jobId: string, config: Record<string, unknown>) {
  const configPath = path.join(root, "data", "autobx_logs", `elab_csf_${jobId}.json`);
  void (async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    const child = startSchoolScript(root, "tools/auto_elab_csf_e2e.py", ["--config", configPath]);
    job.child = child;
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) {
        if (!text.trim()) continue;
        job.log.push(text.slice(0, 300));
        const step = text.match(/\[elab-csf\] (.+)$/);
        if (step) job.step = step[1].slice(0, 60);
        const bill = text.match(/##BILL##(CSF\d+)/);
        if (bill) job.billNo = bill[1];
        if (text.includes("##ELABSUBMITTED##")) job.submitted = true;
        serverTrace({ level: "info", scope: "elab-csf", event: "log", detail: text.slice(0, 200), task: "elab前置单" });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      job.log.push(`stderr: ${chunk.toString().slice(0, 300)}`);
    });
    void child.on("close", AsyncLocalStorage.bind((code: number | null) => {
      if (job.stopRequested) {
        job.state = "stopped";
        job.error = "已人工停止。elab 可能残留草稿单，请在 elab 列表页核对。";
      } else if (code !== 0) {
        job.state = "failed";
        job.error = job.log.filter((entry) => entry.includes("FAIL") || entry.startsWith("stderr:")).slice(-1)[0] ?? `退出码 ${code}`;
      } else if (job.billNo && job.submitted) {
        job.state = "submitted";
      } else {
        job.state = job.billNo ? "draft_saved" : "failed";
        if (!job.billNo) job.error = "流程结束但未捕获 CSF 单号";
      }
      serverTrace({ level: job.state === "failed" ? "error" : job.state === "stopped" ? "warn" : "info", scope: "elab-csf", event: job.state, detail: job.billNo ? (job.submitted ? `已提交 ${job.billNo}` : `草稿单号 ${job.billNo}`) : job.error ?? "", durationMs: Date.now() - job.startedAt, exitCode: code ?? undefined, task: "elab前置单" });
      if (job.billNo && job.lineId) {
        const config_ = config as { bills?: Array<{ dj?: string; sl?: string }>; expenseIds?: string[] };
        const amount = (config_.bills ?? []).reduce((sum, bill) => sum + Number(bill.dj ?? 0) * Number(bill.sl ?? 1), 0);
        void registerElabBill(root, job.lineId, job.billNo, config_.expenseIds ?? [], Number(amount.toFixed(2)), job.submitted ? "submitted" : "draft", "wxzc")
          .catch((error) => serverTrace({ level: "error", scope: "elab-csf", event: "bill-registered", detail: String(error).slice(0, 120), task: "elab前置单" }));
      }
    }));
  })();
}

async function registerSubmittedBill(root: string, lineId: string, billNo: string, group?: string, projectCode?: string) {
  const file = path.join(root, "data", "reimbursement-model.json");
  const model = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { sets?: Array<Record<string, unknown>>; expenses?: Array<{ setId?: string; typeId?: string }> };
  const set = (model.sets ?? []).find((entry) => entry.id === lineId);
  if (!set) throw new Error(`model set 不存在: ${lineId}`);
  const nos = new Set([...(Array.isArray(set.treasuryBillNos) ? (set.treasuryBillNos as string[]) : []), billNo]);
  set.treasuryBillNo = set.treasuryBillNo || billNo;
  set.treasuryBillNos = Array.from(nos);
  // 分组递交进度：按已提交单据覆盖的费用组判断整集是否递交完成。
  // 只有「有费用的组」全部有已提交单据（或全量口径递交过）才置 submitted——部分递交保持 active 留在「进行中」。
  const submittedGroups = new Set(Array.isArray(set.submittedGroups) ? (set.submittedGroups as string[]) : []);
  submittedGroups.add(group || "__all__");
  set.submittedGroups = Array.from(submittedGroups);
  const DAILY_GROUPS = new Set(["市内交通", "低值易耗设备", "办公用品", "其它（直接财务）", "云服务"]);
  const activeGroups = new Set<string>();
  for (const expense of model.expenses ?? []) {
    if (expense.setId !== lineId) continue;
    const label = expenseCollectionLabel(String(expense.typeId ?? ""), workflowForLine({ id: lineId, kind: "日常" } as never).collections.filter((c) => c.scope === "finance"));
    activeGroups.add(label ?? "其它（直接财务）");
  }
  const allSubmitted = submittedGroups.has("__all__") || [...activeGroups].every((g) => submittedGroups.has(g));
  set.status = allSubmitted ? "submitted" : "active";
  if (allSubmitted && !set.submittedAt) set.submittedAt = new Date().toISOString().slice(0, 10);
  // 自动开单走智能报销平台（YBX）；per-bill 快照记录开单系统（open_bill 直达与轮询分流依据）。
  const bills = Array.isArray(set.treasuryBills) ? (set.treasuryBills as Array<Record<string, unknown>>) : [];
  const record = bills.find((entry) => entry.billNo === billNo);
  if (record) {
    if (!record.system) record.system = "YBX";
    if (projectCode && !record.projectCode) record.projectCode = projectCode;
  } else {
    bills.push({ billNo, system: "YBX", group: group || "全部费用", projectCode });
  }
  set.treasuryBills = bills;
  await fs.writeFile(file, JSON.stringify(model, null, 1) + "\n");
  serverTrace({ level: "info", scope: "online-submit", event: "bill-registered", detail: `${lineId} <- ${billNo}${group ? `（${group}）` : ""}${allSubmitted ? " 全部组已递交" : " 部分组已递交，保持进行中"}`, task: "线上递交" });
}

/** 撤回递交的反向操作：billNo 从 model 登记中移除；无剩余登记时票据集回 active（状态机对称性）。 */
async function unregisterSubmittedBill(root: string, lineId: string, billNo: string, group?: string) {
  const file = path.join(root, "data", "reimbursement-model.json");
  const model = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { sets?: Array<Record<string, unknown>> };
  const set = (model.sets ?? []).find((entry) => entry.id === lineId);
  if (!set) return;
  const nos = new Set(Array.isArray(set.treasuryBillNos) ? (set.treasuryBillNos as string[]) : []);
  nos.delete(billNo);
  set.treasuryBillNos = Array.from(nos);
  const groups = new Set(Array.isArray(set.submittedGroups) ? (set.submittedGroups as string[]) : []);
  groups.delete(group || "__all__");
  set.submittedGroups = Array.from(groups);
  const bills = Array.isArray(set.treasuryBills) ? (set.treasuryBills as Array<Record<string, unknown>>) : [];
  set.treasuryBills = bills.filter((entry) => entry.billNo !== billNo);
  if (set.treasuryBillNo === billNo) set.treasuryBillNo = nos.values().next().value ?? "";
  if (!nos.size) {
    set.status = "active";
    delete set.submittedAt;
  }
  serverTrace({ level: "info", scope: "online-submit", event: "bill-unregistered", detail: `${lineId} -> ${billNo}`, task: "线上递交" });
  await fs.writeFile(file, JSON.stringify(model, null, 1) + "\n");
  serverTrace({ level: "info", scope: "online-submit", event: "bill-unregistered", detail: `${lineId} -> ${billNo}`, task: "线上递交" });
}

/** 启动一个财务系统 e2e 后台任务并接管其输出（三处入口共用：开单/确认递交/撤回递交）。 */
function startE2eJob(root: string, job: OnlineJob, jobId: string, config: Record<string, unknown>, scriptName = "auto_bx_e2e_full.py") {
  const configPath = path.join(root, "data", "autobx_logs", `online_${jobId}.json`);
  void (async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    const child = startSchoolScript(root, `tools/${scriptName}`, ["--config", configPath]);
    job.child = child;
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const text of lines) {
        if (text.trim()) job.log.push(text.slice(0, 300));
        const evidenceDir = text.match(/##EVIDENCE##(.+)/);
        if (evidenceDir) job.evidence = evidenceDir[1].trim();
        if (text.includes("##SUBMITTED##")) job.autoSubmitted = true;
        if (text.includes("##BILL##")) job.billNo = text.split("##BILL##")[1].trim().slice(0, 12);
        const step = text.match(/#(\d+) (.+?) ->/);
        if (step) {
          job.step = `#${step[1]} ${step[2]}`;
          job.progress = Math.max(job.progress ?? 0, stepProgress(job.step));
        }
        serverTrace({ level: "info", scope: "online-submit", event: "log", detail: text.slice(0, 200), task: "线上递交" });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      job.log.push(`stderr: ${chunk.toString().slice(0, 300)}`);
    });
    void child.on("close", AsyncLocalStorage.bind((code: number | null) => {
      const billLine = job.log.find((entry) => /单号/.test(entry));
      const billMatch = billLine?.match(/(\d{7})/);
      if (billMatch) job.billNo = billMatch[1];
      if (job.stopRequested) {
        job.state = "stopped";
        job.error = `已人工停止（${job.step || "中断于未知步骤"}）。财务系统可能残留草稿或发票占用：重新线上递交会按摘要自动撤旧，或用「撤回递交」清理。`;
      } else if (code !== 0) {
        job.state = "failed";
        job.error = `${job.log.filter((entry) => entry.includes("FAIL") || entry.startsWith("stderr:")).slice(-1)[0] ?? `退出码 ${code}`}${job.evidence ? `〔证据包 ${job.evidence.replace(root + "/", "")}〕` : ""}`;
      } else if (job.mode === "full") {
        job.state = job.billNo ? (job.autoSubmitted ? "submitted" : "awaiting") : "failed";
        if (!job.billNo) job.error = job.log.filter((entry) => entry.includes("FAIL")).slice(-1)[0] ?? "开单流程结束但未捕获草稿单号";
      } else if (job.mode === "submit") {
        job.state = "submitted";
      } else {
        job.state = "withdrawn";
      }
      serverTrace({ level: job.state === "failed" ? "error" : job.state === "stopped" ? "warn" : "info", scope: "online-submit", event: job.state, detail: job.billNo ? `草稿单号 ${job.billNo}` : job.error ?? "", durationMs: Date.now() - job.startedAt, exitCode: code ?? undefined, task: "线上递交" });
      // 状态机守卫（2026-09-19 实证教训）：只有「提交申请成功」（state=submitted）才登记 billNo——
      // 保存草稿（awaiting）/失败（failed）/停止（stopped）一律不登记，否则草稿被误标已递交、撤销后状态假死。
      if (job.billNo && job.lineId && job.state === "submitted" && (job.autoSubmitted || job.mode === "submit")) {
        void registerSubmittedBill(root, job.lineId, job.billNo, job.group, job.projectCode).catch((error) => serverTrace({ level: "error", scope: "online-submit", event: "bill-registered", detail: String(error).slice(0, 120), task: "线上递交" }));
      }
      // 撤回递交成功：反向清理登记（billNo 从 model 移除，票据集回 active）
      if (job.lineId && job.state === "withdrawn" && job.billNo) {
        void unregisterSubmittedBill(root, job.lineId, job.billNo, job.group).catch((error) => serverTrace({ level: "error", scope: "online-submit", event: "bill-unregistered", detail: String(error).slice(0, 120), task: "线上递交" }));
      }
    }));
  })();
}

/** 草稿箱重复检查：起 listDrafts e2e，抓回草稿行文本后按摘要惯例匹配（金额可再比对）。5 分钟内复用缓存。 */
async function ensureDraftCheck(root: string, draftChecks: Map<string, { state: "running" | "clean" | "matched" | "error"; checkedAt: number; match?: { billNo: string; text: string; amountMatch: boolean | null }; error?: string }>, lineId: string, summary: string, expectedAmount: string) {
  const cached = draftChecks.get(lineId);
  if (cached && Date.now() - cached.checkedAt < 5 * 60_000 && cached.state !== "running") return;
  draftChecks.set(lineId, { state: "running", checkedAt: Date.now() });
  const job: OnlineJob = { state: "running", mode: "full", step: "", log: [], startedAt: Date.now() };
  const jobId = `drafts-${Date.now()}`;
  const configPath = path.join(root, "data", "autobx_logs", `online_${jobId}.json`);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ listDrafts: true, invoicePaths: [], attachmentPaths: [] }, null, 2));
  const child = startSchoolScript(root, "tools/auto_bx_e2e_full.py", ["--config", configPath]);
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const text of lines) {
      const draftsLine = text.match(/##DRAFTS##(\[.*\])/);
      if (!draftsLine) continue;
      try {
        const rows = JSON.parse(draftsLine[1]) as Array<{ id: string; text: string }>;
        const hit = rows.find((row) => summary && row.text.includes(summary));
        if (hit) {
          const amountInRow = hit.text.match(/[\d,]+\.\d{2}/)?.[0]?.replace(/,/g, "");
          const amountMatch = amountInRow && expectedAmount ? Math.abs(parseFloat(amountInRow) - parseFloat(expectedAmount)) < 0.01 : null;
          draftChecks.set(lineId, { state: "matched", checkedAt: Date.now(), match: { billNo: hit.text.match(/(\d{7})/)?.[1] ?? hit.id, text: hit.text.slice(0, 160), amountMatch } });
        } else {
          draftChecks.set(lineId, { state: "clean", checkedAt: Date.now() });
        }
      } catch {
        draftChecks.set(lineId, { state: "error", checkedAt: Date.now(), error: "草稿清单解析失败" });
      }
    }
  });
  void child.on("close", (code) => {
    const current = draftChecks.get(lineId);
    if (current?.state === "running") draftChecks.set(lineId, { state: code === 0 ? "clean" : "error", checkedAt: Date.now(), error: code === 0 ? undefined : `草稿箱检查退出码 ${code}` });
  });
}

async function writeFormalModel(root: string, value: unknown) {
  if (!value || typeof value !== "object" || JSON.stringify(value).length > 8_000_000) throw new Error("无效的形式化模型状态");
  const target = formalModelPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, target);
}

function preserveArchiveState(root: string, incoming: Record<string, unknown>, saved?: Record<string, unknown>) {
  if (!saved || typeof saved.folder !== "string") return;
  if (saved.lastArchiveRestore) incoming.lastArchiveRestore = saved.lastArchiveRestore;
  const savedArchive = saved.status === "archived" && saved.folder.startsWith("01_报销材料/90_已归档/");
  const staleArchive = saved.status !== "archived"
    && typeof incoming.folder === "string" && incoming.folder.startsWith("01_报销材料/90_已归档/")
    && !existsSync(path.join(root, incoming.folder));
  if ((!savedArchive && !staleArchive) || !existsSync(path.join(root, saved.folder))) return;
  incoming.status = saved.status;
  incoming.folder = saved.folder;
  incoming.archivedAt = savedArchive ? saved.archivedAt : undefined;
}

async function syncArchivedLineSnapshot(root: string, snapshot: FormalModelState["sets"][number]) {
  const linesFile = path.join(root, "data", "receipt-lines.json");
  const raw = await fs.readFile(linesFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return;
  const doc = JSON.parse(raw) as { lines?: FormalModelState["sets"] };
  const index = doc.lines?.findIndex((line) => line.id === snapshot.id) ?? -1;
  if (!doc.lines || index < 0) return;
  const current = doc.lines[index];
  const next = mergeTreasurySnapshot(current, snapshot, snapshot.folder);
  if (next === current) return;
  doc.lines[index] = next;
  await atomicWriteJson(linesFile, doc);
}

type PrinterStatus = {
  name: string;
  deviceUri: string;
  isNetwork: boolean;
  state: "idle" | "printing" | "disabled" | "unknown";
  accepting: boolean;
  /** null 表示尚未探测；本地直连打印机视为恒可达。 */
  reachable: boolean | null;
};

type PrintSettings = { printer: string };

function printSettingsPath(root: string) {
  return path.join(root, PRINT_SETTINGS_FILENAME);
}

async function readPrintSettings(root: string): Promise<PrintSettings> {
  try {
    const value = JSON.parse(await fs.readFile(printSettingsPath(root), "utf8")) as Partial<PrintSettings>;
    return { printer: typeof value.printer === "string" ? value.printer : "" };
  } catch {
    return { printer: "" };
  }
}

async function writePrintSettings(root: string, printer: string) {
  await fs.mkdir(path.dirname(printSettingsPath(root)), { recursive: true });
  await fs.writeFile(printSettingsPath(root), JSON.stringify({ printer }, null, 2), "utf8");
}

async function readPrintLog(root: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, PRINT_LOG_FILENAME), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

async function writePrintLog(root: string, entries: Record<string, string>) {
  const target = path.join(root, PRINT_LOG_FILENAME);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJson(target, entries);
}

/** TCP 端口探测；办公室打印机禁 ping 时仍能判断网络是否可达。 */
function checkTcpReachable(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const NETWORK_URI_SCHEME_PORTS: Record<string, number> = { ipp: 631, ipps: 631, http: 80, https: 443, socket: 9100, lpd: 515, dnssd: 631 };

function printerIsNetwork(deviceUri: string) {
  try {
    const scheme = new URL(deviceUri).protocol.replace(":", "").toLowerCase();
    return scheme in NETWORK_URI_SCHEME_PORTS;
  } catch {
    return false;
  }
}

function printerNetworkEndpoint(deviceUri: string) {
  try {
    const url = new URL(deviceUri);
    const scheme = url.protocol.replace(":", "").toLowerCase();
    const defaultPort = NETWORK_URI_SCHEME_PORTS[scheme];
    // dnssd 的 hostname 是 mDNS 实例名而非主机，交给 resolveDnssdPrinterEndpoint。
    if (defaultPort == null || scheme === "dnssd") return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || host === "localhost" || /^(127\.|::1$)/.test(host)) return null;
    return { host, port: url.port ? Number(url.port) : defaultPort };
  } catch {
    return null;
  }
}

/** dnssd:// URI 记录的是 mDNS 实例名而非主机名，需 dns-sd -L 解析出真实地址后才能探测。 */
function resolveDnssdPrinterEndpoint(deviceUri: string): Promise<{ host: string; port: number } | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(deviceUri);
    } catch {
      serverTrace({ level: "debug", scope: "print", event: "dnssd.resolve", detail: `null (uri 非法: ${deviceUri})` });
      resolve(null);
      return;
    }
    const decoded = decodeURIComponent(url.hostname).replace(/\.$/, "");
    // mDNS 服务实例全名形如「实例名._ipp._tcp.local」，服务类型与 _tcp 之间以点分隔。
    const parts = decoded.match(/^(.+)\._([a-z-]+)\._tcp\.local$/i);
    if (!parts) {
      serverTrace({ level: "debug", scope: "print", event: "dnssd.resolve", detail: `null (uri 解析失败: ${decoded})` });
      resolve(null);
      return;
    }
    const [, instance, service] = parts;
    const child = spawn("dns-sd", ["-L", instance, `_${service}._tcp`, "local."], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (value: { host: string; port: number } | null, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      serverTrace({ level: "debug", scope: "print", event: "dnssd.resolve", detail: `${instance} → ${value ? `${value.host}:${value.port}` : `null (${why ?? "unknown"})`}` });
      resolve(value);
    };
    const timer = setTimeout(() => finish(null, "timeout 3s"), 3_000);
    const onChunk = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/can be reached at ([^\s:]+):(\d+)/);
      if (match) finish({ host: match[1].replace(/\.$/, ""), port: Number(match[2]) });
    };
    // macOS 新版 dns-sd 把查询结果写到 stderr（-h 帮助文本亦然），两路都收。
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("error", (error: NodeJS.ErrnoException) => finish(null, `spawn ${error.code ?? error.message}`));
  });
}

async function printerProbeEndpoint(deviceUri: string) {
  return printerNetworkEndpoint(deviceUri) ?? await resolveDnssdPrinterEndpoint(deviceUri);
}

function windowsMaterials(args: string[], timeout = 20_000) {
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(schoolCodeRoot(), "tools", "windows-materials.ps1"), ...args], { timeout, windowsHide: true });
}

async function listWindowsPrinters(): Promise<PrinterStatus[]> {
  const { stdout } = await windowsMaterials(["-Operation", "printers"]);
  const printers = JSON.parse(stdout) as Array<{ name: string; status: string; port: string; network: boolean; virtual: boolean }>;
  return printers.filter((printer) => !printer.virtual).map((printer): PrinterStatus => {
    const disabled = /offline|error|paused|paperout|paperjam|notavailable/i.test(printer.status);
    return {
      name: printer.name, deviceUri: printer.port, isNetwork: printer.network,
      state: disabled ? "disabled" : /printing|busy/i.test(printer.status) ? "printing" : /normal|idle/i.test(printer.status) ? "idle" : "unknown",
      accepting: !disabled, reachable: disabled ? false : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function listSystemPrinters(): Promise<PrinterStatus[]> {
  if (process.platform === "win32") return listWindowsPrinters();
  let combined = "";
  try {
    const result = await execFileAsync("lpstat", ["-p", "-v", "-a"], { timeout: 8_000 });
    combined = result.stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout !== "string" || !stdout.trim()) return [];
    combined = stdout;
  }
  const printers = new Map<string, PrinterStatus>();
  for (const line of combined.split("\n")) {
    const deviceMatch = line.match(/^device for ([^:\s]+):\s*(\S+)/);
    if (deviceMatch) {
      const [, name, deviceUri] = deviceMatch;
      const printer = printers.get(name) ?? { name, deviceUri: "", isNetwork: false, state: "unknown", accepting: false, reachable: null };
      printer.deviceUri = deviceUri;
      printer.isNetwork = printerIsNetwork(deviceUri);
      printers.set(name, printer);
      continue;
    }
    const stateMatch = line.match(/^printer (\S+) is (idle|printing|stopped)\./);
    if (stateMatch) {
      const [, name, state] = stateMatch;
      const printer = printers.get(name) ?? { name, deviceUri: "", isNetwork: false, state: "unknown", accepting: false, reachable: null };
      printer.state = state === "stopped" ? "disabled" : (state as "idle" | "printing");
      printers.set(name, printer);
      continue;
    }
    const disabledMatch = line.match(/^printer (\S+) disabled since/);
    if (disabledMatch) {
      const name = disabledMatch[1];
      const printer = printers.get(name) ?? { name, deviceUri: "", isNetwork: false, state: "unknown", accepting: false, reachable: null };
      printer.state = "disabled";
      printers.set(name, printer);
      continue;
    }
    const acceptingMatch = line.match(/^(\S+) (not )?accepting requests since/);
    if (acceptingMatch) {
      const name = acceptingMatch[1];
      const printer = printers.get(name) ?? { name, deviceUri: "", isNetwork: false, state: "unknown", accepting: false, reachable: null };
      printer.accepting = !acceptingMatch[2];
      printers.set(name, printer);
    }
  }
  // 本地直连（USB 等）打印机视为恒可达；网络打印机（含 dnssd）并发解析并探测 TCP 端口。
  // dnssd 解析失败（超时/不在同一网络）不得回退为“可达”——那是把网络打印机误当本地直连。
  await Promise.all(Array.from(printers.values()).map(async (printer) => {
    if (!printer.isNetwork) { printer.reachable = true; return; }
    const endpoint = await printerProbeEndpoint(printer.deviceUri);
    printer.reachable = endpoint ? await checkTcpReachable(endpoint.host, endpoint.port) : false;
  }));
  return Array.from(printers.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** CUPS 队列中尚未完成的任务 id（打印中/滞留/挂起）；提交前拦截重复打印，提交后用于确认完成。 */
async function cupsPendingJobs(printerName: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lpstat", ["-W", "not-completed", "-o", printerName], { timeout: 8_000 });
    return stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  } catch {
    return [];
  }
}

type CupsJobOutcome = "completed" | "lost" | "unconfirmed";

/** 轮询等待任务全部离开 CUPS 待完成队列；离开后须出现在 completed 列表才算真正打出，否则视为失败/未确认。 */
async function waitForCupsJobs(printerName: string, jobIds: string[], timeoutMs = 150_000): Promise<Map<string, CupsJobOutcome>> {
  const outcomes = new Map<string, CupsJobOutcome>();
  const pending = new Set(jobIds);
  const deadline = Date.now() + timeoutMs;
  while (pending.size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    let notCompleted = "";
    let completed = "";
    try {
      notCompleted = (await execFileAsync("lpstat", ["-W", "not-completed", "-o", printerName], { timeout: 8_000 })).stdout;
      completed = (await execFileAsync("lpstat", ["-W", "completed", "-o", printerName], { timeout: 8_000 })).stdout;
    } catch {
      continue;
    }
    for (const jobId of Array.from(pending)) {
      if (notCompleted.includes(jobId)) continue;
      pending.delete(jobId);
      outcomes.set(jobId, completed.includes(jobId) ? "completed" : "lost");
    }
  }
  for (const jobId of pending) outcomes.set(jobId, "unconfirmed");
  return outcomes;
}

/** 打印执行：CUPS lp 提交任务，确认任务真正完成（出队且进入 completed）后才按内容哈希记录打印日期；提交前拦截队列滞留任务。 */
// 打包选中材料为 zip（用户手动递交财务：下载后发送/拷贝给财务助手）
async function buildSelectionZip(root: string, requestPaths: string[]): Promise<{ buffer: Buffer; name: string }> {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-zip-"));
  const zipPath = `${stagingRoot}.zip`;
  try {
    const used = new Map<string, number>();
    let count = 0;
    const missing: string[] = [];
    for (const requestPath of requestPaths) {
      const materialPath = safeMaterialPath(root, requestPath);
      if (!materialPath || !existsSync(materialPath)) { missing.push(path.basename(requestPath)); continue; }
      const base = path.basename(materialPath);
      const seen = (used.get(base) ?? 0) + 1;
      used.set(base, seen);
      const staged = seen === 1 ? base : `${seen - 1}_${base}`;
      await fs.copyFile(materialPath, path.join(stagingRoot, staged));
      count += 1;
    }
    if (!count) throw new Error(`选中的材料都不存在（可能已改名）：${missing.join("、")}——请先「重新对齐」再下载`);
    // 用 python zipfile 而非 macOS zip 命令：后者不写 UTF-8 文件名标志，中文文件名在 Windows 解压会乱码（财务收到的 zip 必须跨平台可读）
    const pyScript = "import sys, zipfile, os\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n    for name in sorted(os.listdir(sys.argv[2])):\n        z.write(os.path.join(sys.argv[2], name), name)\n";
    await runSchoolPython(root, ["-c", pyScript, zipPath, stagingRoot], 60_000);
    const buffer = await fs.readFile(zipPath);
    return { buffer, name: `递交材料-${new Date().toISOString().slice(0, 10)}.zip` };
  } finally {
    await fs.rm(zipPath, { force: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function submitPrintJobs(root: string, printerName: string, requestPaths: string[]) {
  // 滞留任务多半是打印机离线时遗留的（网络恢复后 CUPS 会全部重放）；不追加，避免新旧任务一起重复打出。
  const backlog = await cupsPendingJobs(printerName);
  if (backlog.length) throw new Error(`打印队列中已有 ${backlog.length} 个未完成任务，可能是此前打印机离线时滞留的旧任务；请先在 系统设置→打印机 队列中处理后再打印`);
  const entries = await readPrintLog(root);
  const printed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  const submitted = new Map<string, { materialPath: string; requestPath: string }>();
  const today = new Date().toISOString().slice(0, 10);
  for (const requestPath of requestPaths) {
    try {
      const materialPath = safeMaterialPath(root, requestPath);
      if (!materialPath || !existsSync(materialPath)) throw new Error("材料不存在");
      if (!PRINTABLE_EXTENSIONS.has(path.extname(materialPath).toLowerCase())) throw new Error("该格式不支持直接打印，请先导出 PDF");
      const { stdout } = await execFileAsync("lp", ["-d", printerName, materialPath], { timeout: 30_000 });
      const jobId = stdout.match(/request id is (\S+)/)?.[1];
      if (!jobId) throw new Error("打印任务已提交但无法确认队列编号，请在打印机旁确认出纸后再补记");
      submitted.set(jobId, { materialPath, requestPath });
      serverTrace({ level: "info", scope: "print", event: "lp.submit", detail: `${path.basename(materialPath)} → ${printerName} (${jobId})` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "打印任务提交失败";
      serverTrace({ level: "error", scope: "print", event: "lp.fail", detail: `${path.basename(requestPath)} — ${message}` });
      failed.push({ path: requestPath, error: message });
    }
  }
  if (submitted.size) {
    const outcomes = await waitForCupsJobs(printerName, Array.from(submitted.keys()));
    for (const [jobId, outcome] of outcomes) {
      const target = submitted.get(jobId)!;
      if (outcome === "completed") {
        entries[await fileContentHash(target.materialPath)] = today;
        printed.push(target.requestPath);
        serverTrace({ level: "info", scope: "print", event: "lp.done", detail: `${jobId} ${path.basename(target.materialPath)}` });
      } else {
        const message = outcome === "lost"
          ? "打印任务中途终止（被取消或队列异常），未打印成功"
          : "已提交至打印队列但迟迟未完成，请检查打印机电源与网络后再试；请勿立即重复打印";
        serverTrace({ level: "warn", scope: "print", event: outcome === "lost" ? "lp.lost" : "lp.unconfirmed", detail: `${jobId} ${path.basename(target.materialPath)}` });
        failed.push({ path: target.requestPath, error: message });
      }
    }
  }
  if (printed.length) await writePrintLog(root, entries);
  return { printed, failed, entries };
}

let windowsPrinting = false;
type PendingWindowsPrint = { date: string; printer?: string; jobName?: string };
const WINDOWS_PENDING_PRINTS = path.join(".guanzizai", "print-pending.json");

async function readWindowsPendingPrints(root: string) {
  if (process.platform !== "win32") return new Map<string, PendingWindowsPrint>();
  try {
    const entries = JSON.parse(await fs.readFile(path.join(root, WINDOWS_PENDING_PRINTS), "utf8")) as Record<string, PendingWindowsPrint & { hash?: string }>;
    const pending = new Map<string, PendingWindowsPrint>();
    for (const [key, entry] of Object.entries(entries)) {
      const hash = entry?.hash ?? key;
      if (entry && /^[a-f0-9]{64}$/.test(hash) && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
        pending.set(hash, { date: entry.date, printer: entry.printer, jobName: entry.jobName });
      }
    }
    return pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map<string, PendingWindowsPrint>();
    throw error;
  }
}

async function writeWindowsPendingPrints(root: string, pending: Map<string, PendingWindowsPrint>) {
  const target = path.join(root, WINDOWS_PENDING_PRINTS);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJson(target, Object.fromEntries(pending));
}

async function submitWindowsPrintJobs(root: string, printerName: string, requestPaths: string[]) {
  if (windowsPrinting) throw new Error("打印机正在处理上一批材料");
  windowsPrinting = true;
  try {
    const pendingWindowsPrints = await readWindowsPendingPrints(root);
    const { stdout } = await windowsMaterials(["-Operation", "queue", "-Printer", printerName]);
    if (Number(stdout.trim()) > 0) throw new Error("打印队列尚有未完成任务，请先核对系统队列");
    const entries = await readPrintLog(root);
    const failed: Array<{ path: string; error: string }> = [];
    const date = new Date().toISOString().slice(0, 10);
    for (const requestPath of new Set(requestPaths)) {
      const material = safeMaterialPath(root, requestPath);
      if (!material || !existsSync(material) || !PRINTABLE_EXTENSIONS.has(path.extname(material).toLowerCase())) {
        failed.push({ path: requestPath, error: "材料不存在或格式不可直接打印" });
        continue;
      }
      const hash = await fileContentHash(material);
      if (entries[hash]) continue;
      if (pendingWindowsPrints.has(hash)) continue;
      const jobName = `Receipt ${randomUUID()}`;
      pendingWindowsPrints.set(hash, { date, printer: printerName, jobName });
      await writeWindowsPendingPrints(root, pendingWindowsPrints);
      try {
        await windowsMaterials(["-Operation", "print", "-Printer", printerName, "-Source", material, "-JobName", jobName], 150_000);
      } catch {
        // A process error or timeout can happen after the Windows driver accepted the job.
      }
      serverTrace({ level: "warn", scope: "print", event: "lp.unconfirmed" });
    }
    return { printed: [], unconfirmedHashes: [...pendingWindowsPrints.keys()], failed, entries };
  } finally {
    windowsPrinting = false;
  }
}

type OnlineExchangeRate = { currency: typeof ONLINE_RATE_CURRENCIES[number]; cnyRate: number; effectiveDate: string };

/** Frankfurter 返回的是每 1 CNY 可兑换多少外币；票据簿统一存为每 1 外币折合 CNY。 */
async function fetchOnlineExchangeRates(): Promise<OnlineExchangeRate[]> {
  const query = new URLSearchParams({ base: "CNY", quotes: ONLINE_RATE_CURRENCIES.join(",") });
  const response = await fetch(`${EXCHANGE_RATE_API}?${query}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`在线汇率服务返回 ${response.status}`);
  const payload = await response.json() as Array<{ date?: string; quote?: string; rate?: number }>;
  const rates = payload.flatMap((item) => {
    if (!item.quote || !ONLINE_RATE_CURRENCIES.includes(item.quote as typeof ONLINE_RATE_CURRENCIES[number]) || !Number.isFinite(item.rate) || !item.rate || !/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? "")) return [];
    return [{ currency: item.quote as typeof ONLINE_RATE_CURRENCIES[number], cnyRate: 1 / item.rate, effectiveDate: item.date! }];
  });
  if (rates.length !== ONLINE_RATE_CURRENCIES.length) throw new Error("在线汇率数据不完整，未覆盖全部常用币种");
  return rates;
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

const serverTrace = diagnostics.record;

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage) {
  return JSON.parse((await readBody(request)).toString("utf8")) as unknown;
}

function hasSavedApiKey() {
  return credentials.has(API_KEYCHAIN_SERVICE);
}

async function readSchoolSsoPassword(profileId: string, account: string) {
  const service = profileKeychainService(SCHOOL_SSO_KEYCHAIN_SERVICE, profileId);
  try {
    const stored = await credentials.read(service);
    if (process.platform !== "win32") return stored;
    const entry = JSON.parse(stored) as { account?: string; password?: string };
    if (entry.account !== account.trim() || !entry.password) throw new Error();
    return entry.password;
  } catch {
    throw new Error("尚未为这个学校账号保存 SSO 密码");
  }
}

type SsoIdentity = { employeeId: string; organization: string };
type SsoValidation = { state: "success" | "failed" | "requires_interaction" | "missing_account"; message: string; identity?: SsoIdentity };

type BrowserRuntimeConfig = { executablePath: string; browserName: string; browserVersion: string };
type BrowserRuntimeStatus = { executablePath: string; managedPath: string; source: "custom" | "managed" | "none"; customAvailable: boolean; managedAvailable: boolean; installing: boolean; installError: string; browserName: string; browserVersion: string };

function browserRuntimeDirectory(root: string) {
  return path.join(root, ".guanzizai", "browser-runtime");
}

function browserRuntimeConfigPath(root: string) {
  return path.join(root, ".guanzizai", "browser-runtime.json");
}

async function readBrowserRuntimeConfig(root: string): Promise<BrowserRuntimeConfig> {
  try {
    const config = JSON.parse(await fs.readFile(browserRuntimeConfigPath(root), "utf8")) as Partial<BrowserRuntimeConfig>;
    return { executablePath: typeof config.executablePath === "string" ? config.executablePath : "", browserName: typeof config.browserName === "string" ? config.browserName : "", browserVersion: typeof config.browserVersion === "string" ? config.browserVersion : "" };
  } catch {
    return { executablePath: "", browserName: "", browserVersion: "" };
  }
}

async function writeBrowserRuntimeConfig(root: string, executablePath: string, browserName = "", browserVersion = "") {
  if (executablePath && !path.isAbsolute(executablePath)) throw new Error("浏览器路径必须为绝对路径");
  await fs.mkdir(path.dirname(browserRuntimeConfigPath(root)), { recursive: true });
  await fs.writeFile(browserRuntimeConfigPath(root), JSON.stringify({ executablePath, browserName, browserVersion }, null, 2), "utf8");
}

function browserNameFromExecutable(executablePath: string) {
  if (executablePath.includes("Microsoft Edge") || path.basename(executablePath).toLowerCase() === "msedge.exe") return "Microsoft Edge";
  if (executablePath.includes("Google Chrome") || path.basename(executablePath).toLowerCase() === "chrome.exe") return "Google Chrome";
  return "Chromium";
}

async function normalizeBrowserExecutable(candidate: string) {
  if (!candidate || !path.isAbsolute(candidate)) return "";
  const resolved = path.resolve(candidate);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isFile()) return resolved;
    if (!stat.isDirectory() || !resolved.endsWith(".app")) return "";
    const executableNames = ["Google Chrome", "Google Chrome for Testing", "Microsoft Edge", "Chromium"];
    for (const executableName of executableNames) {
      const executablePath = path.join(resolved, "Contents", "MacOS", executableName);
      if (existsSync(executablePath)) return executablePath;
    }
  } catch { /* The selected path is unavailable. */ }
  return "";
}

async function scanBrowserExecutables(root: string) {
  const windowsRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
  const candidates = process.platform === "win32" ? [...new Set(windowsRoots)].flatMap((directory) => [
    ["Microsoft Edge", path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe")],
    ["Google Chrome", path.join(directory, "Google", "Chrome", "Application", "chrome.exe")],
  ] as const) : [
    ["Google Chrome", "/Applications/Google Chrome.app"],
    ["Google Chrome for Testing", "/Applications/Google Chrome for Testing.app"],
    ["Microsoft Edge", "/Applications/Microsoft Edge.app"],
    ["Chromium", "/Applications/Chromium.app"],
    ["Google Chrome", path.join(homedir(), "Applications", "Google Chrome.app")],
    ["Microsoft Edge", path.join(homedir(), "Applications", "Microsoft Edge.app")],
  ] as const;
  const found: Array<{ label: string; executablePath: string }> = [];
  for (const [label, candidate] of candidates) {
    const executablePath = await normalizeBrowserExecutable(candidate);
    if (executablePath) found.push({ label, executablePath });
  }
  const managedPath = await managedChromiumPath(root);
  if (managedPath) found.push({ label: "票据簿 Chromium", executablePath: managedPath });
  return found;
}

/** 说明类 PDF 的统一版式：标题居中 + 宋体小四正文 + 右对齐落款（签名内嵌）。
 *  财务报销系统只接受 PDF 上传，说明不再输出 Word。 */
function explanationHtml(title: string, intro: string, body: string, organization: string, dateText: string, signatureDataUrl = ""): string {
  const signature = signatureDataUrl
    ? `<img class="sig-img" src="${signatureDataUrl}" alt="签名" />`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 3.2cm 3cm; }
body { font-family: "Songti SC", STSong, SimSun, serif; font-size: 14pt; line-height: 2; color: #000; }
h1 { text-align: center; font-size: 18pt; font-weight: 700; letter-spacing: .35em; margin: 0 0 .8em; font-family: "Songti SC", STSong, serif; }
p { text-indent: 2em; margin: 0 0 .2em; text-align: justify; }
.sign-area { margin-top: 2.2em; text-align: right; }
.sign-block { text-indent: 0; line-height: 1.8; display: inline-block; }
.sig-img { height: 46px; vertical-align: middle; margin-left: 1em; }
.date { text-indent: 0; margin-top: .3em; letter-spacing: .12em; text-align: right; padding-right: 1em; }
</style></head><body>
<h1>${title}</h1>
<p>${intro}</p>
<p>${body}</p>
<p>以上情况属实，特此说明。</p>
<div class="sign-area">
<div class="sign-block">说明人：${signature}</div>
<p class="date">${organization}</p>
<p class="date">${dateText}</p>
</div>
</body></html>`;
}

/** Chrome headless 渲染 HTML 为 PDF；浏览器复用系统探测（含托管 Chromium）。 */
async function renderExplanationPdf(root: string, target: string, html: string) {
  const browsers = await scanBrowserExecutables(root);
  const executable = browsers[0]?.executablePath;
  if (!executable) throw new Error("未找到可用于渲染 PDF 的 Chrome/Chromium，请先在系统设置中验证浏览器");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "", { flag: "w" });
  await execFileAsync(executable, ["--headless", "--disable-gpu", `--print-to-pdf=${target}`, "--no-pdf-header-footer", `data:text/html;charset=utf-8,${encodeURIComponent(html)}`], { timeout: 30_000 });
}

/** 生成说明 PDF：交通/改签共用版式。title 与 filename 由调用方给。 */
async function createExplanationPdf(root: string, target: string, kind: "traffic" | "rebooking", content: string, noteDate: string, writer: { name: string; organization: string; title: string }, signaturePath = "") {
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(noteDate) ? noteDate : new Date().toISOString().slice(0, 10);
  const [year, month, day] = normalizedDate.split("-").map(Number);
  const identity = writer.name ? `本人${writer.name}，系${writer.organization || "华东师范大学"}${writer.title || "教职工"}。` : "本人";
  const intro = kind === "traffic"
    ? `${identity}现就本人于${month}月${day}日参加相关活动期间的交通安排情况说明如下：`
    : `${identity}现就本人于${year}年${month}月参加相关活动期间的机票改签情况说明如下：`;
  const body = content.replace(/^以上情况属实，特此说明。?/, "").trim();
  const signature = await signatureDataUrl(signaturePath);
  const html = explanationHtml(kind === "traffic" ? "交通情况说明" : "机票改签情况说明", intro, body, writer.organization || "华东师范大学", `${year} 年 ${month} 月 ${day} 日`, signature);
  await renderExplanationPdf(root, target, html);
}

async function signatureDataUrl(signaturePath: string): Promise<string> {
  if (!signaturePath || !existsSync(signaturePath)) return "";
  const { stdout } = await execFileAsync("sips", ["-s", "format", "png", "-Z", "480", signaturePath, "--out", path.join(tmpdir(), `guanzizai-sig-${Date.now()}.png`)], { timeout: 10_000 });
  const converted = /written to (\S+)/.exec(stdout)?.[1] ?? signaturePath;
  const buffer = await fs.readFile(converted);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function validateBrowserExecutable(executablePath: string) {
  const normalized = await normalizeBrowserExecutable(executablePath);
  if (!normalized) return { available: false, message: "未找到可执行的 Chrome 或 Chromium" };
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ executablePath: normalized, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
    try {
      const version = browser.version();
      return { available: true, message: `浏览器可用：${browserNameFromExecutable(normalized)} ${version}`, executablePath: normalized, browserName: browserNameFromExecutable(normalized), browserVersion: version };
    } finally {
      await browser.close();
    }
  } catch {
    return { available: false, message: "该浏览器无法由票据簿启动，请更换路径" };
  }
}

async function chooseBrowserExecutable() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", 'POSIX path of (choose file with prompt "选择 Chrome 或 Chromium 应用")'], { timeout: 120_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function managedChromiumPath(root: string) {
  const directory = browserRuntimeDirectory(root);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const application = process.arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac";
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue;
      const executablePath = path.join(directory, entry.name, application, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(executablePath)) return executablePath;
    }
  } catch { /* Runtime has not been downloaded yet. */ }
  return "";
}

async function browserRuntimeStatus(root: string): Promise<BrowserRuntimeStatus> {
  const config = await readBrowserRuntimeConfig(root);
  const managedPath = await managedChromiumPath(root);
  const customAvailable = Boolean(config.executablePath && existsSync(config.executablePath));
  const managedAvailable = existsSync(managedPath);
  let browserName = customAvailable ? config.browserName : managedAvailable ? "票据簿 Chromium" : "";
  let browserVersion = customAvailable ? config.browserVersion : "";
  const activePath = customAvailable ? config.executablePath : managedAvailable ? managedPath : "";
  if (activePath && (!browserName || !browserVersion)) {
    const validation = await validateBrowserExecutable(activePath);
    if (validation.available) {
      browserName = validation.browserName ?? browserNameFromExecutable(activePath);
      browserVersion = validation.browserVersion ?? "";
      if (customAvailable) await writeBrowserRuntimeConfig(root, config.executablePath, browserName, browserVersion);
    }
  }
  return {
    executablePath: config.executablePath,
    managedPath,
    source: customAvailable ? "custom" : managedAvailable ? "managed" : "none",
    customAvailable,
    managedAvailable,
    installing: browserInstall !== null,
    installError: browserInstallError,
    browserName,
    browserVersion,
  };
}

function startManagedChromiumInstall(root: string) {
  if (browserInstall) return browserInstall;
  browserInstallError = "";
  browserInstall = execFileAsync(process.execPath, [path.join(schoolCodeRoot(), "node_modules", "playwright", "cli.js"), "install", "chromium"], {
    cwd: root,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRuntimeDirectory(root) },
    timeout: 10 * 60_000,
    maxBuffer: 1_000_000,
  }).then(() => undefined).catch((error) => {
    browserInstallError = error instanceof Error ? "浏览器下载失败，请检查网络后重试" : "浏览器下载失败";
  }).finally(() => {
    browserInstall = null;
  });
  return browserInstall;
}

async function verifyEcnuSso(root: string, profileId: string, account: string): Promise<SsoValidation> {
  if (!account.trim()) return { state: "missing_account", message: "请先填写学校 SSO 账号" };
  const password = await readSchoolSsoPassword(profileId, account);
  const runtime = await browserRuntimeStatus(root);
  if (runtime.source === "none") return { state: "requires_interaction", message: "请配置浏览器路径，或下载票据簿验证浏览器" };
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath: runtime.source === "custom" ? runtime.executablePath : runtime.managedPath,
    headless: false,
    args: ["--incognito", "--no-first-run", "--no-default-browser-check"],
  });
  try {
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    await page.goto(ECNU_PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const username = page.locator('input[placeholder="username"], input[name="username"], input[type="text"]').first();
    const passwordInput = page.locator('input[type="password"]').first();
    await username.waitFor({ state: "visible", timeout: 12_000 });
    await username.fill(account.trim());
    await passwordInput.fill(password);
    await page.getByRole("button", { name: /Sign In|登录/ }).first().click();
    await page.waitForTimeout(1_000);
    await page.waitForURL(/portal2023\.ecnu\.edu\.cn\/portal\/home/, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForFunction(() => /学院|学部|研究院|研究中心|部门|办公室/.test(document.body.innerText), { timeout: 8_000 }).catch(() => undefined);
    const frameTexts = await Promise.all(page.frames().map((frame) => frame.locator("body").innerText({ timeout: 3_000 }).catch(() => "")));
    const pageText = frameTexts.join("\n");
    if (/^https:\/\/portal2023\.ecnu\.edu\.cn\/portal(?:\/|$)/.test(page.url())) {
      const lines = pageText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const employeeId = lines.find((line) => /^\d{6,14}$/.test(line)) ?? account.trim();
      const organization = lines.flatMap((line) => Array.from(line.matchAll(/[\u4e00-\u9fa5]{2,30}(?:学院|学部|研究院|研究中心|部门|处|办公室|系)/g), (match) => match[0])).sort((first, second) => second.length - first.length)[0] ?? "";
      const identity = { employeeId, organization };
      return { state: "success", message: `已使用 系统中保存的学校 SSO 密码；门户验证通过${organization ? ` · ${organization}` : ""}`, identity };
    }
    if (/验证码|短信验证|二次验证|扫码登录|Passkey/.test(pageText)) {
      return { state: "requires_interaction", message: "已使用 系统中保存的学校 SSO 密码；学校 SSO 要求人工完成验证码或二次验证" };
    }
    if (/用户名或密码错误|账号或密码错误|登录失败/.test(pageText)) {
      return { state: "failed", message: "已使用 系统中保存的学校 SSO 密码；学校 SSO 提示账号或密码错误" };
    }
    return { state: "requires_interaction", message: "已使用 系统中保存的学校 SSO 密码；Chrome 未取得明确登录结果，请在门户中人工确认" };
  } finally {
    await browser.close();
  }
}

function safeProfileId(value: string) {
  return /^user-[a-z0-9-]+$|^profile-default$/.test(value) ? value : null;
}

function profileKeychainService(base: string, profileId: string) {
  return `${base}-${profileId}`;
}

function profileSignaturePath(root: string, profileId: string) {
  return path.join(root, ".guanzizai", "user-profiles", profileId, "signature.png");
}

function userProfilesPath(root: string) {
  return path.join(root, ".guanzizai", "user-profiles", "profiles.json");
}

function aiSettingsPath(root: string) {
  return path.join(root, ".guanzizai", AI_SETTINGS_FILENAME);
}

function normalizeAiSettings(value: unknown) {
  const input = value && typeof value === "object" ? value as { backend?: unknown; model?: unknown; apiBaseUrl?: unknown } : {};
  return {
    backend: input.backend === "api" || input.backend === "codex" || input.backend === "opencode" ? input.backend : "off",
    model: typeof input.model === "string" ? input.model.trim().slice(0, 160) : "",
    apiBaseUrl: typeof input.apiBaseUrl === "string" && /^https?:\/\/[^\s]+$/.test(input.apiBaseUrl.trim()) ? input.apiBaseUrl.trim().replace(/\/+$/, "") : "",
  };
}

async function readAiSettings(root: string) {
  try {
    return normalizeAiSettings(JSON.parse(await fs.readFile(aiSettingsPath(root), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return normalizeAiSettings({});
  }
}

async function writeAiSettings(root: string, settings: unknown) {
  const normalized = normalizeAiSettings(settings);
  await fs.mkdir(path.dirname(aiSettingsPath(root)), { recursive: true });
  await fs.writeFile(aiSettingsPath(root), JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}

function withStoredSignature(root: string, profiles: unknown[]) {
  return profiles.map((record) => {
    if (!record || typeof record !== "object") return record;
    const item = record as { id?: unknown; profile?: unknown };
    const profileId = typeof item.id === "string" ? safeProfileId(item.id) : null;
    if (!profileId || !item.profile || typeof item.profile !== "object") return record;
    const profile = item.profile as Record<string, unknown>;
    const schoolSsoAccount = typeof profile.schoolSsoAccount === "string" ? profile.schoolSsoAccount : typeof profile.financeAccount === "string" ? profile.financeAccount : typeof profile.foreignAffairsAccount === "string" ? profile.foreignAffairsAccount : "";
    return { ...item, profile: { ...profile, schoolSsoAccount, signatureUpdated: profile.signatureUpdated === true || existsSync(profileSignaturePath(root, profileId)) } };
  });
}

async function readUserProfiles(root: string) {
  try {
    const profiles = JSON.parse(await fs.readFile(userProfilesPath(root), "utf8")) as unknown;
    return Array.isArray(profiles) ? withStoredSignature(root, profiles) : [];
  } catch {
    return [];
  }
}

async function trafficNoteWriter(root: string, profileId?: string) {
  const safeId = profileId ? safeProfileId(profileId) : null;
  if (!safeId) return { name: "", organization: "", title: "教职工" };
  const profiles = await readUserProfiles(root) as Array<{ id?: string; profile?: { chineseName?: string; organization?: string; invoiceTitle?: string; jobTitle?: string } }>;
  const profile = profiles.find((item) => item.id === safeId)?.profile;
  const school = profile?.invoiceTitle?.trim() ?? "";
  const college = profile?.organization?.trim() ?? "";
  return { name: profile?.chineseName?.trim() ?? "", organization: school && college && !college.includes(school) ? `${school}${college}` : college || school, title: profile?.jobTitle?.trim() || "教职工" };
}

async function writeUserProfiles(root: string, profiles: unknown) {
  if (!Array.isArray(profiles) || JSON.stringify(profiles).length > 1_000_000) throw new Error("无效的用户资料");
  const target = userProfilesPath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteJson(target, withStoredSignature(root, profiles));
}

const MEMBERSHIP_WEBSITES: Record<string, string> = {
  CCF: "https://passport.ccf.org.cn/",
  IEEE: "https://www.ieee.org/membership",
  ACM: "https://www.acm.org/",
};

function membershipTextValue(text: string, label: string) {
  return text.match(new RegExp(`${label}\\s*[：:]\\s*([^\\n]+)`))?.[1]?.trim() ?? "";
}

function isoDateFromEnglish(value: string) {
  const match = value.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return "";
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[2].toLowerCase());
  return month < 0 ? "" : `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function isoDateFromMonthYear(value: string, endOfMonth = false) {
  const match = value.match(/(0[1-9]|1[0-2])\/(\d{4})/);
  if (!match) return "";
  const month = Number(match[1]);
  const year = Number(match[2]);
  const day = endOfMonth ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function membershipFromPdf(absolutePath: string, filename: string) {
  const stdout = await pdfText(absolutePath);
  const organization = `${filename}\n${stdout}`.match(/CCF|IEEE|ACM/i)?.[0]?.toUpperCase();
  if (!organization) throw new Error("未能从该 PDF 判断会员组织，请使用包含 CCF、IEEE 或 ACM 的会员凭证");
  const number = membershipTextValue(stdout, "会员号") || (stdout.match(/Member\s*#\s*([A-Z0-9]+)/i)?.[1] ?? "") || (stdout.match(/Client\s*(?:No|#)\s*[:：]?\s*([A-Z0-9]+)/i)?.[1] ?? "");
  const acmMembershipPeriod = organization === "ACM" ? stdout.match(/Acm\s+Professional\s+Membership[\s\S]{0,120}?(\d{2}\/\d{4})\s+(\d{2}\/\d{4})/i) : null;
  const level = membershipTextValue(stdout, "会员类型") || membershipTextValue(stdout, "会员等级") || (organization === "IEEE" && /IEEE Member/i.test(stdout) ? "IEEE Member" : "") || (organization === "ACM" && /Acm\s+Professional\s+Membership/i.test(stdout) ? "ACM Professional" : "");
  const effectiveDate = membershipTextValue(stdout, "生效日期") || (acmMembershipPeriod ? isoDateFromMonthYear(acmMembershipPeriod[1]) : "");
  const englishValidDate = stdout.match(/Valid through\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)?.[1];
  const validUntil = membershipTextValue(stdout, "有效期至") || (englishValidDate ? isoDateFromEnglish(englishValidDate) : "") || (acmMembershipPeriod ? isoDateFromMonthYear(acmMembershipPeriod[2], true) : "");
  const status = membershipTextValue(stdout, "会员状态") || (/Valid through/i.test(stdout) ? "有效" : validUntil ? (validUntil >= new Date().toISOString().slice(0, 10) ? "有效" : "已过期") : "");
  return { id: `${organization.toLowerCase()}-${number || createHash("sha256").update(absolutePath).digest("hex").slice(0, 8)}`, organization, website: MEMBERSHIP_WEBSITES[organization], number, level, status, effectiveDate, validUntil };
}

async function readSavedApiKey() {
  return credentials.read(API_KEYCHAIN_SERVICE).catch(() => "");
}

/** 解析 API 直连服务商：显式 baseUrl 优先（任意 OpenAI 兼容服务商）；为空时按 Key 前缀给默认值（sk-*→OpenAI，其余→智谱 Coding Plan 端点）。 */
function apiProviderForApiKey(apiKey: string, baseUrl = "") {
  if (baseUrl && /^https?:\/\/[^\s]+$/.test(baseUrl)) {
    return { label: baseUrl.includes("open.bigmodel.cn") ? "智谱" : baseUrl, baseUrl, defaultModel: baseUrl.includes("open.bigmodel.cn") ? "glm-4.6v" : "", modelPattern: /.*/ };
  }
  if (apiKey.startsWith("sk-") || apiKey.startsWith("gsk_")) {
    return { label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1-mini", modelPattern: /^gpt-(?!image|realtime|audio|4o-transcribe|4o-mini-transcribe)/ };
  }
  return { label: "智谱", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", defaultModel: "glm-4.6v", modelPattern: /^glm-/ };
}

type ChatImage = { mediaType: string; base64: string };

/** 统一的对话调用：OpenAI chat/completions 格式（智谱 Coding Plan 端点亦兼容，图片走 image_url）。 */
async function callChatModel(
  provider: ReturnType<typeof apiProviderForApiKey>,
  apiKey: string,
  options: { model: string; prompt: string; images?: ChatImage[]; maxTokens?: number; temperature?: number; disableThinking?: boolean; signal?: AbortSignal },
) {
  const images = options.images ?? [];
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    signal: options.signal,
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.disableThinking ? { thinking: { type: "disabled" } } : {}),
      max_tokens: options.maxTokens ?? 1_024,
      messages: [{ role: "user", content: images.length ? [{ type: "text", text: options.prompt }, ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }))] : options.prompt }],
    }),
  });
  const payload = await response.json() as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "AI 调用失败");
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content?.trim() || "";
  // 智谱端点偶发返回空 choices（服务端抖动）；分类等幂等调用由调用方重试，这里抛出明确错误。
  if (!content && !choices) throw new Error("AI 服务返回空响应，请重试");
  return content;
}

async function chatImageFromFile(absolutePath: string): Promise<ChatImage> {
  const file = await fs.readFile(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  return { mediaType: ext === ".png" ? "image/png" : "image/jpeg", base64: file.toString("base64") };
}

async function readCodexModelCache() {
  const cache = JSON.parse(await fs.readFile(CODEX_MODELS_CACHE, "utf8")) as {
    models?: Array<{ slug?: string; id?: string; model?: string; description?: string }>;
  };
  return (cache.models ?? [])
    .map((model) => ({ id: model.slug ?? model.id ?? model.model ?? "", description: model.description ?? "" }))
    .filter((model) => model.id.length > 0);
}

async function readCodexModelCatalog() {
  const { stdout } = await execFileAsync("codex", ["debug", "models"], {
    timeout: 8_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const catalog = JSON.parse(stdout) as {
    models?: Array<{ slug?: string; display_name?: string; description?: string; visibility?: string }>;
  };
  return (catalog.models ?? [])
    .filter((model) => model.visibility !== "hidden")
    .map((model) => ({
      id: model.slug ?? "",
      description: model.description || model.display_name || "",
    }))
    .filter((model) => model.id.length > 0);
}

function opencodeModelsCachePath(root: string) {
  return path.join(root, ".guanzizai", OPENCODE_MODELS_CACHE_FILENAME);
}

/** `opencode models` 仅列出已配置 provider 的模型；成功后写入本地缓存供 CLI 失败时回退。 */
async function readOpencodeModels(root: string) {
  const { stdout } = await execFileAsync(await resolveOpencodeExecutable(), ["models"], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const models = stripAnsiCodes(stdout)
    .split("\n")
    .map((line) => line.trim().match(/^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, description: "" }));
  if (!models.length) throw new Error("opencode 未返回可用模型");
  await fs.mkdir(path.dirname(opencodeModelsCachePath(root)), { recursive: true });
  await fs.writeFile(opencodeModelsCachePath(root), JSON.stringify(models), "utf8");
  return models;
}

async function readCachedOpencodeModels(root: string) {
  const cached = JSON.parse(await fs.readFile(opencodeModelsCachePath(root), "utf8")) as Array<{ id?: string }>;
  return (Array.isArray(cached) ? cached : [])
    .filter((model) => model && typeof model.id === "string" && model.id)
    .map((model) => ({ id: model.id!, description: "" }));
}

async function uniqueFilePath(directory: string, filename: string) {
  const parsed = path.parse(filename);
  let targetPath = path.join(directory, filename);
  let index = 2;
  while (existsSync(targetPath)) {
    targetPath = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return targetPath;
}

async function pdfText(absolutePath: string) {
  if (process.platform === "win32") {
    const read = "import sys; from pypdf import PdfReader; print('\\n'.join((page.extract_text() or '')[:4000] for page in PdfReader(sys.argv[1]).pages[:6]))";
    return (await runSchoolPython(serverRoot, ["-c", read, absolutePath], 10_000)).stdout;
  }
  return (await execFileAsync("pdftotext", [absolutePath, "-"], { timeout: 8_000, maxBuffer: 2_000_000 })).stdout;
}

async function normalizedImportPath(targetPath: string) {
  if (path.extname(targetPath).toLowerCase() !== ".pdf") return targetPath;
  try {
    const stdout = await pdfText(targetPath);
    const suggestedName = suggestImportedFilename(path.basename(targetPath), stdout, path.dirname(targetPath));
    if (!suggestedName) return targetPath;
    const normalizedPath = await uniqueFilePath(path.dirname(targetPath), suggestedName);
    await fs.rename(targetPath, normalizedPath);
    return normalizedPath;
  } catch {
    return targetPath;
  }
}

async function materialTextForClassification(absolutePath: string) {
  const ext = path.extname(absolutePath).toLowerCase();
  try {
    if (ext === ".pdf") {
      const stdout = await pdfText(absolutePath);
      return stdout.slice(0, 18_000);
    }
    if (ext === ".txt") return (await fs.readFile(absolutePath, "utf8")).slice(0, 18_000);
    if (ext === ".ofd") {
      const { stdout } = await execFileAsync("unzip", ["-p", absolutePath, "Doc_0/Pages/*.xml", "Doc_0/Tpls/*.xml"], { timeout: 8_000, maxBuffer: 2_000_000 });
      return stdout.replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt);/g, " ").replace(/\s+/g, " ").slice(0, 18_000);
    }
    if ([".doc", ".docx", ".xlsx", ".pptx"].includes(ext)) {
      const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", absolutePath], { timeout: 8_000, maxBuffer: 2_000_000 });
      return stdout.slice(0, 18_000);
    }
  } catch {
    // 文件名仍会进入模型上下文，模型可基于其做最接近的归类。
  }
  return "";
}

async function classificationImagePath(absolutePath: string, text: string) {
  const ext = path.extname(absolutePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png"].includes(ext)) return { path: absolutePath, temporary: false };
  if (text.trim().length >= 120) return { path: "", temporary: false };

  const digest = createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
  const previewDirectory = path.join(tmpdir(), "guanzizai-classification-previews");
  await fs.mkdir(previewDirectory, { recursive: true });
  if (ext === ".pdf") {
    const output = path.join(previewDirectory, `${digest}-${randomUUID()}.png`);
    try {
      if (process.platform === "win32") await previewWindowsPdf(absolutePath, output);
      else await execFileAsync("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-png", "-scale-to", "1600", absolutePath, output.slice(0, -4)], { timeout: 15_000, maxBuffer: 1_000_000 });
      return existsSync(output) ? { path: output, temporary: true } : { path: "", temporary: false };
    } catch { return { path: "", temporary: false }; }
  }
  if ([".pptx", ".docx", ".xlsx"].includes(ext)) {
    try {
      const { stdout } = await execFileAsync("unzip", ["-Z1", absolutePath], { timeout: 8_000, maxBuffer: 1_000_000 });
      const entry = stdout.split("\n").find((value) => /^(?:ppt|word|xl)\/media\/.*\.(?:png|jpe?g)$/i.test(value));
      if (!entry) return { path: "", temporary: false };
      const imageExt = path.extname(entry).toLowerCase();
      const output = path.join(previewDirectory, `${digest}${imageExt}`);
      const { stdout: image } = await execFileAsync("unzip", ["-p", absolutePath, entry], { timeout: 8_000, encoding: "buffer", maxBuffer: 12_000_000 });
      await fs.writeFile(output, image);
      return { path: output, temporary: true };
    } catch { return { path: "", temporary: false }; }
  }
  return { path: "", temporary: false };
}

function imageDataUrl(absolutePath: string) {
  const ext = path.extname(absolutePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  return fs.readFile(absolutePath).then((file) => `data:${mimeType};base64,${file.toString("base64")}`);
}

function parseClassificationJson(value: string) {
  const fenced = value.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const json = fenced.match(/\[[\s\S]*\]/)?.[0] ?? fenced;
  const parsed = JSON.parse(json) as unknown;
  // 模型偶发对单文件返回对象而非数组；统一包装成数组。
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.filter((item): item is { path?: string; requirementId?: string; reason?: string; note?: string; documentDate?: string; paymentDate?: string; issuer?: string; amount?: string; currency?: string; goodsName?: string; text?: string; flightSegments?: unknown; rebookingFeeAmount?: unknown } => Boolean(item) && typeof item === "object");
}

function safeMaterialPath(root: string, requestPath: string) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = toPosix(path.normalize(decodedPath));
  const isMaterialRoot = MATERIAL_ROOTS.some(
    (directory) =>
      normalizedPath === directory || normalizedPath.startsWith(`${directory}/`),
  );
  if (!isMaterialRoot) return null;

  const absolutePath = path.resolve(root, decodedPath);
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!absolutePath.startsWith(normalizedRoot)) return null;
  return absolutePath;
}

function safeLineFolder(requestFolder: string) {
  const normalized = toPosix(path.normalize(requestFolder));
  if (!normalized.startsWith("01_报销材料/") || normalized.includes("../")) {
    return null;
  }
  return normalized;
}

function templateWorkspace(folder: string) {
  const digest = createHash("sha256").update(folder).digest("hex").slice(0, 16);
  return path.join(tmpdir(), "guanzizai-receipt-templates", digest);
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function paragraphText(paragraph: string) {
  const textPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = textPattern.exec(paragraph)) !== null) {
    parts.push(match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  }
  return parts.join("");
}

function replaceParagraphText(paragraph: string, text: string) {
  const start = paragraph.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const properties = paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  return `${start}${properties}<w:r><w:rPr><w:lang w:eastAsia="zh-CN"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function signatureDrawing(relationshipId: string, width: number, height: number) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="1001" name="电子签名"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="电子签名.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function signatureParagraph(paragraph: string, relationshipId: string, width: number, height: number) {
  const start = paragraph.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const properties = paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  return `${start}${properties}<w:r><w:t>说明人：</w:t></w:r>${signatureDrawing(relationshipId, width, height)}</w:p>`;
}

async function embedSignature(workspace: string, source: string) {
  const mediaDirectory = path.join(workspace, "word", "media");
  await fs.mkdir(mediaDirectory, { recursive: true });
  await fs.copyFile(source, path.join(mediaDirectory, "electronic-signature.png"));
  const relationPath = path.join(workspace, "word", "_rels", "document.xml.rels");
  const relationXml = await fs.readFile(relationPath, "utf8");
  const relationIds = Array.from(relationXml.matchAll(/Id="rId(\d+)"/g)).map((match) => Number(match[1]));
  const relationshipId = `rId${Math.max(0, ...relationIds) + 1}`;
  await fs.writeFile(relationPath, relationXml.replace("</Relationships>", `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/electronic-signature.png"/></Relationships>`), "utf8");
  const contentTypesPath = path.join(workspace, "[Content_Types].xml");
  const contentTypes = await fs.readFile(contentTypesPath, "utf8");
  if (!/Extension="png"/i.test(contentTypes)) await fs.writeFile(contentTypesPath, contentTypes.replace("</Types>", "<Default Extension=\"png\" ContentType=\"image/png\"/></Types>"), "utf8");
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", source]);
  const widthPixels = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]) || 240;
  const heightPixels = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]) || 80;
  const width = 1_050_000;
  return { relationshipId, width, height: Math.max(180_000, Math.round(width * heightPixels / widthPixels)) };
}

function trafficBodyText(content: string) {
  return content
    .replace(/^\s*交通情况说明\s*/, "")
    .replace(/本人[^\n]*?交通安排情况说明如下[：:：]?\s*/, "")
    .replace(/以上情况属实，特此说明。?[\s\S]*$/, "")
    .replace(/说明人：?[\s\S]*$/, "")
    .trim();
}

async function createTrafficNoteFromTemplate(target: string, content: string, trafficDate: string, writer = { name: "", organization: "", title: "教职工" }, signaturePath = "") {
  const template = TEMPLATE_SOURCES["traffic-explanation"].source;
  if (!existsSync(template)) throw new Error("交通情况说明模板不存在，请在政策与模板库中更新来源");
  const workspace = path.join(tmpdir(), `guanzizai-traffic-template-${Date.now()}`);
  try {
    await fs.mkdir(workspace, { recursive: true });
    await execFileAsync("/usr/bin/ditto", ["-x", "-k", template, workspace], { timeout: 20_000 });
    const documentPath = path.join(workspace, "word", "document.xml");
    const sourceXml = await fs.readFile(documentPath, "utf8");
    const drawingNamespaces = `${sourceXml.includes("xmlns:a=") ? "" : " xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\""}${sourceXml.includes("xmlns:pic=") ? "" : " xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\""}`;
    const documentXml = drawingNamespaces ? sourceXml.replace("<w:document ", `<w:document${drawingNamespaces} `) : sourceXml;
    const paragraphPattern = /<w:p\b[\s\S]*?<\/w:p>/g;
    const matches: RegExpExecArray[] = [];
    let paragraphMatch: RegExpExecArray | null;
    while ((paragraphMatch = paragraphPattern.exec(documentXml)) !== null) matches.push(paragraphMatch);
    if (matches.length < 11) throw new Error("交通情况说明模板结构不完整");

    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(trafficDate) ? trafficDate : new Date().toISOString().slice(0, 10);
    const [year, month, day] = normalizedDate.split("-").map(Number);
    const sourceIntro = paragraphText(matches[3][0]);
    const introIdentity = writer.name ? `本人${writer.name}，系${writer.organization || "华东师范大学"}${writer.title || "教职工"}。` : (sourceIntro.match(/^.+?。/)?.[0] ?? "本人");
    const signature = signaturePath ? await embedSignature(workspace, signaturePath) : null;
    const replacements = new Map<number, string>([
      [3, `${introIdentity}现就本人于${month}月${day}日参加相关活动期间的交通安排情况说明如下：`],
      [4, trafficBodyText(content)],
      [5, "以上情况属实，特此说明。"],
      [9, writer.organization || paragraphText(matches[9][0])],
      [10, `日期：${year}年${month}月${day}日`],
    ]);
    let cursor = 0;
    let updatedXml = "";
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      updatedXml += documentXml.slice(cursor, match.index);
      updatedXml += signature && index === 8
        ? signatureParagraph(match[0], signature.relationshipId, signature.width, signature.height)
        : replacements.has(index)
          ? replaceParagraphText(match[0], replacements.get(index)!)
          : match[0];
      cursor = (match.index ?? 0) + match[0].length;
    }
    updatedXml += documentXml.slice(cursor);
    await fs.writeFile(documentPath, updatedXml, "utf8");
    await fs.rm(target, { force: true });
    await execFileAsync("/usr/bin/zip", ["-q", "-r", target, "."], { cwd: workspace, timeout: 20_000 });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function openTemplateCopy(folder: string, templateId: keyof typeof TEMPLATE_SOURCES) {
  const template = TEMPLATE_SOURCES[templateId];
  if (!existsSync(template.source)) throw new Error("模板原文件不存在，请在政策与模板库中更新来源");

  const workspace = templateWorkspace(folder);
  const target = path.join(workspace, template.filename);
  await fs.mkdir(workspace, { recursive: true });
  if (!existsSync(target)) await fs.copyFile(template.source, target);
  await execFileAsync("open", [target]);
  return target;
}

async function serveMaterial(
  request: IncomingMessage,
  response: ServerResponse,
  absolutePath: string,
) {
  if (!existsSync(absolutePath)) {
    sendJson(response, 404, { error: "材料不存在" });
    return;
  }

  const stat = await fs.stat(absolutePath);
  const contentType =
    MIME_TYPES[path.extname(absolutePath).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.range;

  if (range) {
    const [startText, endText] = range.replace("bytes=", "").split("-");
    const start = Number(startText);
    const end = endText ? Number(endText) : stat.size - 1;
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    });
    createReadStream(absolutePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  createReadStream(absolutePath).pipe(response);
}

async function previewWindowsPdf(absolutePath: string, output: string) {
  await windowsMaterials(["-Operation", "preview", "-Source", absolutePath, "-Output", output]);
}

async function createQuickLookPreview(absolutePath: string) {
  const stat = await fs.stat(absolutePath);
  const digest = createHash("sha256")
    .update(`${absolutePath}:${stat.mtimeMs}`)
    .digest("hex");
  const previewDirectory = path.join(tmpdir(), "guanzizai-receipt-preview", digest);
  const previewPath = path.join(previewDirectory, "preview.png");
  if (existsSync(previewPath)) return previewPath;

  await fs.mkdir(previewDirectory, { recursive: true });
  await execFileAsync("qlmanage", ["-t", "-s", "900", "-o", previewDirectory, absolutePath]);
  const quickLookOutput = path.join(previewDirectory, `${path.basename(absolutePath)}.png`);
  if (!existsSync(quickLookOutput)) throw new Error("无法生成文件预览图");
  await fs.rename(quickLookOutput, previewPath);
  return previewPath;
}

export function createLocalMaterialsMiddleware() {
  const root = serverRoot;
  const trafficNoteJobs = new Map<string, { state: "running" | "completed" | "failed"; error?: string }>();
  const budgetsJobs = new Map<string, { state: "running" | "completed" | "failed"; error?: string; log?: string }>();
  /** DF 工资抓取任务（tools/fetch_salary.py 增量爬取，JSON 行进度进 log）。 */
  const dfJobs = new Map<string, { state: "running" | "completed" | "failed"; error?: string; log?: string }>();
    const classificationJobs = new Map<string, { state: "running" | "completed" | "failed"; error?: string; assignments?: ClassificationAssignment[] }>();

  /** 线上递交任务：后台 e2e 开单（保存草稿，不提交）；log 尾部随状态端点返回。 */
  const onlineSubmitJobs = new Map<string, OnlineJob>();
  const draftChecks = new Map<string, { state: "running" | "clean" | "matched" | "error"; checkedAt: number; match?: { billNo: string; text: string; amountMatch: boolean | null }; error?: string }>();

  const generateRebookingNote = async (body: { backend?: string; model?: string; context?: string; folder?: string; noteDate?: string; profileId?: string; useSignature?: boolean }) => {
    const context = body.context?.trim();
    if (!context) throw new Error("请填写改签事实");
    const writer = await trafficNoteWriter(root, body.profileId);
    const prompt = `请为高校报销"机票改签情况说明"写正文一段。它将被填入正式说明 PDF 的第二段，因此不要写标题、本人身份、引言、结语"以上情况属实，特此说明"、说明人或日期。正文应交代原航班计划、改签原因（如行程取消、时间变更）、改签后的航班与费用金额；金额与事实必须来自已知信息，不要编造。已知事实：${context}`;
    let draft = "";
    if (body.backend === "api") {
      const apiKey = await readSavedApiKey();
      if (!apiKey) throw new Error("请先在 AI 后端设置中保存 API Key");
      const provider = apiProviderForApiKey(apiKey, (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl);
      draft = await callChatModel(provider, apiKey, { model: body.model || provider.defaultModel, prompt, maxTokens: 1_024, disableThinking: true });
    } else if (body.backend === "codex") {
      draft = await runCodexCli(["exec", "--skip-git-repo-check", ...(body.model ? ["-m", body.model] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", prompt], 90_000);
    } else if (body.backend === "opencode") {
      draft = await runOpencodeCli([...(body.model ? ["-m", body.model] : []), "--", prompt], 90_000);
    } else {
      throw new Error("请先在 AI 后端设置中选择 OpenAI API、Codex CLI 或 OpenCode CLI");
    }
    if (!draft) throw new Error("AI 未生成可用草稿");
    if (body.folder) {
      const folder = safeLineFolder(body.folder);
      if (!folder) throw new Error("无效的票据集目录");
      const targetFolder = path.join(root, folder);
      const date = new Date().toISOString().slice(0, 10);
      await fs.mkdir(targetFolder, { recursive: true });
      const signature = body.useSignature ? profileSignaturePath(root, safeProfileId(body.profileId ?? "") ?? "") : "";
      if (body.useSignature && (!signature || !existsSync(signature))) throw new Error("当前用户尚未保存签名 PNG");
      await createExplanationPdf(root, path.join(targetFolder, `${date}_机票改签情况说明.pdf`), "rebooking", draft, body.noteDate ?? date, writer, signature);
    }
    return draft;
  };

  const generateTrafficNote = async (body: { backend?: string; model?: string; context?: string; folder?: string; trafficDate?: string; profileId?: string; useSignature?: boolean }) => {
    const context = body.context?.trim();
    if (!context) throw new Error("请填写交通安排事实");
    const writer = await trafficNoteWriter(root, body.profileId);
    const prompt = `请为高校报销“交通情况说明”写“交通事实正文”一段。它将被填入既有 Word 模板的第二段，因此不要写标题、本人身份、引言、结语“以上情况属实，特此说明”、说明人或日期。此说明仅用于跨城市出租车或网约车往返，不用于市内接驳。正文应交代日期、活动或任务、跨城市起讫、必要性和费用；不要编造未提供的事实。已知事实：${context}`;
    let draft = "";
    if (body.backend === "api") {
      const apiKey = await readSavedApiKey();
      if (!apiKey) throw new Error("请先在 AI 后端设置中保存 API Key");
      const provider = apiProviderForApiKey(apiKey, (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl);
      draft = await callChatModel(provider, apiKey, { model: body.model || provider.defaultModel, prompt, maxTokens: 1_024, disableThinking: true });
    } else if (body.backend === "codex") {
      draft = await runCodexCli(["exec", "--skip-git-repo-check", ...(body.model ? ["-m", body.model] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", prompt], 90_000);
    } else if (body.backend === "opencode") {
      draft = await runOpencodeCli([...(body.model ? ["-m", body.model] : []), "--", prompt], 90_000);
    } else {
      throw new Error("请先在 AI 后端设置中选择 OpenAI API、Codex CLI 或 OpenCode CLI");
    }
    if (!draft) throw new Error("AI 未生成可用草稿");
    if (body.folder) {
      const folder = safeLineFolder(body.folder);
      if (!folder) throw new Error("无效的票据集目录");
      const targetFolder = path.join(root, folder);
      const date = new Date().toISOString().slice(0, 10);
      await fs.mkdir(targetFolder, { recursive: true });
      const signature = body.useSignature ? profileSignaturePath(root, safeProfileId(body.profileId ?? "") ?? "") : "";
      if (body.useSignature && (!signature || !existsSync(signature))) throw new Error("当前用户尚未保存签名 PNG");
      await createExplanationPdf(root, path.join(targetFolder, `${date}_交通情况说明.pdf`), "traffic", draft, body.trafficDate ?? date, writer, signature);
    }
    return draft;
  };

  function classifyThroughLocalService(request: IncomingMessage, body: unknown) {
    const port = request.socket.localPort;
    if (!port) throw new Error("无法定位当前票据簿服务");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (request.headers.cookie) headers.Cookie = request.headers.cookie;
    return fetch(`http://127.0.0.1:${port}/api/auto-classify`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  let openBillChild: ReturnType<typeof spawn> | null = null;
  let invoiceQueueRunning = false;
  let firstRunWrites = Promise.resolve();
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;
    if (developerLogs && pathname === "/api/log-settings") {
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site" || (origin && origin !== `http://${request.headers.host}`)) {
        sendJson(response, 403, { error: "仅支持从票据簿页面修改日志设置" });
        return;
      }
      if (request.method === "GET") {
        sendJson(response, 200, await diagnostics.getSettings());
      } else if (request.method === "PUT") {
        const input = parseDeveloperLogSettings(await readJsonBody(request).catch(() => null));
        if (!input) {
          sendJson(response, 400, { error: "日志等级无效，容量须为 1 至 256 MiB 的整数" });
          return;
        }
        try {
          sendJson(response, 200, await diagnostics.saveSettings(input));
        } catch {
          sendJson(response, 500, { error: "无法保存日志设置，请检查数据目录权限" });
        }
      } else sendJson(response, 405, { error: "不支持该请求" });
      return;
    }

    if (request.method === "GET" && pathname === "/api/diagnostics") {
      try {
        sendJson(response, 200, await diagnostics.report());
      } catch {
        sendJson(response, 500, { error: "无法读取诊断记录" });
      }
      return;
    }

    if (process.env.RECEIPT_RUNTIME === "portable" && pathname === "/api/first-run") {
      const target = path.join(root, ".guanzizai", "first-run.json");
      try {
        if (request.method === "PUT") {
          const input = normalizeFirstRunInput(await readJsonBody(request));
          const save = firstRunWrites.then(async () => {
            if (existsSync(target)) return;
            if ((input.chineseName || input.organization) && !(await readUserProfiles(root)).length) {
              const profile = { ...emptyUserProfile(), chineseName: input.chineseName, organization: input.organization };
              await writeUserProfiles(root, [{ id: "profile-default", profile, updatedAt: new Date().toISOString() }]);
            }
            await fs.mkdir(path.dirname(target), { recursive: true });
            await atomicWriteJson(target, input.delivery);
          });
          firstRunWrites = save.catch(() => undefined);
          await save;
        } else if (request.method !== "GET") {
          sendJson(response, 405, { error: "不支持该请求" });
          return;
        }
        const completed = existsSync(target);
        const delivery = completed
          ? normalizeFirstRunInput(JSON.parse(await fs.readFile(target, "utf8"))).delivery
          : emptyDelivery;
        sendJson(response, 200, { dataRoot: root, completed, delivery });
      } catch {
        sendJson(response, 500, { error: "无法读取或写入首次配置" });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/school-runtime") {
      sendJson(response, 200, await schoolRuntimeStatus(root));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/materials") {
      try {
        const groups = await Promise.all(
          MATERIAL_ROOTS.map((directory) => scanDirectory(root, directory)),
        );
        const materials = groups
          .flat()
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
        sendJson(response, 200, materials);
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "材料扫描失败",
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/budgets-refresh") {
      const jobId = `budgets-${Date.now()}`;
      budgetsJobs.set(jobId, { state: "running" });

      const child = startSchoolScript(root, "tools/fetch_budget.py", []);
      let logTail = "";
      child.stdout.on("data", (chunk: Buffer) => { logTail = `${logTail}${chunk}`.slice(-2000); });
      child.stderr.on("data", (chunk: Buffer) => { logTail = `${logTail}${chunk}`.slice(-2000); });
      child.on("error", (error) => budgetsJobs.set(jobId, { state: "failed", error: error.message }));
      child.on("close", (code) => {
        if (code === 0) budgetsJobs.set(jobId, { state: "completed", log: logTail });
        else budgetsJobs.set(jobId, { state: "failed", error: logTail.trim().split("\n").slice(-3).join("\n") || `拉取脚本退出码 ${code}` });
      });
      sendJson(response, 202, { jobId });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/budgets-refresh-status") {
      const job = budgetsJobs.get(requestUrl.searchParams.get("jobId") ?? "");
      if (!job) { sendJson(response, 404, { error: "拉取任务不存在或已失效" }); return; }
      if (job.state !== "running") budgetsJobs.delete(requestUrl.searchParams.get("jobId") ?? "");
      sendJson(response, 200, job);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/invoice-queue-status") {
      // 发票识别状态自查（OCR 池/出错队列/占用草稿）：spawn 只读脚本同步返回（低频查询，简单锁防并发）。
      if (invoiceQueueRunning) { sendJson(response, 429, { error: "上一次查询仍在进行中，稍后再试" }); return; }
      invoiceQueueRunning = true;
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = startSchoolScript(root, "tools/invoice_queue_status.py", []);
          let out = "";
          const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("查询超时（120s）")); }, 120_000);
          child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
          child.stderr.on("data", () => {});
          child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`查询脚本退出码 ${code}`)); });
        });
        const lastLine = stdout.trim().split("\n").pop() ?? "{}";
        sendJson(response, 200, JSON.parse(lastLine));
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "查询失败" });
      } finally {
        invoiceQueueRunning = false;
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/invoice-queue-clean") {
      // 清理 OCR 出错队列（只删出错条目，不动发票池合法发票）
      if (invoiceQueueRunning) { sendJson(response, 429, { error: "上一次查询仍在进行中，稍后再试" }); return; }
      invoiceQueueRunning = true;
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = startSchoolScript(root, "tools/invoice_queue_status.py", ["--clean"]);
          let out = "";
          const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("清理超时（180s）")); }, 180_000);
          child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
          child.stderr.on("data", () => {});
          child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`清理脚本退出码 ${code}`)); });
        });
        const lastLine = stdout.trim().split("\n").pop() ?? "{}";
        sendJson(response, 200, JSON.parse(lastLine));
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "清理失败" });
      } finally {
        invoiceQueueRunning = false;
      }
      return;
    }

    // tombstone remap：旧集 id → 新集 id（拆分迁移）；值为 null 表示纯删除。防止旧浏览器快照回写复活旧集/洗回费用 setId。
    const readRemovedLineMap = async (): Promise<Record<string, string | null>> => {
      const merged: Record<string, string | null> = {};
      try {
        const doc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-removed-ids.json"), "utf8").catch(() => "{}")) as Record<string, string | null>;
        if (doc && typeof doc === "object" && !Array.isArray(doc)) Object.assign(merged, doc);
      } catch { /* 忽略 */ }
      try {
        // model.removedSetIds（财务对齐侧删除记录）与 receipt-removed-ids.json（拆分/删除守卫）口径合并：
        // 两处不一致时 pullModelState 删行、30s 对齐又补回，16↔18 永动循环写盘（2026-09-23 实证）
        const model = JSON.parse(await fs.readFile(path.join(root, "data", "reimbursement-model.json"), "utf8").catch(() => "{}")) as { removedSetIds?: string[] };
        for (const id of model.removedSetIds ?? []) if (!merged[id]) merged[id] = null;
      } catch { /* 忽略 */ }
      return merged;
    };

    if (request.method === "GET" && requestUrl.pathname === "/api/receipt-lines") {
      try {
        const file = path.join(root, "data", "receipt-lines.json");
        if (fsSyncExists(file)) {
          const doc = JSON.parse(fsReadSync(file, "utf8")) as { lines?: Array<Record<string, unknown>> };
          const removedMap = await readRemovedLineMap();
          const removedIds = new Set(Object.keys(removedMap));
          if (removedIds.size && doc.lines) doc.lines = doc.lines.filter((l) => !removedIds.has(String(l.id ?? "")));
          sendJson(response, 200, { ...doc, removedIds: Array.from(removedIds) });
        } else {
          sendJson(response, 404, { error: "no server copy" });
        }
      } catch (error) {
        sendJson(response, 500, { error: "读取票据集失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/receipt-meta") {
      try {
        const file = path.join(root, "data", "receipt-meta.json");
        if (fsSyncExists(file)) sendJson(response, 200, JSON.parse(fsReadSync(file, "utf8")));
        else sendJson(response, 404, { error: "no server copy" });
      } catch (error) { sendJson(response, 500, { error: "读取失败" }); }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/receipt-meta") {
      try {
        const body = await readJsonBody(request) as { metadata?: unknown };
        if (!body || body.metadata === undefined) { sendJson(response, 400, { error: "缺少 metadata" }); return; }
        const file = path.join(root, "data", "receipt-meta.json");
        const backup = file.replace(".json", ".backup.json");
        // stale-snapshot 键级合并（与 model-state/receipt-lines 同款防线）：旧窗口 PUT 缺失服务器已有键 =
        // 过期快照——保留服务器独有键（后台归类任务写入的 classifiedWorkflowNodeId 不再被洗掉，2026-11-21
        // 智谱支付记录归类被凌晨旧窗口快照抹掉实证）；body 键值优先（正常更新不受影响）。前端无删除 meta 键
        // 的路径（材料移除走 removedPaths），键级合并不破坏任何现有语义。
        const merged = await withReceiptMetaWrite(async () => {
          const existing = fsSyncExists(file) ? ((JSON.parse(fsReadSync(file, "utf8")) as { metadata?: Record<string, unknown> }).metadata ?? {}) : {};
          const incoming = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<string, unknown>;
          const merged = { ...existing, ...incoming };
          for (const [filePath, value] of Object.entries(existing)) {
            const saved = value as ReceiptMeta | undefined;
            const next = incoming[filePath];
            if (saved && next && typeof next === "object") {
              const incomingMeta = next as ReceiptMeta;
              const paymentDate = saved.paymentDate || saved.paymentDateBlocked !== undefined
                ? { paymentDate: saved.paymentDate, paymentDateBlocked: saved.paymentDateBlocked } : {};
              const reference = saved.feeScheduleReferencedAt && saved.feeScheduleReferencedAt > (incomingMeta.feeScheduleReferencedAt ?? "")
                ? { feeScheduleReferencedAt: saved.feeScheduleReferencedAt, classifiedRequirementId: saved.classifiedRequirementId,
                  classifiedWorkflowNodeId: saved.classifiedWorkflowNodeId, classificationReason: saved.classificationReason } : {};
              merged[filePath] = { ...(saved.paymentDate || saved.paymentDateBlocked !== undefined ? saved : {}), ...incomingMeta, ...paymentDate, ...reference };
            }
          }
          if (fsSyncExists(file)) fsCopySync(file, backup);
          await atomicWriteJson(file, { metadata: merged });
          serverTrace({ level: "info", scope: "meta", event: "merged-put", detail: `server=${Object.keys(existing).length} incoming=${Object.keys(incoming).length} merged=${Object.keys(merged).length}`, task: "归类元数据" });
          return merged;
        });
        sendJson(response, 200, { ok: true, metadata: merged });
      } catch (error) { sendJson(response, 500, { error: error instanceof Error ? error.message : "保存失败" }); }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/receipt-lines") {
      try {
        const body = await readJsonBody(request) as { lines?: unknown };
        if (!body || body.lines === undefined) { sendJson(response, 400, { error: "缺少 lines" }); return; }
        const file = path.join(root, "data", "receipt-lines.json");
        // 旧快照洗数据防护（2026-09-19）：body.lines 缺少服务器已有行 = 旧页面/无痕窗口的过期快照（emptyState 双写）。
        // 处理：服务端静默合并——缺失的行保留服务器版本（票据集无真删场景，缺失=本地快照旧），并返回合并后的全集；
        // 首版用 409+前端 reload 导致「reload→旧 localStorage→PUT 旧值→409」死循环，改为合并无感对齐。
        if (Array.isArray(body.lines) && fsSyncExists(file)) {
          try {
            const preDoc = JSON.parse(await fs.readFile(file, "utf8")) as { lines?: Array<Record<string, unknown>> };
            const serverLines = preDoc.lines ?? [];
            const removedMap = await readRemovedLineMap();
            const removedIds = new Set(Object.keys(removedMap));
            const incomingList = (body.lines as Array<Record<string, unknown>>).filter((l) => !removedIds.has(String(l.id ?? "")));
            (body as { lines?: unknown }).lines = incomingList;
            const incomingIds = new Set(incomingList.map((l) => String(l.id ?? "")));
            const missing = serverLines.filter((l) => l.id && !incomingIds.has(String(l.id)) && !removedIds.has(String(l.id)));
            if (missing.length) {
              const extra = incomingList.filter((l) => !serverLines.some((sl) => String(sl.id) === String(l.id)));
              body.lines = [...incomingList, ...missing, ...extra];
              serverTrace({ level: "warn", scope: "receipt-lines", event: "stale-snapshot-merged", detail: `补回缺失 ${missing.length} 行（${missing.map((l) => String(l.id)).join(",").slice(0, 80)}）`, task: "双写保护" });
            }
          } catch { /* 服务器文件不可读时按原样写入 */ }
        }
        // 组快照权威重算（2026-09-19）：groups/requirements 恒由该行费用推导（服务端按 DAILY_REQUIREMENT_GROUPS 重挂），
        // 忽略前端传入——前端快照可能过时（4 组全量），靠它双写会让空壳组反复出现。
        try {
          const modelForGroups = await readFormalModel(root) as unknown as { expenses?: Array<{ setId?: string; typeId?: string }> } | null;
          const TYPE2LABEL: Record<string, string> = { 'ai-subscription': '云服务', 'cloud-service': '云服务', 'local-ride-hailing': '市内交通', 'local-taxi': '市内交通', 'office-supplies': '办公用品', 'low-value-gear': '低值易耗设备' };
          const dailyDefs = DAILY_REQUIREMENT_GROUPS;
          const dailyReqs = dailyDefs.flatMap((g) => g.requirements);
          for (const line of body.lines as Array<Record<string, unknown>>) {
            if (line.kind !== '日常') continue;
            const labels = new Set<string>();
            for (const expense of modelForGroups?.expenses ?? []) {
              if (expense.setId !== line.id) continue;
              const label = TYPE2LABEL[String(expense.typeId ?? '')];
              if (label) labels.add(label);
            }
            const kept = dailyDefs.filter((g) => labels.has(g.label));
            const keepIds = new Set(kept.flatMap((g) => g.requirements.map((r) => r.id)));
            line.groups = kept;
            line.requirements = dailyReqs.filter((r) => keepIds.has(r.id));
            line.workflowVersion = DAILY_WORKFLOW_VERSION;
          }
        } catch { /* 组快照重算失败时按原样写入 */ }
        // elabBills 归属注册表（2026-09-19）：billNo → lineId。拆分/迁移时登记跟随费用换集，
        // 旧页面快照仍持旧归属（原集带 [HC]）反复 PUT——空值保护拦不住「旧位置覆盖新位置」，
        // 按 registry 强制对齐：错位行的 elabBills 剥离，归属行缺登记时从服务器行补全。
        const registryPath = path.join(root, "data", "elab-bill-registry.json");
        const billRegistry = JSON.parse(await fs.readFile(registryPath, "utf8").catch(() => "{}")) as Record<string, string>;
        const serverLinesForElab = fsSyncExists(file)
          ? ((JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> }).lines ?? [])
          : [];
        const serverLineById = new Map(serverLinesForElab.map((entry) => [String(entry.id), entry]));
        for (const line of body.lines as Array<Record<string, unknown>>) {
          const lineId = String(line.id ?? "");
          const incomingBills = Array.isArray(line.elabBills) ? (line.elabBills as Array<{ billNo?: string }>) : [];
          const misplaced = incomingBills.filter((bill) => {
            const owner = billRegistry[String(bill.billNo ?? "")];
            return owner && owner !== lineId;
          });
          if (misplaced.length) {
            line.elabBills = (incomingBills as Array<Record<string, unknown>>).filter((bill) => {
              const owner = billRegistry[String(bill.billNo ?? "")];
              return !owner || owner === lineId;
            });
            serverTrace({ level: "warn", scope: "receipt-lines", event: "elab-bill-misplaced-stripped", detail: `${lineId} 剥离 ${misplaced.map((b) => b.billNo).join(",")}（归属他集）`, task: "双写保护" });
          }
          // 归属行缺登记时补全（服务器行有而 incoming 无/错）
          for (const bill of incomingBills) {
            const owner = billRegistry[String(bill.billNo ?? "")];
            if (owner === lineId) continue;
          }
          const serverElab = serverLineById.get(lineId)?.elabBills;
          if (Array.isArray(serverElab) && serverElab.length) {
            const incoming = Array.isArray(line.elabBills) ? (line.elabBills as Array<{ billNo?: string }>) : [];
            const incomingNos = new Set(incoming.map((b) => String(b.billNo ?? "")));
            const missingOnServer = (serverElab as Array<{ billNo?: string }>).filter((b) => !incomingNos.has(String(b.billNo ?? "")) && billRegistry[String(b.billNo ?? "")] === lineId);
            if (missingOnServer.length) {
              line.elabBills = [...incoming, ...missingOnServer];
              serverTrace({ level: "warn", scope: "receipt-lines", event: "elab-bill-restored", detail: `${lineId} 补回 ${missingOnServer.map((b) => b.billNo).join(",")}`, task: "双写保护" });
            }
          }
        }
        // elabBills 空值保护：登记由服务器端流程（e2e 回填/状态同步/报账单登记端点）维护，
        // 浏览器加载时快照里可能还没有这些登记——空值 PUT 不得抹掉服务器端已有登记（避免并发写入丢失登记）。
        if (Array.isArray(body.lines) && fsSyncExists(file)) {
          try {
            const serverDoc = JSON.parse(await fs.readFile(file, "utf8")) as { lines?: Array<Record<string, unknown>> };
            const serverById = new Map((serverDoc.lines ?? []).map((entry) => [String(entry.id), entry]));
            for (const line of body.lines as Array<Record<string, unknown>>) {
              const serverLine = serverById.get(String(line.id));
              preserveArchiveState(root, line, serverLine);
              const serverBills = serverLine?.elabBills;
              const incomingBills = Array.isArray(line.elabBills) ? line.elabBills : null;
              if (Array.isArray(serverBills) && serverBills.length && (!incomingBills || !incomingBills.length)) {
                line.elabBills = serverBills;
              }
            }
          } catch { /* 服务器文件不可读时按原样写入 */ }
        }
        const backup = file.replace(".json", ".backup.json");
        if (fsSyncExists(file)) fsCopySync(file, backup);
        await atomicWriteJson(file, { lines: body.lines });
        // 返回合并后的全集：旧快照窗口据此对齐本地 state（否则 UI 持续显示旧归属直到手动刷新）
        sendJson(response, 200, { ok: true, lines: body.lines });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存票据集失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/budgets") {
      try {
        const budgetsDir = path.join(root, "data", "budgets");
        const files = (await fs.readdir(budgetsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
        const budgets = [];
        for (const name of files) {
          try { budgets.push(JSON.parse(await fs.readFile(path.join(budgetsDir, name), "utf8")) as unknown); } catch { /* 单文件损坏不影响其余 */ }
        }
        sendJson(response, 200, { budgets });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取预算数据" });
      }
      return;
    }

    // ---- DF（党费）计算：工资数据 data/df/salary-YYYY.json + 设置 data/df/settings.json ----
    const DF_DATA_DIR = path.join(root, "data", "df");
    const DF_SETTINGS_FILENAME = path.join(DF_DATA_DIR, "settings.json");
    const readDfSettings = async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(DF_SETTINGS_FILENAME, "utf8")) as { monthlySpecialDeduction?: unknown; enabled?: unknown; confirmedQuarters?: unknown };
        const value = Number(parsed.monthlySpecialDeduction);
        return {
          // 功能开关默认开启：本机主人使用；不需要的成员可在弹窗中停用（仅隐藏功能内容，dock 入口保留）
          enabled: parsed.enabled === undefined ? true : Boolean(parsed.enabled),
          monthlySpecialDeduction: Number.isFinite(value) && value >= 0 ? value : DF_DEFAULT_SPECIAL_DEDUCTION,
          confirmedQuarters: parsed.confirmedQuarters && typeof parsed.confirmedQuarters === "object" ? parsed.confirmedQuarters as Record<string, string> : {},
        };
      } catch {
        return { enabled: true, monthlySpecialDeduction: DF_DEFAULT_SPECIAL_DEDUCTION, confirmedQuarters: {} as Record<string, string> };
      }
    };

    if (request.method === "GET" && requestUrl.pathname === "/api/df") {
      try {
        const files = (await fs.readdir(DF_DATA_DIR).catch(() => [] as string[])).filter((name) => /^salary-\d{4}\.json$/.test(name)).sort();
        const years: Record<string, Record<string, unknown>> = {};
        for (const name of files) {
          try {
            const doc = JSON.parse(await fs.readFile(path.join(DF_DATA_DIR, name), "utf8")) as { year?: number; months?: Record<string, unknown> };
            if (typeof doc.year === "number" && doc.months && typeof doc.months === "object") years[String(doc.year)] = doc.months;
          } catch { /* 单文件损坏不影响其余 */ }
        }
        sendJson(response, 200, { settings: await readDfSettings(), years });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取 DF 数据" });
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/df/month") {
      try {
        const body = await readJsonBody(request) as { year?: number; month?: number; values?: Record<string, number> };
        const year = Number(body.year);
        const month = Number(body.month);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) { sendJson(response, 400, { error: "无效的年月" }); return; }
        if (!body.values || typeof body.values !== "object") { sendJson(response, 400, { error: "缺少 values" }); return; }
        const values: Record<string, number> = {};
        for (const [field, raw] of Object.entries(body.values)) {
          const num = Number(raw);
          if (Number.isFinite(num)) values[field] = num;
        }
        const file = path.join(DF_DATA_DIR, `salary-${year}.json`);
        const doc = JSON.parse(await fs.readFile(file, "utf8").catch(() => "{}")) as { year?: number; months?: Record<string, Record<string, number>> };
        doc.year = year;
        doc.months = { ...(doc.months ?? {}), [String(month)]: values };
        await fs.mkdir(DF_DATA_DIR, { recursive: true });
        await atomicWriteJson(file, doc);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存 DF 数据失败" });
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/df/settings") {
      try {
        const body = await readJsonBody(request) as { monthlySpecialDeduction?: number; enabled?: boolean };
        const current = await readDfSettings();
        const next = {
          enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
          monthlySpecialDeduction: current.monthlySpecialDeduction,
        };
        if (body.monthlySpecialDeduction !== undefined) {
          const value = Number(body.monthlySpecialDeduction);
          if (!Number.isFinite(value) || value < 0) { sendJson(response, 400, { error: "无效的专项附加扣除" }); return; }
          next.monthlySpecialDeduction = value;
        }
        await fs.mkdir(DF_DATA_DIR, { recursive: true });
        await atomicWriteJson(DF_SETTINGS_FILENAME, next);
        sendJson(response, 200, { ok: true, settings: next });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存设置失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/df/confirm-quarter") {
      try {
        const body = await readJsonBody(request) as { quarter?: string; confirmed?: boolean };
        const parsed = typeof body.quarter === "string" ? quarterOfKey(body.quarter) : null;
        if (!parsed) { sendJson(response, 400, { error: "无效的季度（应为 YYYY-Qn）" }); return; }
        const [year, quarter] = parsed;
        const settings = await readDfSettings();
        const confirmedQuarters: Record<string, string> = { ...settings.confirmedQuarters };
        const key = quarterKeyOf(year, quarter);
        if (body.confirmed === false) delete confirmedQuarters[key];
        else confirmedQuarters[key] = new Date().toISOString();
        await fs.mkdir(DF_DATA_DIR, { recursive: true });
        await atomicWriteJson(DF_SETTINGS_FILENAME, { ...settings, confirmedQuarters });
        sendJson(response, 200, { ok: true, confirmedQuarters });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存确认状态失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/df-refresh") {
      try {
        const body = await readJsonBody(request) as { months?: string[] };
        // 未来发薪月工资单不存在：财务系统查询未来月会残留当前数据，必须拦截在服务端
        const now = new Date();
        const monthCeiling = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const months = [...new Set(body.months ?? [])].filter((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= monthCeiling).sort();
        if (!months.length) { sendJson(response, 400, { error: "所选月份均未到发薪月" }); return; }
        const jobId = `df-${Date.now()}`;
        dfJobs.set(jobId, { state: "running" });

        const child = startSchoolScript(root, "tools/fetch_salary.py", ["--months", months.join(",")]);
        let logTail = "";
        const appendLog = (chunk: Buffer) => { logTail = `${logTail}${chunk}`.slice(-2000); };
        child.stdout.on("data", appendLog);
        child.stderr.on("data", appendLog);
        child.on("error", (error) => dfJobs.set(jobId, { state: "failed", error: error.message }));
        child.on("close", (code) => {
          if (code === 0) dfJobs.set(jobId, { state: "completed", log: logTail });
          else dfJobs.set(jobId, { state: "failed", error: logTail.trim().split("\n").slice(-3).join("\n") || `抓取脚本退出码 ${code}` });
        });
        sendJson(response, 202, { jobId });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法启动 DF 抓取" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/df-refresh-status") {
      const job = dfJobs.get(requestUrl.searchParams.get("jobId") ?? "");
      if (!job) { sendJson(response, 404, { error: "抓取任务不存在或已失效" }); return; }
      if (job.state !== "running") dfJobs.delete(requestUrl.searchParams.get("jobId") ?? "");
      sendJson(response, 200, job);
      return;
    }

    // ---- 实验室劳务费：名单 data/labor/roster.json + 发放记录 data/labor/months.json + 设置 data/labor/settings.json ----
    const LABOR_DIR = path.join(root, "data", "labor");
    const readLaborJson = async <T>(filename: string, fallback: T): Promise<T> => {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(LABOR_DIR, filename), "utf8")) as T;
        return parsed ?? fallback;
      } catch {
        return fallback;
      }
    };
    /** 导师/负责人姓名：取用户档案中的中文姓名（标题、导师列与输出文件名共用）。 */
    const readLaborOwner = async (): Promise<string> => {
      try {
        const doc = JSON.parse(await fs.readFile(path.join(root, ".guanzizai", "user-profiles", "profiles.json"), "utf8")) as Array<{ profile?: { chineseName?: string } }>;
        return doc.find((entry) => entry.profile?.chineseName)?.profile?.chineseName?.trim() ?? "";
      } catch {
        return "";
      }
    };
    const runLaborGenerate = async (month: string): Promise<{ path: string; rows: number; total: number }> => {
      const owner = await readLaborOwner();
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = startSchoolScript(root, "tools/generate_labor_payroll.py", ["--month", month, "--owner", owner]);
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { out += `\nstderr: ${chunk.toString().slice(0, 300)}`; });
        void child.on("close", (code) => {
          const jsonLine = out.trim().split("\n").reverse().find((line) => line.trim().startsWith("{"));
          if (code === 0 && jsonLine) resolve(jsonLine);
          else reject(new Error(out.trim().split("\n").slice(-2).join(" ").slice(-300)));
        });
      });
      return JSON.parse(stdout) as { path: string; rows: number; total: number };
    };
    /** 记录生成事件：months.json 写 generatedAt + 名单快照（重生成覆盖快照）。 */
    const recordLaborGenerated = async (month: string, members: LaborMember[]) => {
      const doc = await readLaborJson<{ months?: Record<string, Record<string, unknown>> }>("months.json", {});
      doc.months = { ...(doc.months ?? {}) };
      const previous = (doc.months[month] ?? {}) as { confirmedAt?: string };
      doc.months[month] = { ...previous, generatedAt: new Date().toISOString(), rows: laborRowsFromMembers(members) };
      await fs.mkdir(LABOR_DIR, { recursive: true });
      await atomicWriteJson(path.join(LABOR_DIR, "months.json"), doc);
    };
    /** 自动生成：已启用 + 已到当月生成日（1 号遇周末顺延）+ 当月尚未生成。server 常驻时每小时检查。 */
    const laborAutoGenerateCheck = async () => {
      try {
        const settings = await readLaborJson<{ enabled?: boolean }>("settings.json", {});
        if (settings.enabled === false) return;
        const doc = await readLaborJson<{ months?: Record<string, { generatedAt?: string }> }>("months.json", {});
        const now = new Date();
        const month = laborMonthKey(now.getFullYear(), now.getMonth() + 1);
        if (doc.months?.[month]?.generatedAt) return;
        if (!isLaborGenerationDue(now.getFullYear(), now.getMonth() + 1, now)) return;
        const members = (await readLaborJson<{ members?: LaborMember[] }>("roster.json", {})).members ?? [];
        if (!members.length) return;
        await runLaborGenerate(month);
        await recordLaborGenerated(month, members);
        serverTrace({ level: "info", scope: "labor", event: "auto-generated", detail: `${month} 发放表已自动生成`, task: "劳务费" });
      } catch (error) {
        serverTrace({ level: "warn", scope: "labor", event: "auto-generate-failed", detail: error instanceof Error ? error.message : "自动生成失败", task: "劳务费" });
      }
    };
    const gLabor = globalThis as { __laborTimer?: ReturnType<typeof setInterval> };
    const ensureLaborTimer = () => {
      if (gLabor.__laborTimer) return;
      void laborAutoGenerateCheck();
      gLabor.__laborTimer = setInterval(() => void laborAutoGenerateCheck(), 60 * 60 * 1000);
      gLabor.__laborTimer.unref?.();
    };

    /** elab 报账单自动追踪：每 10 分钟扫一遍有活跃（draft/submitted）登记的票据集，
     * 按 system 分抓 zcgl/wxzc 列表回写状态；审核通过自动打印报账单 PDF 入集（syncElabStatus 内建）。
     * 防重入：上一轮未结束跳过；失败静默（trace warn），不影响手动同步按钮。 */
    let elabSyncRunning = false;
    const elabAutoSyncCheck = async () => {
      if (elabSyncRunning) return;
      elabSyncRunning = true;
      try {
        const doc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
        const active = (doc.lines ?? []).filter((line) => ((line.elabBills as Array<{ status?: string }> | undefined) ?? []).some((bill) => bill.status === "draft" || bill.status === "submitted"));
        for (const line of active) {
          const lineId = String(line.id ?? "");
          const bills = (line.elabBills as Array<{ system?: string }>) ?? [];
          for (const system of (["zcgl", "wxzc"] as const)) {
            if (!bills.some((bill) => (bill.system ?? "zcgl") === system)) continue;
            try {
              const result = await syncElabStatus(root, lineId, system);
              if (result.updated.length) serverTrace({ level: "info", scope: system === "wxzc" ? "elab-csf" : "elab-hc", event: "auto-synced", detail: `${lineId}: ${result.updated.map((u) => `${u.billNo}→${u.status}`).join(", ")}`, task: "elab前置单" });
            } catch (error) {
              serverTrace({ level: "warn", scope: system === "wxzc" ? "elab-csf" : "elab-hc", event: "auto-sync-failed", detail: `${lineId}: ${error instanceof Error ? error.message : String(error).slice(0, 80)}`, task: "elab前置单" });
            }
          }
        }
      } catch {
        // 静默：文件读取失败等不致命
      } finally {
        elabSyncRunning = false;
      }
    };
    // timer 必须挂在进程级（globalThis）——middleware 是每请求执行的作用域，
    // 在体内 let 守卫 = 每个请求都新建 interval，18 分钟泄漏出 381 个 sync/playwright 进程（2026-09-23 Chrome 风暴实证）。
    // server restart（config 变更）时先清旧 timer 再建新的，进程内恒一个。
    const gTimer = globalThis as { __elabSyncTimer?: ReturnType<typeof setInterval> };
    if (gTimer.__elabSyncTimer) clearInterval(gTimer.__elabSyncTimer);
    gTimer.__elabSyncTimer = setInterval(() => void elabAutoSyncCheck(), 10 * 60 * 1000);
    gTimer.__elabSyncTimer.unref?.();

    if (request.method === "GET" && requestUrl.pathname === "/api/labor") {
      try {
        ensureLaborTimer();
        const [settings, roster, months, owner] = await Promise.all([
          readLaborJson<{ enabled?: boolean }>("settings.json", {}),
          readLaborJson<{ members?: LaborMember[] }>("roster.json", {}),
          readLaborJson<{ months?: Record<string, unknown> }>("months.json", {}),
          readLaborOwner(),
        ]);
        sendJson(response, 200, {
          settings: { enabled: settings.enabled === undefined ? true : Boolean(settings.enabled), ownerName: owner },
          members: roster.members ?? [],
          months: months.months ?? {},
        });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取劳务费数据" });
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/labor/roster") {
      try {
        const body = await readJsonBody(request) as { members?: LaborMember[] };
        if (!Array.isArray(body.members)) { sendJson(response, 400, { error: "缺少 members" }); return; }
        const members = body.members
          .filter((member) => member && typeof member.name === "string")
          .map((member, index) => ({
            id: typeof member.id === "string" && member.id ? member.id : `labor-${Date.now()}-${index}`,
            name: String(member.name).slice(0, 40).trim(),
            degree: String(member.degree ?? "硕").slice(0, 4).trim(),
            studentId: String(member.studentId ?? "").slice(0, 20).trim(),
            workContent: String(member.workContent ?? "参与研究课题调研").slice(0, 60).trim(),
            amount: Number.isFinite(Number(member.amount)) ? Number(member.amount) : 0,
            note: member.note ? String(member.note).slice(0, 60) : undefined,
          }));
        await fs.mkdir(LABOR_DIR, { recursive: true });
        await atomicWriteJson(path.join(LABOR_DIR, "roster.json"), { members });
        sendJson(response, 200, { ok: true, members });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存名单失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/labor/generate") {
      try {
        ensureLaborTimer();
        const body = await readJsonBody(request) as { month?: string };
        const parsed = typeof body.month === "string" ? parseLaborMonthKey(body.month) : null;
        if (!parsed) { sendJson(response, 400, { error: "无效的月份（应为 YYYY-MM）" }); return; }
        const month = laborMonthKey(parsed[0], parsed[1]);
        const result = await runLaborGenerate(month);
        const members = (await readLaborJson<{ members?: LaborMember[] }>("roster.json", {})).members ?? [];
        await recordLaborGenerated(month, members);
        sendJson(response, 200, { ok: true, month, ...result });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "生成发放表失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/labor/confirm") {
      try {
        const body = await readJsonBody(request) as { month?: string; confirmed?: boolean };
        const parsed = typeof body.month === "string" ? parseLaborMonthKey(body.month) : null;
        if (!parsed) { sendJson(response, 400, { error: "无效的月份（应为 YYYY-MM）" }); return; }
        const month = laborMonthKey(parsed[0], parsed[1]);
        const doc = await readLaborJson<{ months?: Record<string, Record<string, unknown>> }>("months.json", {});
        doc.months = { ...(doc.months ?? {}) };
        const record = { ...(doc.months[month] ?? {}) };
        if (body.confirmed === false) delete record.confirmedAt;
        else {
          if (!record.generatedAt) { sendJson(response, 400, { error: "当月表格尚未生成，无法确认已发" }); return; }
          record.confirmedAt = new Date().toISOString();
        }
        doc.months[month] = record;
        await fs.mkdir(LABOR_DIR, { recursive: true });
        await atomicWriteJson(path.join(LABOR_DIR, "months.json"), doc);
        sendJson(response, 200, { ok: true, months: doc.months });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存确认状态失败" });
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/labor/settings") {
      try {
        const body = await readJsonBody(request) as { enabled?: boolean };
        const next = { enabled: body.enabled === undefined ? true : Boolean(body.enabled) };
        await fs.mkdir(LABOR_DIR, { recursive: true });
        await atomicWriteJson(path.join(LABOR_DIR, "settings.json"), next);
        sendJson(response, 200, { ok: true, settings: next });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "保存设置失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/model-state") {
      try {
        const model = await readFormalModel(root) as FormalModelState | null;
        if (model?.sets?.length) {
          const history = await fs.readFile(path.join(root, "treasury_research", "backup", "history_reimbursements.json"), "utf8")
            .then((raw) => JSON.parse(raw) as Array<{ 报销单号?: string; 项目号?: string }>)
            .catch(() => []);
          const projectByBill = new Map((Array.isArray(history) ? history : [])
            .filter((row) => row?.报销单号 && row.项目号 && row.项目号 !== "无")
            .map((row) => [row.报销单号, row.项目号]));
          for (const line of model.sets) {
            const bills = lineTreasuryBills(line);
            if (bills.some((bill) => !bill.projectCode && projectByBill.has(bill.billNo))) {
              line.treasuryBills = bills.map((bill) => ({ ...bill, projectCode: bill.projectCode || projectByBill.get(bill.billNo) }));
            }
          }
        }
        sendJson(response, 200, { model });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取形式化模型" });
      }
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === "/api/model-state") {
      try {
        const incoming = await readJsonBody(request) as Partial<FormalModelState> & { sets?: Array<FormalModelState["sets"][number] & Record<string, unknown>> };
        // treasury 对齐字段（报销单号/财务状态/凭证号/入账日期）以服务器文件为权威：
        // 对齐脚本（treasury_research/apply_alignment.py）写入后，行 reconcile 下行覆盖时保留。
        // 脚本侧的 status 迁移（如在途单转已递交、未匹配单转已递交）同样保留——
        // 仅当服务器行已带 treasury 标记而下行行不带时（说明该行被脚本改过而 UI 未动）。
        const previous = await readFormalModel(root);
        const saved = (previous as { sets?: Array<Record<string, unknown>> } | null)?.sets ?? [];
        const savedById = new Map(saved.filter((entry) => typeof entry.treasuryBillNo === "string" || typeof entry.treasuryStatus === "string").map((entry) => [entry.id, entry]));
        if (savedById.size && Array.isArray(incoming.sets)) {
          for (const entry of incoming.sets) {
            const keep = savedById.get(entry.id as string);
            if (!keep) continue;
            if (typeof entry.treasuryBillNo !== "string" && typeof entry.treasuryStatus !== "string") {
              for (const key of ["status", "submittedAt", "title", "folder", "treasuryBillNo", "treasuryBillNos", "treasuryStatus", "treasuryStatusAt", "treasuryVoucherNo", "treasuryPostedAt", "treasuryAmountCny", "treasuryBills"]) {
                if (keep[key] != null) entry[key] = keep[key];
              }
            } else {
              for (const key of ["status", "submittedAt", "treasuryBillNo", "treasuryBillNos", "treasuryStatus", "treasuryStatusAt", "treasuryVoucherNo", "treasuryPostedAt", "treasuryAmountCny", "treasuryBills"]) {
                if (keep[key] != null) entry[key] = keep[key];
              }
            }
          }
        }
        // tombstone remap：已删除的票据集不得经旧快照回写复活；费用 setId 按 remap 跟随迁移（2026-09-19 低耗拆分两次被洗回实证）
        try {
          const removedMap = await readRemovedLineMap();
          const removedKeys = new Set(Object.keys(removedMap));
          if (removedKeys.size && Array.isArray(incoming.sets)) {
            incoming.sets = incoming.sets.filter((entry) => !removedKeys.has(String((entry as { id?: unknown }).id ?? "")));
          }
          if (removedKeys.size && Array.isArray(incoming.expenses)) {
            for (const expense of incoming.expenses as Array<{ setId?: string }>) {
              const target = removedMap[String(expense.setId ?? "")];
              if (target !== undefined) expense.setId = target ?? "";
            }
          }
        } catch { /* tombstone 读取失败按原样写 */ }
        // 拆分迁移重定向：旧窗口快照里的费用 setId / evidence.path 会被洗回源集——按拆分登记强制改到新集
        try {
          const remaps = JSON.parse(await fs.readFile(path.join(root, "data", "expense-set-remaps.json"), "utf8").catch(() => "{}")) as { expenses?: Record<string, string>; evidencePaths?: Record<string, string>; deletedExpenses?: string[]; deletedEvidence?: string[] };
          const expenseRemaps = remaps.expenses ?? {};
          if (Object.keys(expenseRemaps).length && Array.isArray(incoming.expenses)) {
            for (const expense of incoming.expenses as Array<{ id?: unknown; setId?: string }>) {
              const target = expenseRemaps[String(expense.id ?? "")];
              if (target) expense.setId = target;
            }
          }
          const evidenceRemaps = remaps.evidencePaths ?? {};
          if (Object.keys(evidenceRemaps).length && Array.isArray(incoming.evidence)) {
            for (const item of incoming.evidence as Array<{ id?: unknown; path?: string }>) {
              const target = evidenceRemaps[String(item.id ?? "")];
              if (target) item.path = target;
            }
          }
          // 删除 tombstone：从票据集移除（不合规/误识别）的费用与证据不得经旧窗口快照复活
          // （2026-09-30 市内交通退回删票实证：删掉的 7 笔被旧窗口 PUT 恢复）
          const deadExpenses = new Set(remaps.deletedExpenses ?? []);
          if (deadExpenses.size) {
            if (Array.isArray(incoming.expenses)) incoming.expenses = incoming.expenses.filter((expense) => !deadExpenses.has(String(expense.id ?? "")));
            if (Array.isArray(incoming.links)) incoming.links = incoming.links.filter((link) => !deadExpenses.has(String(link.expenseId ?? "")));
          }
          const deadEvidence = new Set(remaps.deletedEvidence ?? []);
          if (deadEvidence.size && Array.isArray(incoming.evidence)) {
            incoming.evidence = incoming.evidence.filter((item) => !deadEvidence.has(String(item.id ?? "")));
          }
          // stale-snapshot 合并防护（与 receipt-lines 同款）：旧窗口快照缺少服务器已有的费用/证据时，
          // 保留服务器版本——否则离线修复写入的新行会被任何一次旧窗口 PUT 静默删除。
          try {
            serverTrace({ level: "debug", scope: "model-state", event: "stale-merge-enter", detail: `previous 证据 ${(previous as { evidence?: unknown[] })?.evidence?.length ?? "?"} incoming 证据 ${(incoming.evidence as unknown[])?.length ?? "?"}` });
            const previousModel = previous as Partial<FormalModelState> | null;
            const incomingExpIds = new Set((incoming.expenses ?? []).map((item) => String((item as { id?: unknown }).id ?? "")));
            const keptExpenses = (previousModel?.expenses ?? []).filter((item) => !incomingExpIds.has(String(item.id ?? "")) && !deadExpenses.has(String(item.id ?? "")));
            const incomingEvIds = new Set((incoming.evidence ?? []).map((item) => String((item as { id?: unknown }).id ?? "")));
            const incomingEvidence = incoming.evidence as FormalModelState["evidence"] | undefined;
            const scopedScheduleIds = new Set((incomingEvidence ?? []).filter((item) => item.typeId === "fee-schedule").map((item) => item.id));
            const keptEvidence = (previousModel?.evidence ?? []).filter((item) => !incomingEvIds.has(item.id) && !deadEvidence.has(item.id)
              && !(item.typeId === "fee-schedule" && [...scopedScheduleIds].some((id) => id.startsWith(`${item.id}:set:`))));
            const coveredEv = new Set((incoming.links ?? []).map((lk) => String((lk as { evidenceId?: unknown }).evidenceId ?? "")));
            const incomingLinkKeys = new Set((incoming.links ?? []).map((lk) => `${(lk as { evidenceId?: unknown }).evidenceId}|${(lk as { expenseId?: unknown }).expenseId}|${(lk as { role?: unknown }).role ?? ""}`));
            const keptLinks = (previousModel?.links ?? []).filter((lk) => {
              const key = `${lk.evidenceId}|${lk.expenseId}|${lk.role ?? ""}`;
              if (lk.role === "standard" && scopedScheduleIds.has(lk.evidenceId)) return false;
              return !incomingLinkKeys.has(key) && (incomingEvIds.has(String(lk.evidenceId)) || coveredEv.has(lk.evidenceId)) && (incomingExpIds.has(String(lk.expenseId)) || keptExpenses.some((x) => x.id === lk.expenseId));
            });
            if (keptExpenses.length || keptEvidence.length || keptLinks.length) serverTrace({ level: "info", scope: "model-state", event: "stale-merge", detail: `补回费用 ${keptExpenses.length} 证据 ${keptEvidence.length} 链接 ${keptLinks.length}` });
            if (keptExpenses.length) incoming.expenses = [...(incoming.expenses ?? []), ...keptExpenses];
            if (keptEvidence.length) incoming.evidence = [...(incoming.evidence ?? []), ...keptEvidence];
            if (keptLinks.length) incoming.links = [...(incoming.links ?? []), ...keptLinks];
          } catch (mergeError) { serverTrace({ level: "error", scope: "model-state", event: "stale-merge-fail", detail: mergeError instanceof Error ? mergeError.message : String(mergeError) }); }
        } catch { /* remap 读取失败按原样写 */ }
        if (Array.isArray(incoming.sets)) {
          const latest = await readFormalModel(root) as { sets?: Array<Record<string, unknown>> } | null;
          const latestById = new Map((latest?.sets ?? []).map((entry) => [entry.id, entry]));
          for (const entry of incoming.sets) preserveArchiveState(root, entry, latestById.get(entry.id));
        }
        if (Array.isArray(incoming.links) && Array.isArray(incoming.evidence) && Array.isArray(incoming.expenses) && Array.isArray(incoming.sets)) {
          incoming.links = withoutCrossSetSupportLinks(incoming.links, incoming.evidence, incoming.expenses, incoming.sets);
        }
        await writeFormalModel(root, incoming);
        sendJson(response, 200, { saved: true });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存形式化模型" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/exchange-rates/refresh") {
      try {
        const rates = await fetchOnlineExchangeRates();
        sendJson(response, 200, { source: "Frankfurter", fetchedAt: new Date().toISOString(), rates });
      } catch (error) {
        sendJson(response, 502, { error: error instanceof Error ? error.message : "在线汇率更新失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ask-ai") {
      try {
        const body = await readJsonBody(request) as { setId?: unknown; templateId?: unknown; question?: unknown; history?: unknown; backend?: unknown; model?: unknown };
        const setId = typeof body.setId === "string" && body.setId.trim() ? body.setId.trim() : "";
        if (!setId) throw new Error("缺少票据集 ID");
        const templateId = typeof body.templateId === "string" ? body.templateId : "";
        const customQuestion = typeof body.question === "string" ? body.question.trim() : "";
        const askAiTemplates: Record<string, string> = {
          "amount-audit": "对比该票据集去重后的材料合计与报销单申请金额（如已递交），逐一解释差异来源（重复凭证、汇率口径、漏计、实付与开票差异等），并判断金额是否合理。",
          "completeness": "检查该票据集的材料完整性与财务合规性：必需材料是否齐全、金额口径是否一致、有哪些风险点，给出补充建议清单。",
          "status-explain": "解读该票据集当前所处的报销流程阶段与各状态字段含义，说明下一步应该做什么、预计还要多久。",
        };
        const question = customQuestion || askAiTemplates[templateId] || "";
        if (!question) throw new Error("请选择预设模板或输入自定义问题");
        const formalModel = (await readFormalModel(root)) as { sets?: Array<Record<string, unknown>>; expenses?: DedupeExpenseLike[] } | null;
        const setRecord = formalModel?.sets?.find((candidate) => candidate.id === setId);
        if (!setRecord) throw new Error("未找到该票据集");
        const expenses = (formalModel?.expenses ?? []).filter((expense) => expense.setId === setId);
        const dedupedExpenses = dedupeExpenses(expenses);
        const folderValue = typeof setRecord.folder === "string" ? setRecord.folder : "";
        const recordFiles: string[] = [];
        if (folderValue) {
          const targetFolder = path.join(root, folderValue);
          if (targetFolder.startsWith(root) && existsSync(targetFolder)) {
            const walkDirectory = async (directory: string, depth: number): Promise<void> => {
              if (recordFiles.length >= 200 || depth > 3) return;
              for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (recordFiles.length >= 200) return;
                const relative = path.relative(root, path.join(directory, entry.name));
                if (entry.isDirectory()) await walkDirectory(path.join(directory, entry.name), depth + 1);
                else recordFiles.push(relative);
              }
            };
            await walkDirectory(targetFolder, 0);
          }
        }
        const factSnapshot = {
          票据集: Object.fromEntries(["id", "title", "kind", "status", "createdAt", "submittedAt", "treasuryStatus", "treasuryBillNo", "treasuryStatusAt"].map((key) => [key, setRecord[key] ?? null])),
          报销单申请金额CNY: setRecord.treasuryAmountCny ?? null,
          去重后材料合计CNY: Number(dedupedExpenses.kept.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0).toFixed(2)),
          计入合计的费用行: dedupedExpenses.kept.map((expense) => ({ 商户: expense.merchant, 类型: expense.typeId, 发生日期: expense.occurredAt, 币种: expense.currency, 原币金额: expense.amount, CNY金额: expense.amountCny != null ? Number(expense.amountCny.toFixed(2)) : null, 汇率来源: expense.exchangeRate?.source })),
          已排除的重复凭证行: dedupedExpenses.duplicates.map((expense) => ({ 商户: expense.merchant, 币种: expense.currency, 原币金额: expense.amount, CNY金额: expense.amountCny != null ? Number(expense.amountCny.toFixed(2)) : null })),
          文件夹材料清单: recordFiles,
        };
        const historyText = Array.isArray(body.history)
          ? (body.history as Array<unknown>).slice(-4).map((entry) => {
              if (!entry || typeof entry !== "object") return "";
              const pair = entry as { q?: unknown; a?: unknown };
              const q = typeof pair.q === "string" ? pair.q.slice(0, 400) : "";
              const a = typeof pair.a === "string" ? pair.a.slice(0, 1_500) : "";
              return q ? `问：${q}\n答：${a}` : "";
            }).filter(Boolean).join("\n\n")
          : "";
        const prompt = `你是高校科研经费报销助理，正在帮助教师解答关于某个票据集的问题。只依据下方"票据集事实 JSON"回答；所有数字必须直接引用该 JSON，禁止编造；先给结论，再给依据，最后给建议动作；用简体中文；不超过 350 字。\n\n${historyText ? `之前的对话（供参考）：\n${historyText}\n\n` : ""}票据集事实 JSON：\n${JSON.stringify(factSnapshot, null, 1)}\n\n本次问题：${question}`;
        let answer = "";
        const backend = typeof body.backend === "string" ? body.backend : "";
        const requestModel = typeof body.model === "string" ? body.model : "";
        if (backend === "api") {
          const apiKey = await readSavedApiKey();
          if (!apiKey) throw new Error("请先在 AI 后端设置中保存 API Key");
          const provider = apiProviderForApiKey(apiKey, (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl);
          answer = await callChatModel(provider, apiKey, { model: requestModel || provider.defaultModel, prompt, maxTokens: 2_048 , disableThinking: true });
        } else if (backend === "codex") {
          answer = await runCodexCli(["exec", "--skip-git-repo-check", ...(requestModel ? ["-m", requestModel] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", prompt], 120_000);
        } else if (backend === "opencode") {
          answer = await runOpencodeCli([...(requestModel ? ["-m", requestModel] : []), "--", prompt], 120_000);
        } else {
          throw new Error("请先在右上角 AI 后端设置中选择后端并保存 API Key");
        }
        sendJson(response, 200, { answer });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "AI 回答失败" });
      }
      return;
    }

    // 费用清单「AI 搜索引用」：从历史材料中检索当前订阅节点可复用的费用清单（订阅逐月发生、
    // 清单通常相同，续费标准不变时无需重复存储）。AI 失败降级为粗筛排序（degraded），列表仍可用。
    if (request.method === "POST" && requestUrl.pathname === "/api/evidence-search") {
      try {
        const body = await readJsonBody(request) as { lineId?: unknown; nodeId?: unknown; query?: unknown; backend?: unknown; model?: unknown; rerank?: unknown };
        const lineId = typeof body.lineId === "string" ? body.lineId : "";
        const nodeId = typeof body.nodeId === "string" ? body.nodeId.slice(0, 64) : "";
        const query = typeof body.query === "string" ? body.query.trim().slice(0, 200) : "";
        if (!lineId || !nodeId) { sendJson(response, 400, { error: "缺少票据集或材料项" }); return; }
        const linesDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
        const line = (linesDoc.lines ?? []).find((entry) => entry.id === lineId);
        const lineFolder = typeof line?.folder === "string" ? line.folder : "";
        const lineTitle = typeof line?.title === "string" ? line.title : "";
        if (!line || !lineFolder) { sendJson(response, 404, { error: "未找到该票据集" }); return; }
        const model = await readFormalModel(root) as { sets?: Array<Record<string, unknown>>; evidence?: Array<Record<string, unknown>> } | null;
        const sets = (model?.sets ?? []).map((entry) => ({ folder: String(entry.folder ?? ""), title: String(entry.title ?? "") }));
        // 模型 evidence.path 可能滞后于文件移动（票据集归档 30_已提交→90_已归档 后模型未刷新）：
        // 磁盘定位失败的材料按文件名在全库兜底重定位（优先路径尾部目录段一致的真实位置），搬家后仍可检索。
        const rawEvidence = (model?.evidence ?? []) as Array<Partial<EvidenceIndexItem>>;
        let filesByName: Map<string, string[]> | undefined;
        const locate = async (declared: string): Promise<string | null> => {
          const absolute = safeMaterialPath(root, encodeURIComponent(declared));
          if (absolute && existsSync(absolute)) return declared;
          if (!filesByName) {
            filesByName = new Map();
            for (const directory of MATERIAL_ROOTS) {
              for await (const relativePath of materialPaths(root, directory)) {
                const name = path.basename(relativePath);
                const paths = filesByName.get(name) ?? [];
                paths.push(relativePath);
                filesByName.set(name, paths);
              }
            }
          }
          const tail = declared.split("/").slice(-2).join("/");
          const found = filesByName.get(path.basename(declared))?.filter((item) => existsSync(path.join(root, item)));
          return found?.find((item) => item.endsWith(tail)) ?? found?.[0] ?? null;
        };
        const liveEvidence = new Map<string, EvidenceIndexItem>();
        for (const item of rawEvidence) {
          if (typeof item.path !== "string" || !item.path) continue;
          if (!isFeeScheduleLike({ ...item, path: item.path })) continue;
          const actual = await locate(item.path);
          if (actual && !liveEvidence.has(actual)) liveEvidence.set(actual, { ...item, path: actual });
        }
        let candidates = feeScheduleCandidates([...liveEvidence.values()], { nodeId, lineFolder, sets, query });
        if (body.rerank !== true || !candidates.length) { sendJson(response, 200, { candidates, degraded: false }); return; }
        let degraded = false;
        const backend = typeof body.backend === "string" ? body.backend : "";
        const requestModel = typeof body.model === "string" ? body.model : "";
        if (backend === "api" || backend === "codex" || backend === "opencode") {
          try {
            const shortlist = candidates.slice(0, 12);
            const listing = shortlist.map((item) => `- path=${item.path} | 所属集=${item.setTitle || "未知"} | 归类节点=${item.workflowNodeId || "无"} | 商户=${item.issuer || "无"} | 日期=${item.documentDate || "无"} | 金额=${item.amount != null ? `${item.amount} ${item.currency}`.trim() : "无"}`).join("\n");
            const prompt = `你是票据报销系统的材料检索助手。当前票据集《${lineTitle || lineFolder}》的材料项（节点 ID：${nodeId}）需要费用清单材料。\n背景：订阅类费用（如 ChatGPT Pro、云服务）逐月发生，费用清单通常每月完全相同——续费标准不变时可直接复用历史材料，不必重复上传。\n任务：判断候选历史材料中哪些适合作为该材料项的费用清单复用（关注服务商/订阅项目是否对应、材料性质是否为价格或费用清单）；${query ? `用户补充要求：${query}。` : ""}\n输出：仅输出 JSON 数组（不要任何其他文字、不要代码块标记），把每个候选都评一遍，每项形如 {"path":"<候选path原样>","match":true或false,"reason":"不超过30字的理由"}；path 必须原样引用候选列表中的值，禁止编造。\n候选材料：\n${listing}`;
            let answer = "";
            if (backend === "api") {
              const apiKey = await readSavedApiKey();
              if (!apiKey) throw new Error("请先在 AI 后端设置中保存 API Key");
              const provider = apiProviderForApiKey(apiKey, (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl);
              answer = await callChatModel(provider, apiKey, { model: requestModel || provider.defaultModel, prompt, maxTokens: 1_536, disableThinking: true, signal: AbortSignal.timeout(30_000) });
            } else if (backend === "codex") {
              answer = await runCodexCli(["exec", "--skip-git-repo-check", ...(requestModel ? ["-m", requestModel] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", prompt], 30_000);
            } else {
              answer = await runOpencodeCli([...(requestModel ? ["-m", requestModel] : []), "--", prompt], 30_000);
            }
            const shortlistedPaths = new Set(shortlist.map((candidate) => candidate.path));
            const reply = parseEvidenceSearchReply(answer).filter((item) => shortlistedPaths.has(item.path));
            if (!reply.length) throw new Error("AI 未返回有效的候选判断");
            candidates = applySearchReply(candidates, reply);
          } catch (searchError) {
            degraded = true;
            serverTrace({ level: "warn", scope: "evidence-search", event: "ai-degraded", detail: searchError instanceof Error ? searchError.message : "AI 判断失败，按相关性排序返回", task: "AI 搜索引用" });
          }
        } else degraded = true;
        sendJson(response, 200, { candidates, degraded });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "历史材料检索失败" });
      }
      return;
    }

    // 费用清单「链接引用」：把历史材料以相对符号链接挂到当前票据集（同一物理文件不重复存储），
    // 保存用户指定的清单节点；模型按票据集区分同内容的清单引用。
    if (request.method === "POST" && requestUrl.pathname === "/api/evidence-link") {
      try {
        const body = await readJsonBody(request) as { lineId?: unknown; nodeId?: unknown; sourcePath?: unknown };
        const lineId = typeof body.lineId === "string" ? body.lineId : "";
        const nodeId = typeof body.nodeId === "string" ? body.nodeId.slice(0, 64) : "";
        const sourceRel = typeof body.sourcePath === "string" ? body.sourcePath : "";
        if (!lineId || !sourceRel || !DAILY_REQUIREMENTS.some((item) => item.id === nodeId && item.id.endsWith("-fee-schedule"))) {
          sendJson(response, 400, { error: "缺少票据集、有效的费用清单项或来源文件" }); return;
        }
        const sourceAbs = safeMaterialPath(root, sourceRel);
        if (!sourceAbs || !existsSync(sourceAbs) || !(await fs.stat(sourceAbs)).isFile()) { sendJson(response, 404, { error: "来源材料不存在" }); return; }
        const linesDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
        const line = (linesDoc.lines ?? []).find((entry) => entry.id === lineId);
        const lineFolder = typeof line?.folder === "string" ? line.folder : "";
        if (!line || !lineFolder) { sendJson(response, 404, { error: "未找到该票据集" }); return; }
        const folderAbs = safeLineFolder(lineFolder);
        if (!folderAbs) { sendJson(response, 400, { error: "票据集目录不可用" }); return; }
        await fs.mkdir(folderAbs, { recursive: true });
        // 目标集已有同内容材料时，直接将它设为用户指定的清单。
        const sourceHash = await fileContentHash(sourceAbs);
        const walkAndHash = async (directory: string): Promise<string | null> => {
          for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            if (entry.name.startsWith(".")) continue;
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) { const hit = await walkAndHash(absolutePath); if (hit) return hit; continue; }
            if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            if (await fileContentHash(absolutePath) === sourceHash) return toPosix(path.relative(root, absolutePath));
          }
          return null;
        };
        const duplicate = await walkAndHash(folderAbs);
        // 相对符号链接：仓库整体移动不断链；文件名沿用源规范名，重名不同内容时自动加 -2 后缀。
        const target = duplicate ? path.join(root, duplicate) : await uniqueFilePath(folderAbs, path.basename(sourceAbs));
        if (!duplicate) await fs.symlink(path.relative(folderAbs, sourceAbs), target);
        const targetRel = toPosix(path.relative(root, target));
        const referenceMeta: ReceiptMeta = { classifiedRequirementId: nodeId, classifiedWorkflowNodeId: nodeId,
          classificationReason: "AI 搜索引用历史费用清单", feeScheduleReferencedAt: new Date().toISOString() };
        await withReceiptMetaWrite(async () => {
          const metaPath = path.join(root, "data", "receipt-meta.json");
          const metaDoc = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}")) as { metadata?: Record<string, Record<string, unknown>> };
          metaDoc.metadata = metaDoc.metadata ?? {};
          metaDoc.metadata[targetRel] = { ...(metaDoc.metadata[targetRel] ?? {}), ...referenceMeta };
          await atomicWriteJson(metaPath, metaDoc);
        });
        serverTrace({ level: "info", scope: "evidence-search", event: "linked", detail: `${lineId} ${nodeId} ← ${sourceRel}（symlink）`, task: "AI 搜索引用" });
        sendJson(response, 200, { path: targetRel, metadata: referenceMeta });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "链接历史材料失败" });
      }
      return;
    }


    if (request.method === "GET" && requestUrl.pathname === "/api/ai-backend-status") {
      try {
        let cliVersion = "";
        try {
          const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 2_000 });
          cliVersion = stdout.trim();
        } catch {
          // CLI is optional; the settings UI will show it as unavailable.
        }
        let opencodeVersion = "";
        try {
          const { stdout } = await execFileAsync(await resolveOpencodeExecutable(), ["--version"], { timeout: 5_000 });
          opencodeVersion = stdout.trim();
        } catch {
          // CLI is optional; the settings UI will show it as unavailable.
        }
        sendJson(response, 200, { cliVersion, opencodeVersion, apiKeyConfigured: await hasSavedApiKey() });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取 AI 后端状态" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/ai-settings") {
      sendJson(response, 200, { settings: await readAiSettings(root) });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ai-settings") {
      try {
        const body = await readJsonBody(request);
        const settings = await writeAiSettings(root, body);
        sendJson(response, 200, { settings });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存 AI 设置" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/printers") {
      try {
        sendJson(response, 200, { printers: await listSystemPrinters(), configured: (await readPrintSettings(root)).printer, platform: process.platform });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取打印机列表" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/print-settings") {
      try {
        const body = await readJsonBody(request) as { printer?: unknown };
        const printer = typeof body.printer === "string" ? body.printer.trim() : "";
        const known = (await listSystemPrinters()).some((entry) => entry.name === printer);
        if (printer && !known) throw new Error("系统中不存在该打印机");
        await writePrintSettings(root, printer);
        sendJson(response, 200, { printer });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存打印机配置" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/print-log") {
      sendJson(response, 200, { entries: await readPrintLog(root), printer: (await readPrintSettings(root)).printer, unconfirmedHashes: [...(await readWindowsPendingPrints(root)).keys()] });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/treasury-status") {
      // 轻量可用性：SSO session 文件新鲜度（真实校验在递交时 e2e 登录步骤兜底）。
      try {
        // 路径与 tools/ecnu_treasury.py 的 STORAGE_PATH 一致（DF 集成后 data/df/session.json）。
        let session = path.join(root, "data", "df", "session.json");
        if (process.platform === "win32") {
          const profiles = await readUserProfiles(root) as Array<{ id?: string; profile?: { schoolSsoAccount?: string } }>;
          const configured = [];
          for (const profile of profiles) {
            const id = safeProfileId(profile.id ?? "");
            const account = profile.profile?.schoolSsoAccount?.trim() ?? "";
            if (id && account && await credentials.has(profileKeychainService(SCHOOL_SSO_KEYCHAIN_SERVICE, id))) {
              configured.push({ id, account });
            }
          }
          if (configured.length !== 1) {
            const reason = configured.length ? "当前目录有多个学校账号，请用独立数据目录运行" : "请先在用户资料中保存学校账号和密码";
            sendJson(response, 200, { state: "unavailable", reason });
            return;
          }
          const { id, account } = configured[0];
          await readSchoolSsoPassword(id, account);
          session = path.join(root, ".guanzizai", "user-profiles", id, "school", createHash("sha256").update(account).digest("hex"), "treasury.json");
          if (!existsSync(session)) {
            sendJson(response, 200, { state: "stale", reason: "已有学校凭据，首次操作时建立登录态" });
            return;
          }
        }
        const stat = await fs.stat(session).catch(() => null);
        if (!stat) { sendJson(response, 200, { state: "unavailable", reason: "尚无登录态，先运行一次财务系统自动化或预算拉取" }); return; }
        const ageDays = (Date.now() - stat.mtimeMs) / 86_400_000;
        sendJson(response, 200, ageDays < 7 ? { state: "ready", ageDays: Math.round(ageDays * 10) / 10 } : { state: "stale", ageDays: Math.round(ageDays) , reason: `登录态已 ${Math.round(ageDays)} 天未刷新，递交时将自动重登` });
      } catch (error) {
        sendJson(response, 200, { state: "unavailable", reason: error instanceof Error ? error.message : "检测失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/elab-hc-plan") {
      // elab HC 填报计划：递交前确定全部参数（明细/发票号/经费卡），面板确认后才发起。
      try {
        const lineId = requestUrl.searchParams.get("lineId") ?? "";
        const expenseIds = (requestUrl.searchParams.get("expenseIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const plan = await buildElabHcPlan(root, lineId, expenseIds.length ? expenseIds : undefined);
        sendJson(response, 200, { plan });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法生成 elab 填报计划" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/elab-hc-submit") {
      try {
        const body = await readJsonBody(request) as { lineId?: string; plan?: { bills?: Array<{ invoiceFile?: string; name?: string; dj?: string; fph?: string }> } };
        // 参数由服务端按 model 重建（invoiceFile 路径始终服务端定）；品名/单价/发票号允许面板编辑覆盖。
        const bodyAny = body as { autoSubmit?: boolean };
        const plan = await buildElabHcPlan(root, String(body.lineId ?? ""));
        const overrides = body.plan?.bills ?? [];
        if (overrides.length) {
          plan.bills = plan.bills.map((bill) => {
            const override = overrides.find((item) => item.invoiceFile === bill.invoiceFile);
            if (!override) return bill;
            return {
              ...bill,
              name: typeof override.name === "string" && override.name.trim() ? override.name.trim() : bill.name,
              dj: typeof override.dj === "string" && override.dj.trim() && !Number.isNaN(Number(override.dj)) ? Number(override.dj).toFixed(2) : bill.dj,
              fph: typeof override.fph === "string" ? override.fph.replace(/\D/g, "") : bill.fph,
            };
          });
          plan.total = Number(plan.bills.reduce((sum, bill) => sum + Number(bill.dj) * Number(bill.sl || 1), 0).toFixed(2));
        }
        const missing = plan.bills.filter((bill) => !bill.fph);
        if (missing.length) {
          throw new Error(`发票号缺失，拒绝填报：${missing.map((bill) => bill.invoiceFile.split("/").pop()).join("、")}（图片发票请先走双源验证补齐）`);
        }
        const jobId = `elabhc-${Date.now()}`;
        const job: ElabHcJob = { state: "running", lineId: plan.lineId, step: "启动", log: [], startedAt: Date.now(), billNo: "" };
        elabHcJobs.set(jobId, job);
        serverTrace({ level: "info", scope: "elab-hc", event: "start", detail: `${plan.bills.length} 笔明细 · 合计 CNY ${plan.total.toFixed(2)} · 经费 ${plan.jfly}（${plan.jflyProject.slice(0, 16)}）· 附件 ${plan.attachments.length} 份`, task: "elab前置单" });
        // autoApprove 跟随 autoSubmit（默认开）：提交成功后自动同意「经费负责人审批」环节（审批人=本人）
        startElabHcJob(root, job, jobId, { jfly: plan.jfly, bills: plan.bills, attachments: plan.attachments, expenseIds: plan.expenseIds, autoSubmit: bodyAny.autoSubmit !== false, autoApprove: bodyAny.autoSubmit !== false, dumpDir: "data/autobx_logs/elab_dumps" });
        sendJson(response, 200, { jobId });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法启动 elab 填报" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/elab-hc-status") {
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      const job = elabHcJobs.get(jobId);
      if (!job) { sendJson(response, 404, { error: "任务不存在" }); return; }
      sendJson(response, 200, { state: job.state, step: job.step, error: job.error, billNo: job.billNo, log: job.log.slice(-80), startedAt: job.startedAt });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/elab-csf-plan") {
      // elab CSF（软件服务费）填报计划：云服务/AI 订阅费用 → 明细 + invoice/receipt 附件。无经费来源（CSF 单不填）。
      try {
        const lineId = requestUrl.searchParams.get("lineId") ?? "";
        const expenseIds = (requestUrl.searchParams.get("expenseIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const plan = await buildElabCsfPlan(root, lineId, expenseIds.length ? expenseIds : undefined);
        sendJson(response, 200, { plan });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法生成 CSF 填报计划" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/elab-csf-submit") {
      try {
        const body = await readJsonBody(request) as { lineId?: string; autoSubmit?: boolean; plan?: { bills?: Array<{ name?: string; dj?: string; bz?: string }> } };
        // 参数由服务端按 model 重建；品名/金额/备注允许面板编辑覆盖（fph 留空合法——境外服务无中国发票）。
        const plan = await buildElabCsfPlan(root, String(body.lineId ?? ""));
        const overrides = body.plan?.bills ?? [];
        if (overrides.length) {
          plan.bills = plan.bills.map((bill, index) => {
            const override = overrides[index];
            if (!override) return bill;
            return {
              ...bill,
              name: typeof override.name === "string" && override.name.trim() ? override.name.trim() : bill.name,
              dj: typeof override.dj === "string" && override.dj.trim() && !Number.isNaN(Number(override.dj)) ? Number(override.dj).toFixed(2) : bill.dj,
              bz: typeof override.bz === "string" ? override.bz : bill.bz,
            };
          });
          plan.total = Number(plan.bills.reduce((sum, bill) => sum + Number(bill.dj) * Number(bill.sl || 1), 0).toFixed(2));
        }
        const jobId = `elabcsf-${Date.now()}`;
        const job: ElabHcJob = { state: "running", lineId: plan.lineId, step: "启动", log: [], startedAt: Date.now(), billNo: "" };
        elabHcJobs.set(jobId, job);
        serverTrace({ level: "info", scope: "elab-csf", event: "start", detail: `${plan.bills.length} 笔明细 · 合计 CNY ${plan.total.toFixed(2)} · 附件 ${plan.attachments.length} 份（invoice/receipt）${body.autoSubmit !== false ? " · 自动提交" : " · 仅草稿"}`, task: "elab前置单" });
        startElabCsfJob(root, job, jobId, { bills: plan.bills.map(({ invoiceFile: _if, merchant: _m, dj, ...rest }) => ({ ...rest, zj: dj })), attachments: plan.attachments, expenseIds: plan.expenseIds, autoSubmit: body.autoSubmit !== false, dumpDir: "data/autobx_logs/elab_dumps" });
        sendJson(response, 200, { jobId });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法启动 CSF 填报" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/elab-csf-status") {
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      const job = elabHcJobs.get(jobId);
      if (!job) { sendJson(response, 404, { error: "任务不存在" }); return; }
      sendJson(response, 200, { state: job.state, step: job.step, error: job.error, billNo: job.billNo, log: job.log.slice(-80), startedAt: job.startedAt });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/elab-csf-stop") {
      const body = await readJsonBody(request) as { jobId?: string };
      const job = elabHcJobs.get(String(body.jobId ?? ""));
      if (job && job.state === "running") {
        job.stopRequested = true;
        job.child?.kill("SIGTERM");
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/elab-hc-sync") {
      // 状态追踪：抓 elab 列表真实状态回写 line.elabBills（审核中→已提交待审、已审核→已审核通过等）；system=zcgl|wxzc 选列表
      try {
        const body = await readJsonBody(request) as { lineId?: string; system?: string };
        const system = body.system === "wxzc" ? "wxzc" : "zcgl";
        const result = await syncElabStatus(root, String(body.lineId ?? ""), system);
        sendJson(response, 200, { updated: result.updated, elabBills: result.elabBills });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "状态同步失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/elab-hc-stop") {
      try {
        const body = await readJsonBody(request) as { jobId?: string };
        const job = elabHcJobs.get(String(body.jobId ?? ""));
        if (!job) throw new Error("任务不存在");
        if (job.state !== "running") throw new Error("任务已结束");
        job.stopRequested = true;
        job.child?.kill("SIGTERM");
        setTimeout(() => { if (job.stopRequested && job.child?.exitCode === null) job.child?.kill("SIGKILL"); }, 5000);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "停止失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/online-submit-plan") {
      // 递交清单预览：递交前把全部开单参数确定好，面板展示确认后才发起递交。
      try {
        const lineId = requestUrl.searchParams.get("lineId") ?? "";
        const applicantName = (requestUrl.searchParams.get("name") ?? "").trim().slice(0, 12);
        const employeeNo = (requestUrl.searchParams.get("employeeId") ?? "").trim().slice(0, 16);
        const group = (requestUrl.searchParams.get("group") ?? "").trim();
        // 前端面板当前投递值（全局记忆预填）：票据集未存过 delivery 时预览用它，保证「预览=实际递交」。
        const deliveryHint = {
          campus: (requestUrl.searchParams.get("campus") ?? "").trim(),
          approver: (requestUrl.searchParams.get("approver") ?? "").trim(),
        };
        const plan = await buildSubmitPlan(root, lineId, applicantName, employeeNo, group || undefined, deliveryHint);
        // 后台查重：不阻塞清单生成，面板轮询 /api/draft-check 取结果。
        void ensureDraftCheck(root, draftChecks, lineId, plan.summary, plan.expectedAmount);
        sendJson(response, 200, { plan });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法生成递交清单" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/online-submit") {
      try {
        const body = await readJsonBody(request) as { lineId?: string; plan?: Record<string, unknown> };
        const pick = (key: string) => (typeof body.plan?.[key] === "string" ? (body.plan![key] as string).trim() : "");
        // 姓名/工号来自前端回传的 plan（userProfiles）；空值由 e2e 侧默认值兜底。
        const planGroup = typeof body.plan?.group === "string" && body.plan.group ? body.plan.group : "";
        const plan = await buildSubmitPlan(root, String(body.lineId ?? ""), pick("travelerName"), pick("travelerSno"), planGroup || undefined);
        const campus = pick("campus") || plan.campus;
        const approver = pick("approver") || plan.approver;
        if (!campus || !approver) throw new Error("请先在投递设置中填写校区与协同审批人");

        // 自动撤旧重交：草稿查重命中同摘要旧单 → 开单前先撤，释放发票并保证全系统只有一张有效草稿。
        const check = draftChecks.get(String(body.lineId ?? ""));
        if (check?.state === "error") throw new Error(`草稿查重未完成：${check.error ?? "未知原因"}——请先人工核对财务系统草稿箱（撤销/处理旧草稿）再重新发起`);
        const revokeBillNo = check?.state === "matched" && check.match?.billNo ? check.match.billNo : "";
        // 发票/附件路径存在性校验：材料改名（规范命名重建）或移动后，旧面板里的 plan 快照会指向失效路径——
        // 直接报错要求重新生成计划，而不是 spawn 后 FileNotFoundError 中途炸掉（2026-09-27 出租车发票改名实证）
        const missing = [...plan.invoicePaths, ...plan.attachmentPaths].filter((p) => !fsSyncExists(path.join(root, p)));
        if (missing.length) {
          throw new Error(`材料文件已更新（改名/移动），递交清单中 ${missing.length} 个路径已失效——请关闭面板重新点「线上递交」生成新计划。示例：${missing[0].split("/").pop()}`);
        }
        const projectCode = pick("projectId") || plan.projectId;
        const config: Record<string, unknown> = {
          invoicePaths: plan.invoicePaths,
          attachmentPaths: plan.attachmentPaths,
          attachmentDesc: pick("attachmentDesc") || plan.attachmentDesc,
          summary: pick("summary") || plan.summary,
          payRemark: pick("payRemark") || plan.payRemark,
          campus,
          approver,
          projectId: projectCode,
          travelerName: plan.travelerName,
          travelerSno: plan.travelerSno,
          revokeBillNo,
          // 按摘要撤旧兜底：查重未就绪时开单流程第一步仍会撤掉同摘要旧草稿（防重复提交竞态）
          revokeSummary: plan.summary,
          // 预期金额总计（可选断言）：补贴由系统按行程推算、有波动，递交前锁定便于拦截异常单
          totalExpected: pick("totalExpected"),
          // 票面合计（撤旧兜底匹配：abort 存下的草稿摘要可能是系统默认值，按「今日+票面合计」也能撤）
          expensesTotal: plan.expensesTotal,
          // 手工标注字段包：系统 OCR 拒绝解析时 e2e 自动填「手工标注」表单（PDF 文本层/图片视觉模型）
          invoiceMeta: await buildInvoiceMeta(root, plan.invoicePaths),
          // 全自动递交：保存草稿后同会话校验（单号/金额/摘要/项目）并直接提交申请；默认开，前端可关回「草稿就绪人工确认」
          autoSubmit: pick("autoSubmit") !== "false",
        };
        if (!plan.invoicePaths.length) throw new Error("该票据集没有已归类的发票，无法线上开单");

        // 按票据集类型分派 e2e 引擎：日常集（含全量口径）走 daily 脚本（日常报销类型开单）；
        // 差旅/会议集走差旅 e2e；其余组尚未支持自动开单。
        const DAILY_GROUPS = new Set(["市内交通", "低值易耗设备", "办公用品", "其它（直接财务）"]);
        const jobId = `online-${Date.now()}`;
        const job: OnlineJob = { state: "running", mode: "full", lineId: String(body.lineId ?? ""), step: "", log: [], startedAt: Date.now(), group: planGroup, projectCode: projectCode || undefined };
        onlineSubmitJobs.set(jobId, job);
        let scriptName: string;
        if (plan.kind === "日常" || (planGroup && DAILY_GROUPS.has(planGroup))) {
          scriptName = "daily_bx_draft.py";
          config.expenseKind = "daily";
        } else if (!planGroup || planGroup === "国内差旅") {
          scriptName = "auto_bx_e2e_full.py";
        } else {
          throw new Error(`「${planGroup}」组的线上自动开单暂未支持，请先手动递交`);
        }
        serverTrace({ level: "info", scope: "online-submit", event: "start", detail: `发票 ${plan.invoiceCount} 份 · 附件 ${plan.attachmentCount} 份 · 票面合计 ${plan.expensesTotal.toFixed(2)} · 摘要「${config.summary}」${revokeBillNo ? ` · 先撤旧单 ${revokeBillNo}` : ""}`, task: `线上递交:${plan.title}` });
        startE2eJob(root, job, jobId, config, scriptName);
        sendJson(response, 200, { jobId });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法启动线上递交" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/online-submit-status") {
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      const job = onlineSubmitJobs.get(jobId);
      if (!job) { sendJson(response, 404, { error: "任务不存在" }); return; }
      sendJson(response, 200, { state: job.state, step: job.step, progress: job.progress ?? 0, error: job.error, billNo: job.billNo, log: job.log.slice(-500), startedAt: job.startedAt });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/online-submit-stop") {
      // 人工停止：kill e2e 子进程，job 转 stopped（close 事件统一收尾）。不清理财务系统现场——重交时按摘要自动撤旧兜底。
      try {
        const body = await readJsonBody(request) as { jobId?: string };
        const job = onlineSubmitJobs.get(String(body.jobId ?? ""));
        if (!job) throw new Error("任务不存在");
        if (job.state !== "running" && job.state !== "submitting" && job.state !== "withdrawing") throw new Error("任务已结束，无需停止");
        job.stopRequested = true;
        job.child?.kill("SIGTERM");
        setTimeout(() => { if (job.stopRequested && job.child?.exitCode === null) job.child?.kill("SIGKILL"); }, 5000);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "停止失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/online-submit-decide") {
      // 确认环节：草稿就绪（awaiting）后三选——确认递交（真提交）/ 撤回递交（删草稿+发票）/ 上财务系统查看（纯链接，前端处理）。
      try {
        const body = await readJsonBody(request) as { jobId?: string; action?: "confirm" | "withdraw" };
        const job = onlineSubmitJobs.get(String(body.jobId ?? ""));
        if (!job) throw new Error("任务不存在");
        if (job.state !== "awaiting") throw new Error("当前状态不可执行该操作");
        if (!job.billNo) throw new Error("缺少草稿单号");
        const config = body.action === "confirm"
          ? { submitOnly: true, submitBillNo: job.billNo, submitGroup: job.group ?? "" }
          : { cleanupOnly: true, revokeBillNo: job.billNo };
        job.mode = body.action === "confirm" ? "submit" : "cleanup";
        job.state = body.action === "confirm" ? "submitting" : "withdrawing";
        job.step = "";
        job.progress = 15;
        const decideId = `${body.jobId}-${job.mode}`;
        serverTrace({ level: "info", scope: "online-submit", event: job.state, detail: `草稿 ${job.billNo}`, task: "线上递交" });
        // 引擎分派（同开单）：日常集走 submit_draft.py 极简路径（登录→列表选行→修改→提交→验证），
        // 不带清池等额外动作；差旅集维持差旅引擎 A0 分支。
        let kind = "";
        try {
          const linesDoc = JSON.parse(await fs.readFile(path.join(root, "data", "receipt-lines.json"), "utf8")) as { lines?: Array<{ id?: string; kind?: string }> };
          kind = String((linesDoc.lines ?? []).find((l) => l.id === job.lineId)?.kind ?? "");
        } catch { /* kind 未知按差旅处理 */ }
        const scriptName = kind === "日常" ? "submit_draft.py" : "auto_bx_e2e_full.py";
        startE2eJob(root, job, decideId, config, scriptName);
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "操作失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/draft-check") {
      const lineId = requestUrl.searchParams.get("lineId") ?? "";
      const check = draftChecks.get(lineId);
      if (!check) { sendJson(response, 200, { state: "idle" }); return; }
      sendJson(response, 200, check);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/bill-open") {
      const billNo = (requestUrl.searchParams.get("billNo") ?? "").trim();
      if (!/^\d{7}$/.test(billNo)) { sendJson(response, 400, { error: "单号格式无效" }); return; }
      // 单实例复用：新点击先终止上一个 open_bill（其 finally 会关闭旧 Chrome 窗口），保证同屏只有一个财务系统窗口。
      if (openBillChild?.pid) {
        try { openBillChild.kill("SIGTERM"); } catch { /* 已退出 */ }
        openBillChild = null;
      }
      openBillChild = startSchoolScript(root, "tools/open_bill.py", ["--bill", billNo], true);
      openBillChild.on("exit", () => { openBillChild = null; });
      serverTrace({ level: "info", scope: "treasury", event: "bill.open", detail: billNo });
      sendJson(response, 202, { billNo });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/treasury-poll") {
      try {
        // 轮询含浏览器登录与页面查询，给足 5 分钟；完成后前端再拉 model-state 吸收结果。
        const pollStarted = Date.now();
        const { stdout } = await runSchoolScript(root, "treasury_research/poll_daily.py", ["--summary-json"], 300_000);
        const { changedBills } = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "") as { changedBills: number };
        if (!Number.isInteger(changedBills) || changedBills < 0) throw new Error("财务查询未返回有效的更新数量");
        serverTrace({ level: "info", scope: "treasury", event: "poll.done", detail: stdout.trim().split("\n").slice(-3).join(" | ").slice(0, 160), durationMs: Date.now() - pollStarted });
        sendJson(response, 200, { changedBills });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "财务轮询失败" });
      }
      return;
    }

    if (process.platform === "win32" && request.method === "POST" && requestUrl.pathname === "/api/print-confirm") {
      try {
        const body = await readJsonBody(request) as { paths?: unknown; printed?: unknown };
        if (!Array.isArray(body.paths) || typeof body.printed !== "boolean") {
          sendJson(response, 400, { error: "缺少打印确认信息" });
          return;
        }
        if (windowsPrinting) {
          sendJson(response, 409, { error: "请等待当前打印请求完成后再确认" });
          return;
        }
        windowsPrinting = true;
        try {
          const pendingWindowsPrints = await readWindowsPendingPrints(root);
          const hashes = new Set<string>();
          for (const item of body.paths) {
            const material = typeof item === "string" ? safeMaterialPath(root, item) : null;
            if (material && existsSync(material) && (await fs.stat(material)).isFile()) hashes.add(await fileContentHash(material));
          }
          const entries = await readPrintLog(root);
          for (const hash of hashes) {
            const pending = pendingWindowsPrints.get(hash);
            if (!pending) continue;
            if (body.printed) entries[hash] = pending.date;
            else if (pending.printer && pending.jobName) {
              const result = await windowsMaterials(["-Operation", "queue", "-Printer", pending.printer, "-JobName", pending.jobName])
                .catch(() => null);
              if (result && Number(result.stdout.trim()) > 0) {
                sendJson(response, 409, { error: "原打印队列仍有这份材料，请先取消旧任务" });
                return;
              }
            }
            pendingWindowsPrints.delete(hash);
          }
          if (body.printed) await writePrintLog(root, entries);
          await writeWindowsPendingPrints(root, pendingWindowsPrints);
          sendJson(response, 200, { entries, unconfirmedHashes: [...pendingWindowsPrints.keys()] });
        } finally { windowsPrinting = false; }
      } catch {
        sendJson(response, 500, { error: "无法保存打印确认" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/print") {
      try {
        const body = await readJsonBody(request) as { paths?: unknown };
        const requestPaths = Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string") : [];
        if (!requestPaths.length) throw new Error("未选择要打印的材料");
        const settings = await readPrintSettings(root);
        if (!settings.printer) throw new Error("尚未配置打印机，请先在打印设置中选择");
        const target = (await listSystemPrinters()).find((entry) => entry.name === settings.printer);
        if (!target) throw new Error("已配置的打印机不存在，请重新选择");
        if (target.state === "disabled" || !target.accepting) throw new Error(`打印机 ${target.name} 当前暂停或不接受任务，请检查打印机面板`);
        if (target.reachable === false) throw new Error(`打印机 ${target.name} 网络不可达，请确认与打印机在同一网络`);
        const submit = process.platform === "win32" ? submitWindowsPrintJobs : submitPrintJobs;
        sendJson(response, 200, await submit(root, settings.printer, requestPaths));
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "打印失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/download-selected") {
      try {
        const body = await readJsonBody(request) as { paths?: unknown };
        const requestPaths = Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
        if (!requestPaths.length) throw new Error("未选择要打包的材料");
        const { buffer, name } = await buildSelectionZip(root, requestPaths);
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": String(buffer.length),
          "Content-Disposition": `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(name)}`
        });
        response.end(buffer);
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "打包失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/ai-models") {
      try {
        const backend = requestUrl.searchParams.get("backend") ?? "api";
        if (backend === "codex") {
          try {
            sendJson(response, 200, { models: await readCodexModelCatalog(), source: "catalog" });
          } catch {
            sendJson(response, 200, { models: await readCodexModelCache(), source: "cache" });
          }
          return;
        }
        if (backend === "opencode") {
          try {
            sendJson(response, 200, { models: await readOpencodeModels(root), source: "catalog" });
          } catch {
            sendJson(response, 200, { models: await readCachedOpencodeModels(root), source: "cache" });
          }
          return;
        }
        if (backend !== "api") {
          sendJson(response, 400, { error: "无效的 AI 后端" });
          return;
        }
        const apiKey = await readSavedApiKey();
        if (!apiKey) {
          sendJson(response, 400, { error: "请先保存 API Key" });
          return;
        }
        const baseUrl = requestUrl.searchParams.get("baseUrl") ?? (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl;
        const provider = apiProviderForApiKey(apiKey, baseUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        const modelsResponse = await fetch(`${provider.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));
        if (!modelsResponse.ok) {
          sendJson(response, modelsResponse.status, { error: `无法读取该 ${provider.label} API Key 可用的模型` });
          return;
        }
        const payload = await modelsResponse.json() as { data?: Array<{ id?: string; owned_by?: string }> };
        const models = (payload.data ?? [])
          .filter((model) => typeof model.id === "string" && provider.modelPattern.test(model.id))
          .map((model) => ({ id: model.id!, ownedBy: model.owned_by ?? "" }));
        // 视觉模型不在列表端点返回中，但套餐内可直接调用；固定补齐以便下拉选择。
        if (provider.label === "智谱" && !models.some((model) => model.id === "glm-4.6v")) models.push({ id: "glm-4.6v", ownedBy: "z-ai" });
        models.sort((first, second) => first.id.localeCompare(second.id));
        sendJson(response, 200, { models });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法读取模型列表" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ai-api-key") {
      try {
        const body = await readJsonBody(request);
        const apiKey = typeof body === "object" && body !== null && "apiKey" in body && typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey) {
          sendJson(response, 400, { error: "请输入 API Key" });
          return;
        }
        await credentials.save(API_KEYCHAIN_SERVICE, apiKey);
        sendJson(response, 200, { saved: true });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存 API Key" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/user-profiles") {
      sendJson(response, 200, { profiles: await readUserProfiles(root) });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/user-profiles") {
      try {
        const body = await readJsonBody(request);
        const profiles = typeof body === "object" && body !== null && "profiles" in body ? body.profiles : null;
        await writeUserProfiles(root, profiles);
        sendJson(response, 200, { saved: true });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法保存用户资料" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/membership-document") {
      try {
        const profileId = safeProfileId(requestUrl.searchParams.get("profileId") ?? "");
        const filename = path.basename(requestUrl.searchParams.get("filename") ?? "会员凭证.pdf");
        if (!profileId || path.extname(filename).toLowerCase() !== ".pdf") { sendJson(response, 400, { error: "仅支持上传 PDF 格式的会员凭证" }); return; }
        const file = await readBody(request);
        if (!file.length || file.length > 10 * 1024 * 1024) { sendJson(response, 400, { error: "会员凭证 PDF 必须小于 10 MB" }); return; }
        const directory = path.join(root, ".guanzizai", "user-profiles", profileId, "memberships");
        await fs.mkdir(directory, { recursive: true });
        const target = await uniqueFilePath(directory, filename);
        await fs.writeFile(target, file);
        sendJson(response, 201, { membership: await membershipFromPdf(target, filename) });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法识别会员凭证" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/user-credential-status") {
      const profileId = safeProfileId(requestUrl.searchParams.get("profileId") ?? "");
      if (!profileId) { sendJson(response, 400, { error: "无效的用户" }); return; }
      const legacy = profileId === "profile-default";
      sendJson(response, 200, {
        schoolSsoConfigured: await credentials.has(profileKeychainService(SCHOOL_SSO_KEYCHAIN_SERVICE, profileId)) || (legacy && (await credentials.has(LEGACY_FINANCE_KEYCHAIN_SERVICE) || await credentials.has(LEGACY_FOREIGN_AFFAIRS_KEYCHAIN_SERVICE))),
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/browser-runtime") {
      sendJson(response, 200, await browserRuntimeStatus(root));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/browser-runtime") {
      try {
        const body = await readJsonBody(request);
        const requestedPath = typeof body === "object" && body !== null && "executablePath" in body && typeof body.executablePath === "string" ? body.executablePath.trim() : "";
        const executablePath = requestedPath ? await normalizeBrowserExecutable(requestedPath) : "";
        if (requestedPath && !executablePath) { sendJson(response, 400, { error: "未找到可执行的 Chrome 或 Chromium" }); return; }
        const validation = executablePath ? await validateBrowserExecutable(executablePath) : undefined;
        if (validation && !validation.available) { sendJson(response, 400, { error: validation.message }); return; }
        await writeBrowserRuntimeConfig(root, executablePath, validation?.browserName ?? "", validation?.browserVersion ?? "");
        sendJson(response, 200, { ...(await browserRuntimeStatus(root)), validation });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "无法保存浏览器路径" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/browser-runtime/scan") {
      sendJson(response, 200, { candidates: await scanBrowserExecutables(root) });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/browser-runtime/pick") {
      const executablePath = await normalizeBrowserExecutable(await chooseBrowserExecutable());
      sendJson(response, 200, executablePath ? { executablePath, validation: await validateBrowserExecutable(executablePath) } : { cancelled: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/browser-runtime/install") {
      void startManagedChromiumInstall(root);
      sendJson(response, 202, await browserRuntimeStatus(root));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/user-credentials") {
      try {
        const profileId = safeProfileId(requestUrl.searchParams.get("profileId") ?? "");
        if (!profileId) { sendJson(response, 400, { error: "无效的用户" }); return; }
        const body = await readJsonBody(request);
        const schoolSsoPassword = typeof body === "object" && body !== null && "schoolSsoPassword" in body && typeof body.schoolSsoPassword === "string" ? body.schoolSsoPassword : "";
        const schoolSsoAccount = typeof body === "object" && body !== null && "schoolSsoAccount" in body && typeof body.schoolSsoAccount === "string" ? body.schoolSsoAccount : "";
        if (schoolSsoPassword) {
          if (process.platform === "win32" && !schoolSsoAccount.trim()) { sendJson(response, 400, { error: "请先填写学校 SSO 账号" }); return; }
          const value = process.platform === "win32"
            ? JSON.stringify({ account: schoolSsoAccount.trim(), password: schoolSsoPassword })
            : schoolSsoPassword;
          await credentials.save(profileKeychainService(SCHOOL_SSO_KEYCHAIN_SERVICE, profileId), value);
        }
        sendJson(response, 200, { saved: true });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存系统凭证" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/verify-school-sso") {
      try {
        const profileId = safeProfileId(requestUrl.searchParams.get("profileId") ?? "");
        if (!profileId) { sendJson(response, 400, { error: "无效的用户" }); return; }
        const body = await readJsonBody(request);
        const profiles = await readUserProfiles(root) as Array<{ id?: string; profile?: { schoolSsoAccount?: string } }>;
        const savedAccount = profiles.find((profile) => profile.id === profileId)?.profile?.schoolSsoAccount ?? "";
        const account = typeof body === "object" && body !== null && "schoolSsoAccount" in body && typeof body.schoolSsoAccount === "string" ? body.schoolSsoAccount : savedAccount;
        const validation = await verifyEcnuSso(root, profileId, account);
        if (validation.state === "success" && validation.identity) {
          const updatedProfiles = (await readUserProfiles(root)).map((profile) => {
            if (!profile || typeof profile !== "object" || (profile as { id?: unknown }).id !== profileId) return profile;
            const record = profile as { profile?: Record<string, unknown> };
            return { ...record, profile: { ...record.profile, employeeId: validation.identity!.employeeId, organization: validation.identity!.organization, schoolSsoVerifiedAt: new Date().toISOString() } };
          });
          await writeUserProfiles(root, updatedProfiles);
        }
        sendJson(response, 200, { validation });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法验证学校 SSO" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/user-signature") {
      const profileId = safeProfileId(requestUrl.searchParams.get("profileId") ?? "");
      if (!profileId) { sendJson(response, 400, { error: "无效的用户" }); return; }
      const signaturePath = profileSignaturePath(root, profileId);
      if (!existsSync(signaturePath)) { sendJson(response, 404, { error: "尚未保存签名" }); return; }
      await serveMaterial(request, response, signaturePath);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/user-signature") {
      try {
        const profileId = safeProfileId(requestUrl.searchParams.get("profileId") ?? "");
        if (!profileId) { sendJson(response, 400, { error: "无效的用户" }); return; }
        const signaturePath = profileSignaturePath(root, profileId);
        if (request.headers["content-type"] !== "image/png") { sendJson(response, 400, { error: "签名仅支持 PNG 图片" }); return; }
        const body = await readBody(request);
        if (!body.length || body.length > 5 * 1024 * 1024) { sendJson(response, 400, { error: "签名 PNG 必须小于 5 MB" }); return; }
        await fs.mkdir(path.dirname(signaturePath), { recursive: true });
        await fs.writeFile(signaturePath, body);
        sendJson(response, 201, { saved: true });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存签名" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/import") {
      try {
        const rawName = requestUrl.searchParams.get("filename") ?? "未命名材料";
        const filename = path.basename(rawName);
        const ext = path.extname(filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          sendJson(response, 400, { error: "不支持该文件格式" });
          return;
        }

        const requestedFolder = requestUrl.searchParams.get("folder");
        const normalizedFolder = requestedFolder
          ? toPosix(path.normalize(requestedFolder))
          : "";
        const isAllowedFolder = normalizedFolder.startsWith("01_报销材料/") && !normalizedFolder.includes("../");
        const targetDirectory = isAllowedFolder
          ? path.join(root, normalizedFolder)
          : path.join(root, "01_报销材料", "00_收件箱");
        await fs.mkdir(targetDirectory, { recursive: true });
        const incomingBody = await readBody(request);
        // 内容去重：同一票据集内已有相同 SHA-256 的文件则不再收录——重复上传曾借 uniqueFilePath
        // 的 -2 后缀混进系统（evidence 层同 hash 合一不影响 UI 文件行）。
        const incomingHash = createHash("sha256").update(incomingBody).digest("hex");
        for (const existing of await fs.readdir(targetDirectory)) {
          const existingPath = path.join(targetDirectory, existing);
          const stat = await fs.stat(existingPath).catch(() => null);
          if (!stat?.isFile()) continue;
          if (await fileContentHash(existingPath) === incomingHash) {
            sendJson(response, 200, { duplicate: true, path: toPosix(path.relative(root, existingPath)) });
            return;
          }
        }
        let targetPath = await uniqueFilePath(targetDirectory, filename);
        await fs.writeFile(targetPath, incomingBody);
        targetPath = await normalizedImportPath(targetPath);
        sendJson(response, 201, {
          path: toPosix(path.relative(root, targetPath)),
        });
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "材料导入失败",
        });
      }
      return;
    }

    type AutoClassificationRequest = {
      background?: boolean;
      lineId?: string;
      folder?: string;
      paths?: string[];
      requirements?: Array<{ id?: string; label?: string; hint?: string }>;
      contextMaterials?: Array<{
        path?: string; name?: string; requirementId?: string;
        documentDate?: string; paymentDate?: string; paymentDateBlocked?: boolean; amount?: number; currency?: string;
      }>;
      preferredRequirementId?: string;
      backend?: string;
      model?: string;
      homeCity?: string;
    };
    const runAutoClassify = async (body: AutoClassificationRequest) => {
        const folder = safeLineFolder(body.folder ?? "");
        const requirements = (body.requirements ?? [])
          .filter((item): item is { id: string; label: string; hint: string } => Boolean(item.id && item.label && item.hint));
        const requirementIds = new Set(requirements.map((item) => item.id));
        const preferredRequirementId = body.preferredRequirementId && requirementIds.has(body.preferredRequirementId) ? body.preferredRequirementId : "";
        const contextMaterials = (body.contextMaterials ?? [])
          .filter((item): item is { path: string; name: string; requirementId: string; documentDate?: string; paymentDate?: string; paymentDateBlocked?: boolean; amount?: number; currency?: string } => Boolean(item.path && item.name && item.requirementId && requirementIds.has(item.requirementId)))
          .slice(0, 80);
        const requestedPaths = Array.from(new Set(body.paths ?? [])).slice(0, 20);
        if (!folder || !requirements.length || !requestedPaths.length) {
          serverTrace({ level: "warn", scope: "classify", event: "missing-input" });
          throw new Error("缺少票据集、材料项或上传文件");
        }

        const files = await Promise.all(requestedPaths.map(async (requestedPath) => {
          const absolutePath = safeMaterialPath(root, requestedPath);
          if (!absolutePath || !toPosix(path.relative(root, absolutePath)).startsWith(`${folder}/`) || !existsSync(absolutePath)) return null;
          const text = await materialTextForClassification(absolutePath);
          const image = await classificationImagePath(absolutePath, text);
          return { path: toPosix(path.relative(root, absolutePath)), absolutePath, name: path.basename(absolutePath), text, imagePath: image.path, temporaryImage: image.temporary };
        }));
        const inputs = files.filter((item): item is NonNullable<typeof item> => item !== null);
        if (!inputs.length) {
          serverTrace({ level: "warn", scope: "classify", event: "no-materials" });
          throw new Error("没有可分类的本地文件");
        }

        try {
          // 强规则前置：版式固定的票据（铁路电子客票等）本地归类即可达到 100% 精度，不占用 AI 配额、不受 AI 抖动影响。
          const labels = new Map(requirements.map((item) => [item.id, item.label]));
          const settings = await readAiSettings(root) ?? normalizeAiSettings({});
          const localAssignments: ClassificationAssignment[] = [];
          const namingPlans = new Map<string, {
            absolutePath: string; label: string; info: ClassificationNaming;
            retainOriginalName?: boolean;
          }>();
          const finish = async (assignments: ClassificationAssignment[]) => {
            const assignmentPaths = new Set(assignments.map((assignment) => assignment.path));
            const candidates = [...contextMaterials.filter((item) => !assignmentPaths.has(item.path)), ...assignments];
            const renamed: Array<{ source: string; target: string }> = [];
            const previousPaths = new Map<ClassificationAssignment, string>();
            try {
              for (const assignment of assignments) {
                previousPaths.set(assignment, assignment.path);
                const plan = namingPlans.get(assignment.path);
                if (!plan) continue;
                const paymentDate = cloudPaymentDateForImport(assignment, candidates);
                const original = path.parse(plan.absolutePath);
                const filename = plan.retainOriginalName && paymentDate
                  ? [...original.name.split("_").filter((part) => !/^(?:[1-9]|1[0-2])月付款$/.test(part)), `${Number(paymentDate.slice(5, 7))}月付款`].join("_") + original.ext
                  : automaticClassificationName(plan.label, { ...plan.info, paymentDate });
                if (original.base === filename) continue;
                const target = await uniqueFilePath(original.dir, filename);
                await fs.rename(plan.absolutePath, target);
                renamed.push({ source: plan.absolutePath, target });
                assignment.path = toPosix(path.relative(root, target));
              }
              const datedOrFlightAssignments = assignments.filter((assignment) => cloudPaymentNodeKind(assignment.requirementId) || assignment.flightSegments?.length || assignment.rebookingFeeAmount !== undefined);
              if (datedOrFlightAssignments.length) {
                await withReceiptMetaWrite(async () => {
                  const metaPath = path.join(root, "data", "receipt-meta.json");
                  await fs.mkdir(path.dirname(metaPath), { recursive: true });
                  const raw = await fs.readFile(metaPath, "utf8").catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return "{}";
                    throw error;
                  });
                  const metaDoc = JSON.parse(raw) as { metadata?: Record<string, ReceiptMeta> };
                  const metadata = metaDoc.metadata ?? {};
                  for (const assignment of datedOrFlightAssignments) {
                    const previousPath = previousPaths.get(assignment) ?? assignment.path;
                    metadata[assignment.path] = classifiedReceiptMetadata(metadata[previousPath], assignment);
                    if (previousPath !== assignment.path) delete metadata[previousPath];
                  }
                  await atomicWriteJson(metaPath, { ...metaDoc, metadata });
                });
              }
            } catch (error) {
              for (const { source, target } of renamed.reverse()) await fs.rename(target, source);
              throw error;
            }
            for (const { source, target } of renamed) {
              serverTrace({ level: "debug", scope: "classify", event: "rename", detail: `${path.basename(source)} → ${path.basename(target)}` });
            }
            return assignments;
          };
          const aiInputs: typeof inputs = [];
          for (const item of inputs) {
            const railway = parseRailwayInvoice(item.text);
            const forcedId = forcedClassificationRequirement(item.text, requirementIds);
            if (railway && requirementIds.has("transport-invoice")) {
              // 铁路客票发票一张顶两张：既是交通发票也是乘車凭证，方向写入文件名供交通凭证行匹配。
              // 固定版式信息完整（日期/金额/站名/车次），直接构造规范名，不保留旧文件名 fallback（防语义改名叠罗汉）。
              const homeCity = typeof body.homeCity === "string" && body.homeCity.trim() ? body.homeCity.trim().slice(0, 12) : "上海";
              const direction = railwayTravelDirection(railway.from, railway.to, homeCity);
              const directionLabel = direction === "outbound" ? "去程" : direction === "return" ? "返程" : "";
              const amountPart = Number.isFinite(railway.amount) ? `CNY${railway.amount}` : "";
              const filename = `${railway.date ? `${railway.date}_` : ""}${["中国铁路", directionLabel, `${railway.from}-${railway.to}`, "铁路电子客票发票", amountPart].filter(Boolean).join("_")}${path.extname(item.absolutePath)}`;
              let target = item.absolutePath;
              if (path.basename(item.absolutePath) !== filename) { target = await uniqueFilePath(path.dirname(item.absolutePath), filename); await fs.rename(item.absolutePath, target); }
              localAssignments.push({ path: toPosix(path.relative(root, target)), requirementId: "transport-invoice", reason: `铁路电子客票${directionLabel}（${railway.from}→${railway.to}）本地识别`, documentDate: railway.date || undefined, issuer: "中国铁路", amount: Number.isFinite(railway.amount) ? String(railway.amount) : undefined, currency: "CNY" });
              continue;
            }
            if (forcedId) {
              const billNo = elabBillNoFromText(item.text);
              const total = elabTotalFromText(item.text) || invoiceTotalFromText(item.text);
              const invoiceDateParts = item.text.normalize("NFKC").match(/开票日期\s*:?\s*(\d{4})\s*[年-]\s*(\d{1,2})\s*[月-]\s*(\d{1,2})/);
              const documentDate = invoiceDateParts
                ? `${invoiceDateParts[1]}-${invoiceDateParts[2].padStart(2, "0")}-${invoiceDateParts[3].padStart(2, "0")}`
                : item.text.match(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}/)?.[1];
              const classificationLabel = DAILY_REQUIREMENTS.find((requirement) => requirement.id === forcedId)?.label ?? labels.get(forcedId) ?? forcedId;
              const payment = cloudPaymentNodeKind(forcedId) ? readCloudPaymentDate(item.text) : undefined;
              const paymentDate = payment?.date;
              namingPlans.set(item.path, { absolutePath: item.absolutePath, label: classificationLabel, info: { ext: path.extname(item.absolutePath), documentDate, issuer: billNo ? "elab" : undefined, goodsName: billNo || undefined, amount: total || undefined, currency: total ? "CNY" : undefined } });
              const flightSegments = forcedId === "transport-invoice" ? flightSegmentsFromText(item.text) : undefined;
              const rebookingFeeAmount = forcedId === "transport-invoice" ? invoiceRebookingFeeFromText(item.text) : undefined;
              localAssignments.push({ path: item.path, requirementId: forcedId, reason: "已按票据强证据自动归类", documentDate, paymentDate, paymentDateBlocked: payment?.blocked, flightSegments, rebookingFeeAmount, amount: total || undefined, currency: total ? "CNY" : undefined });
              // 报账单单号登记（不丢失）：elab 单提取 HC/CSF 单号 → line.elabBills（approved 视审核意见文本）
              if (billNo) {
                const lineId = String(body.lineId ?? "");
                const linesFile = path.join(root, "data", "receipt-lines.json");
                try {
                  const doc = JSON.parse(await fs.readFile(linesFile, "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
                  const line = (doc.lines ?? []).find((entry) => entry.id === lineId);
                  if (line) {
                    const bills = Array.isArray(line.elabBills) ? (line.elabBills as Array<Record<string, unknown>>) : [];
                    if (!bills.some((bill) => bill.billNo === billNo)) {
                      bills.push({
                        id: `elab-${Date.now()}-${billNo}`, system: billNo.startsWith("HC") ? "zcgl" : "wxzc", billNo,
                        status: elabApprovedFromText(item.text) ? "approved" : "submitted",
                        expenseIds: [], amountCny: total ? Number(total) : undefined, registeredVia: "upload",
                        createdAt: new Date().toISOString(),
                      });
                      line.elabBills = bills;
                      await atomicWriteJson(linesFile, doc);
                      serverTrace({ level: "info", scope: "classify", event: "elab-bill-registered", detail: `${lineId} <- ${billNo}（上传报账单识别登记）`, task: "自动归类" });
                    }
                  }
                } catch { /* 登记失败不阻塞归类 */ }
              }
              continue;
            }
            aiInputs.push(item);
          }
          if (!aiInputs.length) return await finish(localAssignments);
          if (body.backend === "off") {
            const kind = cloudPaymentNodeKind(preferredRequirementId);
            const selectedAssignments = preferredRequirementId ? aiInputs.map((item) => {
              const payment = kind ? readCloudPaymentDate(item.text, kind === "payment") : undefined;
              if (payment?.date) {
                namingPlans.set(item.path, { absolutePath: item.absolutePath, label: labels.get(preferredRequirementId)!, retainOriginalName: true, info: { ext: path.extname(item.absolutePath) } });
              }
              return { path: item.path, requirementId: preferredRequirementId, paymentDate: payment?.date, paymentDateBlocked: payment?.blocked, documentDate: kind === "payment" ? payment?.date : undefined };
            }) : [];
            return await finish([...localAssignments, ...selectedAssignments]);
          }
          if (body.backend !== "api" && body.backend !== "codex" && body.backend !== "opencode") throw new Error("剩余材料需要 AI 识别，请先配置可用的 AI 后端");

          const images = aiInputs.filter((item) => item.imagePath);
          let apiProvider: ReturnType<typeof apiProviderForApiKey> | null = null;
          let savedApiKey = "";
          if (body.backend === "api") {
            savedApiKey = await readSavedApiKey();
            if (!savedApiKey) throw new Error("请先在 AI 后端设置中保存 API Key");
            apiProvider = apiProviderForApiKey(savedApiKey, (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl);
          }
          const prompt = `你是高校报销票据自动归类器。请根据每份材料的文件名、提取文本和图片附件，将每份材料直接归入最合适的一个材料项。不要要求人工确认；即使信息不完整，也必须选择最接近的一项。

【凭证类型判定，优先级最高】
- 发票：文本或图片含“电子发票/数电发票/增值税发票”字样，且有“发票号码+开票日期”结构（常含税率、税额、价税合计）。旅行社代订机票、退改费开具的电子发票也是发票，不是支付截图。发票必须归入发票类材料项（如 交通发票、住宿发票、机票发票、注册费发票、日常网购商品电子发票），绝不归入支付凭证。
- 支付凭证/支付记录：银行、微信、支付宝、信用卡的交易截图或账单详情，特征是交易单号、支付方式、订单金额与实付金额并存、无税率税额。仅此类材料才归入支付凭证/支付记录。
- 收据 Receipt：境外收据（Receipt、Amount Paid）。
- 费用清单：套餐价格、收费标准、产品页面截图。

【日期字段与云服务】
- documentDate 是本文件的日期：发票用开票日期，收据用开具日期，支付记录用交易日期。不要用账单所属期、扣款提醒日、账单生成日期或票据集名称推断付款日。
- paymentDate 是本文件明确显示的实际扣款日期，格式为 YYYY-MM-DD。云服务和 AI 订阅的支付记录读取付款时间、扣款时间、成功交易时间；收据读取 Date paid、Payment date 等字段；发票仅在明确写出实际付款日时填写。若日期缺失或冲突，返回空字符串；费用清单的 paymentDate 始终为空。不要把开票日期抄成付款日期，也不要跨文件猜日期。
- 智谱 BigModel 的固定数电版式使用 zhipu-invoice（智谱 BigModel 发票）。实际支付明细使用 zhipu-payment。

【其他归类规则】
台灯、打印复印纸、文件夹、订书机、计算器、纸巾水杯等桌面办公用品（装备处《材料易耗品低值品-办公用品分类》的辅助/桌面/书写用品）不属于低值设备，须归办公用品发票（office-supplies-invoice / office-supplies-proof），绝不归入低值设备发票或购买截图。elab 系统打印的「材料、易耗品、低值品报账单」「软件服务费报账单」（含报账单编号 HC/CSF、报账人、经费号、审核意见）是前置报账单而非发票：编号 HC 开头归 low-value-gear-elab（elab 资产入账单），CSF 开头归 cloud-services-csf（软件服务费报账单），goodsName 填报账单编号。登机牌/登机凭证/boarding pass 不是发票也不是支付凭证，须按航班方向归入去程或返程交通凭证（结合航线城市与日期判断）；若同一张凭证同时包含去程与返程（往返订单、往返行程单、携程往返凭证等），归入去程交通凭证并在 reason 中写明"往返合一"。支付凭证永远归入支付凭证节点（如交通支付凭证），绝不归入去程/返程交通凭证。纯通知/日程类材料（会议通知、第四轮通知、邀请函）归入 conference-notice（会议通知/日程）；含注册费价格表或缴费方式说明的页面（如官网「会议注册、费用及缴费方式」）归入 registration-fee（注册费标准）——按页面主要性质区分，两者都是国内会议报销必需材料；铁路电子客票和航空运输电子行程单优先归入“交通发票”。支付类截图若未写明用途，须优先按金额、币种、日期和商户与“已有材料”中的收据、发票或费用清单配对（金额一致或接近即视为配对）：注册费材料对应会议注册支付凭证，会员费材料对应会员费支付凭证，机票/车票及旅行社的交通票据对应交通支付凭证，酒店商户对应住宿支付凭证，云服务/AI 订阅商户（如智谱、六六云、OpenAI）对应相应云服务的支付记录。仅当支付截图与任何已有材料都无法配对、且明确来自电商购物订单时，才可归入日常网购商品。同一笔交易的多张购买截图（同商户、同金额）必须归入同一个材料项，不得一张归低值设备截图、另一张归办公用品截图。文件名中的旧标签可能反映历史错误归类，以文本与图片内容为准，不得仅凭文件名词语归入支付凭证。仅返回 JSON 数组，禁止 Markdown 或额外文字。数组元素格式：{"path":"原路径","requirementId":"候选 ID","reason":"不超过30字的判断依据","note":"不超过12字的补充说明（如会议简称、往返合一、改签费等上下文，用于文件名备注；无则空字符串）","documentDate":"YYYY-MM-DD或空字符串","paymentDate":"YYYY-MM-DD或空字符串","issuer":"商户简称或空字符串","amount":"不带货币符号的金额或空字符串","currency":"CNY/USD/SGD/EUR/THB 或空字符串","goodsName":"商品品名：发票/购买截图/账单明细中的具体商品名（不超过8个字，如 扩展坞、移动硬盘、收纳盒；无法识别则空字符串）"}。电子发票的红色监制章若为「上海税务局」，note 填「上海监制」；监制章为其他省市的，note 填对应省市监制（如「浙江监制」）——该信息决定购买截图是否可免。

航空客票、登机凭证、行程单和机票订单如明确列出实际航段，在对应 JSON 对象中加上 flightSegments 数组。每个航段包含 from（出发城市）、to（到达城市）、travelDate（出行日 YYYY-MM-DD）、flightNumber（航班号）。往返按实际方向分别提取。仅填写材料明确显示的信息，开票日、订单日和记账日不能替代出行日。其他材料省略此字段。交通发票如果逐项列出改签费或退改费，可在 rebookingFeeAmount 填写这些项目的含税合计金额（数值，与发票相同币种）。未单列或无法确认含税金额时省略该字段。

候选材料项：
${requirements.map((item) => `- ${item.id} | ${item.label} | ${item.hint}`).join("\n")}${contextMaterials.length ? `

已有材料（可用于支付凭证配对）：
${contextMaterials.map((item) => `- ${item.requirementId} | ${item.name}`).join("\n")}` : ""}

待归类文件（文件名已脱敏为中性编号，历史命名不代表内容，只依据文本与图片内容判断）：
${aiInputs.map((item, index) => `文件：材料-${index + 1}${item.imagePath ? `\n图片附件：${images.findIndex((image) => image.path === item.path) + 1}` : ""}\n文本：${item.text || (item.imagePath ? "（请读取对应图片附件）" : "（无可提取文本，仅按文件名判断）")}`).join("\n\n---\n\n")}`;
          let raw = "";
          const classifyStarted = Date.now();
          if (body.backend === "api") {
            const imageContent = await Promise.all(images.map(async (item) => chatImageFromFile(item.imagePath)));
            // 分类是幂等封闭题；空响应/超时自动重试一次，规避智谱端点偶发抖动。
            const classifyOnce = () => callChatModel(apiProvider!, savedApiKey, { model: body.model || apiProvider!.defaultModel, prompt, images: imageContent, temperature: 0, maxTokens: 8_192, disableThinking: true });
            raw = await classifyOnce().catch(() => classifyOnce());
          } else if (body.backend === "opencode") {
            raw = await runOpencodeCli([...(body.model ? ["-m", body.model] : []), ...images.flatMap((item) => ["-f", item.imagePath]), "--", prompt], 180_000);
          } else {
            raw = await runCodexCli([
              "exec", "--skip-git-repo-check", ...(body.model ? ["-m", body.model] : []),
              "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false",
              ...images.flatMap((item) => ["-i", item.imagePath]), "--", "-",
            ], 120_000, prompt);
          }
          const classified = parseClassificationJson(raw);
          serverTrace({ level: "info", scope: "ai", event: "classify.done", detail: `${body.model || "(默认模型)"} → ${classified.length}/${inputs.length} 份`, durationMs: Date.now() - classifyStarted });
          const sources = new Map(aiInputs.map((item) => [item.path, item]));
          const assignments: ClassificationAssignment[] = [...localAssignments];
          for (const item of classified) {
            const source = item.path ? (sources.get(item.path) ?? sources.get(String(item.path).replace(/^材料-\d+$/, (m) => {
                const idx = parseInt(m.replace('材料-', ''), 10) - 1;
                return aiInputs[idx]?.path ?? '';
            }))) : undefined;
            const forcedRequirementId = source ? forcedClassificationRequirement(source.text, requirementIds) : "";
            const selectedRequirementId = forcedRequirementId || preferredRequirementId || item.requirementId;
            const label = selectedRequirementId ? labels.get(selectedRequirementId) : undefined;
            if (!source || !selectedRequirementId || !requirementIds.has(selectedRequirementId) || !label) continue;
            const reason = forcedRequirementId ? "已按票据强证据自动归类" : (item.reason ?? "AI 自动归类").slice(0, 120);
            // 往返合一凭证命名为"往返交通凭证"：文件名关键词同时满足去程与返程两个材料项。
            const classificationLabel = reason.includes("往返") && /^transport-proof/.test(selectedRequirementId) ? "往返交通凭证" : label;
            const cloudNode = cloudPaymentNodeKind(selectedRequirementId);
            const payment = cloudNode ? readCloudPaymentDate(source.text, cloudNode === "payment", item.paymentDate) : undefined;
            const paymentDate = payment?.date;
            const documentDate = validPaymentDate(item.documentDate) ?? (cloudNode === "payment" ? paymentDate : undefined);
            // 发票金额本地兜底：模型漏报金额时仍可建费用行。
            const rawAmount = typeof item.amount === "string" ? item.amount.trim() : "";
            const fallbackAmount = !rawAmount && /invoice|-发票|^发票/.test(selectedRequirementId) ? invoiceTotalFromText(source.text) : "";
            const amount = rawAmount || fallbackAmount;
            const currency = item.currency || (fallbackAmount ? "CNY" : undefined);
            namingPlans.set(source.path, {
              absolutePath: source.absolutePath, label: classificationLabel,
              info: { ext: path.extname(source.absolutePath), documentDate, issuer: item.issuer, amount, currency,
                note: typeof item.note === "string" ? item.note : undefined,
                goodsName: (typeof item.goodsName === "string" && item.goodsName) || goodsNameFromText(source.text) || undefined },
            });
            const flightSegments = ["outbound-transport", "return-transport", "transport-invoice", "airfare-invoice", "transport-payment", "airfare-payment"].includes(selectedRequirementId)
              ? flightSegmentsFromText(source.text) ?? normalizeFlightSegments(item.flightSegments) : undefined;
            const rebookingFeeAmount = ["transport-invoice", "airfare-invoice"].includes(selectedRequirementId)
              ? invoiceRebookingFeeFromText(source.text) ?? (typeof item.rebookingFeeAmount === "number" && Number.isFinite(item.rebookingFeeAmount) && item.rebookingFeeAmount > 0
                ? item.rebookingFeeAmount : undefined)
              : undefined;
            assignments.push({ path: source.path, requirementId: selectedRequirementId, reason, documentDate, paymentDate, paymentDateBlocked: payment?.blocked, flightSegments, rebookingFeeAmount, issuer: item.issuer, amount, currency });
          }
          // 模型必须覆盖每个进入 AI 的文件；未能解析的条目直接视为调用失败，避免静默漏掉状态刷新。
          if (assignments.length !== inputs.length) {
            serverTrace({ level: "warn", scope: "classify", event: "incomplete-result" });
            throw new Error("AI 未能完整归类全部文件，请重新测试当前后端");
          }
          return await finish(assignments);
        } finally {
          await Promise.all(inputs.filter((item) => item.temporaryImage).map((item) => fs.unlink(item.imagePath).catch(() => undefined)));
        }
    };

    if (request.method === "POST" && requestUrl.pathname === "/api/auto-classify") {
      try {
        const body = await readJsonBody(request) as AutoClassificationRequest;
        if (body.background) {
          const jobId = `classification-${Date.now()}`;
          classificationJobs.set(jobId, { state: "running" });
          const started = Date.now();
          void runAutoClassify(body).then((assignments) => {
            classificationJobs.set(jobId, { state: "completed", assignments });
            serverTrace({ level: "info", scope: "classify", event: "completed", durationMs: Date.now() - started });
          }).catch((error) => {
            classificationJobs.set(jobId, { state: "failed", error: error instanceof Error ? error.message : "AI 自动分类失败" });
            serverTrace({ level: "error", scope: "classify", event: "failed", durationMs: Date.now() - started });
          });
          sendJson(response, 202, { jobId });
          return;
        }
        const assignments = await runAutoClassify(body);
        sendJson(response, 200, { assignments });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "AI 自动分类失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/auto-classify-status") {
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      const job = classificationJobs.get(jobId);
      if (!job) { sendJson(response, 404, { error: "识别任务不存在或已失效" }); return; }
      if (job.state !== "running") classificationJobs.delete(jobId);
      sendJson(response, 200, job);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/normalize-line") {
      try {
        const folder = safeLineFolder(requestUrl.searchParams.get("folder") ?? "");
        if (!folder) { sendJson(response, 400, { error: "无效的票据集" }); return; }
        const changes: Array<{ from: string; to: string }> = [];
        for (const material of await scanDirectory(root, folder)) {
          if (material.ext !== ".pdf") continue;
          const from = path.join(root, material.path);
          const to = await normalizedImportPath(from);
          if (to !== from) changes.push({ from: material.path, to: toPosix(path.relative(root, to)) });
        }
        sendJson(response, 200, { changes });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "材料规范命名失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/template") {
      try {
        const folder = safeLineFolder(requestUrl.searchParams.get("folder") ?? "");
        const requestedTemplate = requestUrl.searchParams.get("template");
        if (!folder || !requestedTemplate || !(requestedTemplate in TEMPLATE_SOURCES)) {
          sendJson(response, 400, { error: "无效的票据集或模板" });
          return;
        }
        const templateId = requestedTemplate as keyof typeof TEMPLATE_SOURCES;
        const target = await openTemplateCopy(folder, templateId);
        sendJson(response, 200, { opened: true, name: path.basename(target) });
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "无法打开模板副本",
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ai-traffic-note") {
      try {
        const body = await readJsonBody(request) as { backend?: string; model?: string; context?: string; folder?: string; trafficDate?: string; profileId?: string; useSignature?: boolean; background?: boolean };
        if (body.background) {
          const jobId = `traffic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          trafficNoteJobs.set(jobId, { state: "running" });
          void generateTrafficNote(body).then(() => trafficNoteJobs.set(jobId, { state: "completed" })).catch((error) => trafficNoteJobs.set(jobId, { state: "failed", error: error instanceof Error ? error.message : "AI 编写失败" }));
          sendJson(response, 202, { jobId });
          return;
        }
        const draft = await generateTrafficNote(body);
        sendJson(response, 200, { draft, saved: Boolean(body.folder) });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "AI 编写失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ai-rebooking-note") {
      try {
        const body = await readJsonBody(request) as { backend?: string; model?: string; context?: string; folder?: string; noteDate?: string; profileId?: string; useSignature?: boolean; background?: boolean };
        if (body.background) {
          const jobId = `rebooking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          trafficNoteJobs.set(jobId, { state: "running" });
          void generateRebookingNote(body).then(() => trafficNoteJobs.set(jobId, { state: "completed" })).catch((error) => trafficNoteJobs.set(jobId, { state: "failed", error: error instanceof Error ? error.message : "AI 编写失败" }));
          sendJson(response, 202, { jobId });
          return;
        }
        const draft = await generateRebookingNote(body);
        sendJson(response, 200, { draft, saved: Boolean(body.folder) });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "AI 编写失败" });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/ai-traffic-note-status") {
      const job = trafficNoteJobs.get(requestUrl.searchParams.get("jobId") ?? "");
      if (!job) { sendJson(response, 404, { error: "生成任务不存在或已失效" }); return; }
      sendJson(response, 200, job);
      return;
    }


/** 压缩图片到指定最长边（sips），返回临时文件路径；失败时回退原件。 */
async function shrinkImageFile(absolutePath: string, maxPixels: number) {
  const digest = createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
  const out = path.join(tmpdir(), `guanzizai-vision-${digest}-${maxPixels}.jpg`);
  try {
    await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "60", "-Z", String(maxPixels), absolutePath, "--out", out], { timeout: 10_000 });
    return existsSync(out) ? out : absolutePath;
  } catch {
    return absolutePath;
  }
}

/** 三级后端测试（连通/视觉/业务用例）。onEvent 推送阶段与逐用例进度，返回汇总。 */
async function runBackendTestStages(
  request: IncomingMessage,
  body: { backend?: string; model?: string; baseUrl?: string },
  root: string,
  onEvent: (event: { type: "stage" | "case" | "done"; payload: unknown }) => void,
) {
  const startedAt = Date.now();
  if (!body.backend) throw new Error("请先选择 AI 后端和模型");
  const model = body.model?.trim() || "后端默认模型";
  const stages: Record<string, unknown> = {};

  // ① 连通性
  const callProbe = async () => {
    if (body.backend === "api") {
      const apiKey = await readSavedApiKey();
      if (!apiKey) throw new Error("请先保存 API Key");
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl;
      const provider = apiProviderForApiKey(apiKey, baseUrl);
      return { provider, apiKey };
    }
    return { provider: null, apiKey: "" };
  };

  // 内部执行器：api 走 callChatModel；codex/opencode 直接 CLI
  const execute = async (options: { prompt: string; images?: Array<{ path: string }>; maxTokens?: number }) => {
    if (body.backend === "api") {
      const apiKey = await readSavedApiKey();
      if (!apiKey) throw new Error("请先保存 API Key");
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl;
      const provider = apiProviderForApiKey(apiKey, baseUrl);
      const imageContent = await Promise.all((options.images ?? []).map((item) => chatImageFromFile(item.path)));
      return callChatModel(provider, apiKey, { model: body.model || provider.defaultModel, prompt: options.prompt, images: imageContent, maxTokens: options.maxTokens ?? 64, disableThinking: true });
    }
    const imageFlags = (options.images ?? []).flatMap((item) => body.backend === "codex" ? ["-i", item.path] : ["-f", item.path]);
    if (body.backend === "codex") {
      return runCodexCli(["exec", "--skip-git-repo-check", ...(body.model ? ["-m", body.model] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", ...imageFlags, "--", "-"], 120_000, options.prompt);
    }
    return runOpencodeCli([...(body.model ? ["-m", body.model] : []), ...imageFlags, "--", options.prompt], 120_000);
  };

  try {
    await callProbe();
    const connectivityDetail = `连通 · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    stages.connectivity = { pass: true, detail: connectivityDetail };
    onEvent({ type: "stage", payload: { key: "connectivity", pass: true, detail: connectivityDetail } });
  } catch (probeError) {
    onEvent({ type: "stage", payload: { key: "connectivity", pass: false, detail: probeError instanceof Error ? probeError.message : "连通失败" } });
    throw probeError;
  }

  // ② 视觉能力
  onEvent({ type: "stage", payload: { key: "vision", pass: null as unknown as boolean, detail: "检测视觉能力…" } });
  const visionSample = await createVisionSample();
  const visionCaseFile = visionSample.file;
  let vision = { pass: false, detail: "（无样本文件，跳过）" as string };
  let visionTempFile = "";
  if (!existsSync(visionCaseFile)) {
    stages.vision = vision;
    onEvent({ type: "stage", payload: { key: "vision", pass: false, detail: vision.detail } });
  } else {
    // 只验证"能不能看图"，不考识别质量——质量由业务准确率阶段考察。图片压到最长边 768px 减少上传与编码耗时。
    const visionPrompt = "图中是否有一张票据/发票？只回答：有 或 没有。";
    try {
      const shrunkVisionImage = await shrinkImageFile(visionCaseFile, 768);
      visionTempFile = shrunkVisionImage;
      const visionText = (await execute({ prompt: visionPrompt, images: [{ path: shrunkVisionImage }], maxTokens: 24 })).trim();
      const sawImage = /^(有|yes|是)/i.test(visionText);
      vision.pass = sawImage && !/没有|无法|不能/i.test(visionText.slice(0, 20));
      vision.detail = vision.pass ? "具备视觉能力" : `无有效视觉反馈（回复：${visionText.slice(0, 40)}）`;
    } catch (visionError) {
      vision.detail = `视觉调用失败：${visionError instanceof Error ? visionError.message : String(visionError)}`.slice(0, 160);
    }
    stages.vision = vision;
    onEvent({ type: "stage", payload: { key: "vision", pass: vision.pass, detail: vision.detail } });
  }

  if (visionTempFile && visionTempFile !== visionCaseFile) await fs.rm(visionTempFile, { force: true }).catch(() => undefined);
  await fs.rm(visionSample.directory, { recursive: true, force: true });

  // ③ 业务准确率（evals/cases.json）
  let business: { pass: boolean; strict?: number; lenient?: number; total?: number; failures?: Array<{ id: string; expect: string; actual: string }>; skipped?: string } = { pass: false };
  const casesPath = path.join(root, "evals/cases.json");
  if (!existsSync(casesPath)) {
    business.skipped = "缺少 evals/cases.json";
    onEvent({ type: "stage", payload: { key: "business", pass: false, detail: business.skipped } });
  } else {
    const raw = JSON.parse(await fs.readFile(casesPath, "utf8")) as {
      _meta?: { candidateLabels?: string[] };
      candidateLabels?: string[];
      cases: Array<{ id: string; file: string; anonymized?: string | null; group?: string; expect: string; accept?: string[] }>;
    };
    const suite = { candidateLabels: (raw.candidateLabels ?? raw._meta?.candidateLabels ?? []), cases: raw.cases };
    const evalFolder = "01_报销材料/00_收件箱";
    const evalName = `model-test-${randomUUID()}`;
    const evalDir = path.join(root, evalFolder, evalName);
    await fs.mkdir(evalDir, { recursive: true });
    const requirementList = suite.candidateLabels.map((label) => ({ id: label, label, hint: "按内容判断是否属于该类材料" }));
    const strictMatches: number[] = [];
    const results: Array<Record<string, unknown>> = [];
    let lenientPassed = 0;
    onEvent({ type: "stage", payload: { key: "business", pass: null as unknown as boolean, detail: `业务用例 0/${suite.cases.length}` } });
    try {
      for (const testCase of suite.cases) {
        const sourceAbs = path.join(root, testCase.file);
        if (!existsSync(sourceAbs)) { results.push({ id: testCase.id, error: "样本缺失" }); continue; }
        const caseName = `${testCase.anonymized || `case-${testCase.id}${path.extname(testCase.file)}`}`;
        const caseAbs = path.join(evalDir, caseName);
        await fs.copyFile(sourceAbs, caseAbs);
        try {
          const classifyResponse = await classifyThroughLocalService(request, {
              folder: evalFolder,
              paths: [`${evalFolder}/${evalName}/${caseName}`],
              requirements: requirementList,
              contextMaterials: [],
              backend: body.backend,
              model: body.model,
              homeCity: "上海",
            });
          const classifyBody = await classifyResponse.json() as { assignments?: Array<{ path: string; requirementId: string; reason?: string }>; error?: string };
          const assignment = (classifyBody.assignments ?? []).find((item) => item.path.endsWith(caseName));
          const actualLabel = assignment ? (requirementList.find((r) => r.id === assignment.requirementId)?.label ?? "") : "(未归类)";
          const okLenient = actualLabel === testCase.expect || (testCase.accept ?? []).includes(actualLabel);
          if (okLenient) lenientPassed += 1;
          if (actualLabel === testCase.expect) strictMatches.push(1);
          const resultRow = { id: testCase.id, group: testCase.group, expect: testCase.expect, accept: testCase.accept, actual: actualLabel, pass: okLenient, reason: assignment?.reason?.slice(0, 140) ?? classifyBody.error };
          results.push(resultRow);
          onEvent({ type: "case", payload: resultRow });
          onEvent({ type: "stage", payload: { key: "business", pass: null as unknown as boolean, detail: `业务用例 ${results.filter(r => !("error" in r)).length}/${suite.cases.length}` } });
        } finally {
          await fs.rm(caseAbs, { force: true });
        }
      }
    } finally {
      await fs.rm(evalDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const executed = results.filter((item) => !("error" in item));
    const strictPassed = strictMatches.length;
    business = {
      pass: executed.length > 0 && lenientPassed >= Math.ceil(executed.length * 0.8),
      strict: strictPassed,
      lenient: lenientPassed,
      total: executed.length,
      failures: results.filter((item) => item.pass === false).slice(0, 8).map((item) => ({ id: String(item.id), expect: String(item.expect), actual: String(item.actual) })),
    };
    onEvent({ type: "stage", payload: { key: "business", pass: business.pass, detail: `宽 ${lenientPassed}/${executed.length} · 严格 ${strictPassed}` } });

    const historyDir = path.join(root, ".guanzizai/evals/history");
    await fs.mkdir(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    await fs.writeFile(path.join(historyDir, `${stamp}_${body.backend}_${(body.model || "default").replace(/[\\/]/g, "_")}.json`), JSON.stringify({ timestamp: new Date().toISOString(), backend: body.backend, model: body.model || "", connectivity: stages.connectivity, vision: stages.vision, business: { ...business, results }, elapsedMs: Date.now() - startedAt }, null, 1));
  }

  const overallOk = Boolean((stages.connectivity as { pass?: boolean }).pass) && (stages.vision as { pass?: boolean }).pass && business.pass;
  return { overallOk, stages, business };
}

    if (request.method === "POST" && requestUrl.pathname === "/api/ai-backend-test-stream") {
      // SSE 流式三级测试：stage/case/done 事件逐条推送，前端实时渲染进度与结果。
      try {
        const body = await readJsonBody(request) as { backend?: string; model?: string; baseUrl?: string };
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive",
        });
        const send = (event: { type: string; payload: unknown }) => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        try {
          const summary = await runBackendTestStages(request, body, root, send);
          send({ type: "done", payload: summary });
        } catch (streamError) {
          serverTrace({ level: "error", scope: "ai", event: "backend-test.failed" });
          send({ type: "error", payload: { message: streamError instanceof Error ? streamError.message : "后端测试失败" } });
        }
        response.end();
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "后端测试失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ai-backend-test") {
      // 三级测试：① 连通 ② 视觉能力 ③ 业务用例准确率（evals/cases.json）。
      // 全量结果按时间戳记录到 .guanzizai/evals/history/，供跨模型横向对比与问题回溯。
      try {
        const startedAt = Date.now();
        const body = await readJsonBody(request) as { backend?: string; model?: string };
        if (!body.backend) throw new Error("请先选择 AI 后端和模型");
        const model = body.model?.trim() || "后端默认模型";
        const stages: Record<string, unknown> = {};

        // ① 连通性
        const callProbe = async () => {
          if (body.backend === "api") {
            const apiKey = await readSavedApiKey();
            if (!apiKey) throw new Error("请先保存 API Key");
            const baseUrl = typeof (body as { baseUrl?: unknown }).baseUrl === "string" ? (body as { baseUrl: string }).baseUrl : (await readAiSettings(root) ?? normalizeAiSettings({})).apiBaseUrl;
            const provider = apiProviderForApiKey(apiKey, baseUrl);
            return { provider, apiKey, text: await callChatModel(provider, apiKey, { model: body.model || provider.defaultModel, prompt: "仅回复：可用", maxTokens: 16, disableThinking: true }) };
          }
          if (body.backend === "codex") {
            await runCodexCli(["exec", "--skip-git-repo-check", ...(body.model ? ["-m", body.model] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", "Say OK"], 90_000);
            return { provider: null, apiKey: "", text: "OK" };
          }
          await runOpencodeCli([...(body.model ? ["-m", body.model] : []), "--", "仅回复：OK"], 90_000);
          return { provider: null, apiKey: "", text: "OK" };
        };
        try {
          const probe = await callProbe();
          stages.connectivity = { pass: true, detail: `连通 · ${((Date.now() - startedAt) / 1000).toFixed(1)}s` };

          // ② 视觉能力：发送合成票据图，要求读出图中的金额
          const visionSample = await createVisionSample();
          const visionCaseFile = visionSample.file;
          let vision = { pass: false, detail: "（无样本文件，跳过）" as string };
          if (existsSync(visionCaseFile)) {
            const visionPrompt = "Read the total amount shown in the image. Reply with the number only.";
            try {
              let visionText = "";
              if (body.backend === "api" && probe.provider && probe.apiKey) {
                const imageContent = [await chatImageFromFile(visionCaseFile)];
                visionText = await callChatModel(probe.provider, probe.apiKey, { model: body.model || probe.provider.defaultModel, prompt: visionPrompt, images: imageContent, maxTokens: 64, disableThinking: true });
              } else if (body.backend === "codex") {
                visionText = await runCodexCli(["exec", "--skip-git-repo-check", ...(body.model ? ["-m", body.model] : []), "-c", "model_reasoning_effort=low", "-c", "mcp_servers={}", "-c", "skills.include_instructions=false", "-i", visionCaseFile, "--", "-"], 120_000, visionPrompt);
              } else {
                visionText = await runOpencodeCli([...(body.model ? ["-m", body.model] : []), "-f", visionCaseFile, "--", visionPrompt], 120_000);
              }
              vision.pass = /100(?:\.00)?/.test(visionText.replace(/,/g, ""));
              vision.detail = vision.pass ? `视觉 ✓（读到金额 100.00；回复：${visionText.slice(0, 60).replace(/\n/g, " ")}）` : `视觉 ✗（未见预期金额 100.00；回复：${visionText.slice(0, 80).replace(/\n/g, " ")}）`;
            } catch (visionError) {
              vision.detail = `视觉调用失败：${visionError instanceof Error ? visionError.message : String(visionError)}`.slice(0, 160);
            }
          }
          await fs.rm(visionSample.directory, { recursive: true, force: true });
          stages.vision = vision;

          // ③ 业务准确率：evals/cases.json 全部用例走 auto-classify 管线
          let business: { pass: boolean; strict?: number; lenient?: number; total?: number; failures?: Array<{ id: string; expect: string; actual: string }>; skipped?: string } = { pass: false };
          const casesPath = path.join(root, "evals/cases.json");
          if (!existsSync(casesPath)) {
            business.skipped = "缺少 evals/cases.json";
          } else {
            const raw = JSON.parse(await fs.readFile(casesPath, "utf8")) as {
              _meta?: { candidateLabels?: string[] };
              candidateLabels?: string[];
              cases: Array<{ id: string; file: string; anonymized?: string | null; group?: string; expect: string; accept?: string[] }>;
            };
            const suite = { candidateLabels: (raw.candidateLabels ?? raw._meta?.candidateLabels ?? []), cases: raw.cases };
            const evalFolder = "01_报销材料/00_收件箱";
            const evalName = `model-test-${randomUUID()}`;
            const evalDir = path.join(root, evalFolder, evalName);
            await fs.mkdir(evalDir, { recursive: true });
            // auto-classify 端点要求 id/label/hint 均非空
            const requirementList = suite.candidateLabels.map((label) => ({ id: label, label, hint: "按内容判断是否属于该类材料" }));
            const strictMatches: number[] = [];
            const results: Array<Record<string, unknown>> = [];
            let lenientPassed = 0;
            try {
              for (const testCase of suite.cases) {
                const sourceAbs = path.join(root, testCase.file);
                if (!existsSync(sourceAbs)) { results.push({ id: testCase.id, error: "样本缺失" }); continue; }
                const caseName = `${testCase.anonymized || `case-${testCase.id}${path.extname(testCase.file)}`}`;
                const caseAbs = path.join(evalDir, caseName);
                await fs.copyFile(sourceAbs, caseAbs);
                try {
                  const classifyResponse = await classifyThroughLocalService(request, {
                      folder: evalFolder,
                      paths: [`${evalFolder}/${evalName}/${caseName}`],
                      requirements: requirementList,
                      contextMaterials: [],
                      backend: body.backend,
                      model: body.model,
                      homeCity: "上海",
                    });
                  const classifyBody = await classifyResponse.json() as { assignments?: Array<{ path: string; requirementId: string; reason?: string }>; error?: string };
                  const assignment = (classifyBody.assignments ?? []).find((item) => item.path.endsWith(caseName));
                  const actualLabel = assignment ? (requirementList.find((r) => r.id === assignment.requirementId)?.label ?? "") : "(未归类)";
                  const okLenient = actualLabel === testCase.expect || (testCase.accept ?? []).includes(actualLabel);
                  if (okLenient) lenientPassed += 1;
                  if (actualLabel === testCase.expect) strictMatches.push(1);
                  results.push({ id: testCase.id, group: testCase.group, expect: testCase.expect, accept: testCase.accept, actual: actualLabel, pass: okLenient, reason: assignment?.reason?.slice(0, 140) ?? classifyBody.error });
                } finally {
                  await fs.rm(caseAbs, { force: true });
                }
              }
            } finally {
              await fs.rm(evalDir, { recursive: true, force: true }).catch(() => undefined);
            }
            const executed = results.filter((item) => !("error" in item));
            const strictPassed = strictMatches.length;
            business = {
              pass: executed.length > 0 && lenientPassed >= Math.ceil(executed.length * 0.8),
              strict: strictPassed,
              lenient: lenientPassed,
              total: executed.length,
              failures: results.filter((item) => item.pass === false).slice(0, 8).map((item) => ({ id: String(item.id), expect: String(item.expect), actual: String(item.actual) })),
            };
            // 记录历史
            const historyDir = path.join(root, ".guanzizai/evals/history");
            await fs.mkdir(historyDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            await fs.writeFile(path.join(historyDir, `${stamp}_${body.backend}_${(body.model || "default").replace(/[\\/]/g, "_")}.json`), JSON.stringify({ timestamp: new Date().toISOString(), backend: body.backend, model: body.model || "", connectivity: stages.connectivity, vision: stages.vision, business: { ...business, results }, elapsedMs: Date.now() - startedAt }, null, 1));
          }

          const overallOk = Boolean((stages.connectivity as { pass?: boolean }).pass) && (stages.vision as { pass?: boolean }).pass && business.pass;
          const parts = [`连通 ✓`, (stages.vision as { pass?: boolean; detail?: string }).pass ? "视觉 ✓" : `视觉 ✗（${(stages.vision as { detail?: string }).detail ?? ""}）`];
          if (business.total != null) {
            parts.push(`业务 ${business.lenient}/${business.total}（严格 ${business.strict}）`);
          } else if (business.skipped) {
            parts.push(`业务跳过：${business.skipped}`);
          }
          sendJson(response, 200, {
            message: parts.join(" · "),
            ok: overallOk,
            stages,
            business,
          });
        } catch (probeError) {
          console.error("[ai-backend-test] probe:", (probeError instanceof Error ? probeError.stack : String(probeError)));
          sendJson(response, 500, { error: probeError instanceof Error ? probeError.message : "后端测试失败" });
        }
      } catch (error) {
        console.error("[ai-backend-test] outer:", (error instanceof Error ? error.stack : String(error)));
        sendJson(response, 500, { error: error instanceof Error ? error.message : "后端测试失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/traffic-note-document") {
      try {
        const folder = safeLineFolder(requestUrl.searchParams.get("folder") ?? "");
        const body = await readJsonBody(request) as { content?: string; trafficDate?: string; profileId?: string; useSignature?: boolean };
        const content = body.content?.trim();
        if (!folder || !content) { sendJson(response, 400, { error: "说明内容或票据集无效" }); return; }
        const targetFolder = path.join(root, folder);
        const date = new Date().toISOString().slice(0, 10);
        const target = path.join(targetFolder, `${date}_交通情况说明.pdf`);
        await fs.mkdir(targetFolder, { recursive: true });
        const writer = await trafficNoteWriter(root, body.profileId);
        const signature = body.useSignature ? profileSignaturePath(root, safeProfileId(body.profileId ?? "") ?? "") : "";
        if (body.useSignature && (!signature || !existsSync(signature))) throw new Error("当前用户尚未保存签名 PNG");
        await createExplanationPdf(root, target, "traffic", content, body.trafficDate ?? date, writer, signature);
        sendJson(response, 200, { name: path.basename(target) });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "无法保存交通说明" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/split-line") {
      // 拆分归档：把票据集中按费用分类选中的 expenses（及其关联 evidence 文件）拆成独立票据集；
      // 走别人经费的分类（如云服务）可拆出后直接归档，剩余费用留在原集继续走自己的报销。
      try {
        const body = await readJsonBody(request) as { sourceLineId?: string; expenseIds?: string[]; archive?: boolean; finalize?: { billNo?: string; group?: string } };
        const sourceId = typeof body.sourceLineId === "string" ? body.sourceLineId : "";
        const wanted = new Set(Array.isArray(body.expenseIds) ? body.expenseIds : []);
        if (!sourceId || !wanted.size) {
          sendJson(response, 400, { error: "缺少 sourceLineId 或 expenseIds" });
          return;
        }
        const model = await readFormalModel(root) as unknown as {
          sets?: Array<Record<string, unknown>>;
          expenses?: Array<Record<string, unknown>>;
          evidence?: Array<Record<string, unknown>>;
          links?: Array<{ evidenceId: string; expenseId: string; role: string }>;
        };
        const source = (model.sets ?? []).find((entry) => entry.id === sourceId);
        if (!source) {
          sendJson(response, 404, { error: "未找到源票据集" });
          return;
        }
        const selectedExpenses = (model.expenses ?? []).filter((expense) => expense.setId === sourceId && wanted.has(expense.id as string));
        if (!selectedExpenses.length) {
          sendJson(response, 400, { error: "选中费用不属于该票据集" });
          return;
        }
        const selectedExpenseIds = new Set(selectedExpenses.map((expense) => expense.id as string));
        const typeLabel = EXPENSE_TAXONOMY.find((entry) => entry.id === selectedExpenses[0].typeId)?.label ?? "拆分";
        const sourceFolder = String(source.folder ?? "");
        const sourceDir = path.resolve(root, sourceFolder);
        const sourceRelative = toPosix(path.relative(root, sourceDir));
        if (!sourceRelative.startsWith("01_报销材料/")) {
          sendJson(response, 400, { error: "源票据集缺少有效的材料目录" });
          return;
        }
        const baseName = path.basename(sourceDir);
        const year = baseName.match(/^(\d{4})/)?.[1] ?? (String(source.createdAt ?? "").slice(0, 4) || new Date().getFullYear().toString());
        // 标题/目录去重后缀：源集标题已含组 label（如「…·低值易耗设备」再拆同组）时不再叠加（否则出现「·低值易耗设备·低值易耗设备」）
        const typeSuffix = String(source.title ?? "").endsWith(typeLabel) ? "" : `·${typeLabel}`;
        const newBaseName = `${baseName}${typeSuffix}`;
        const destinationRoot = body.archive ? path.join(root, "01_报销材料", "90_已归档", year) : path.dirname(sourceDir);
        let targetDir = path.join(destinationRoot, newBaseName);
        let index = 2;
        while (existsSync(targetDir)) { targetDir = path.join(destinationRoot, `${newBaseName}-${index}`); index += 1; }
        await fs.mkdir(targetDir, { recursive: true });

        const selectedEvidenceIds = new Set((model.links ?? []).filter((link) => selectedExpenseIds.has(link.expenseId)).map((link) => link.evidenceId));
        // 无费用关联但节点归属匹配拆走费用组的材料也迁移（2026-09-19 教训：elab AI 填报生成的资产入账单 PDF
        // 挂在 low-value-gear-elab 节点、无 evidence→expense 链接，拆分时被遗漏，原集残留「elab 资产入账单」空行）
        const financeCollections = workflowForLine(source as FormalModelState["sets"][number]).collections.filter((collection) => collection.scope === "finance");
        const selectedGroupLabels = new Set(selectedExpenses.map((expense) => {
          const label = expenseCollectionLabel(String(expense.typeId ?? ""), financeCollections);
          return label ?? "";
        }));
        const groupNodeIds = new Set<string>();
        for (const g of DAILY_REQUIREMENT_GROUPS) {
          if (selectedGroupLabels.has(g.label)) for (const r of g.requirements) groupNodeIds.add(r.id);
        }
        const sourcePrefix = sourceRelative + "/";
        const metadata = await fs.readFile(path.join(root, "data", "receipt-meta.json"), "utf8")
          .then((raw) => (JSON.parse(raw) as { metadata?: Record<string, ReceiptMeta> }).metadata ?? {})
          .catch((): Record<string, ReceiptMeta> => ({}));
        for (const item of model.evidence ?? []) {
          const p = String(item.path ?? "");
          const relativePath = toPosix(path.relative(root, path.resolve(root, p)));
          if (selectedEvidenceIds.has(item.id as string) || !relativePath.startsWith(sourcePrefix)) continue;
          const metaHit = metadata[p] ?? metadata[relativePath];
          const node = String(metaHit?.classifiedWorkflowNodeId ?? metaHit?.classifiedRequirementId ?? "");
          if (groupNodeIds.has(node)) selectedEvidenceIds.add(item.id as string);
        }
        const selectedEvidence = (model.evidence ?? []).filter((item) => selectedEvidenceIds.has(item.id as string));

        // 物理移动选中的 evidence 文件（按内容哈希寻址，重名自动加后缀）
        const evidencePathMap = new Map<string, string>();
        const movedPaths = new Map<string, string>();
        for (const item of selectedEvidence) {
          const original = path.resolve(root, String(item.path ?? ""));
          const originalRelativePath = toPosix(path.relative(root, original));
          if (!originalRelativePath.startsWith(sourcePrefix) || !existsSync(original)) continue;
          let fileName = path.basename(original);
          let target = path.join(targetDir, fileName);
          let fileIndex = 2;
          while (existsSync(target)) { target = path.join(targetDir, `${path.basename(original, path.extname(original))}-${fileIndex}${path.extname(original)}`); fileIndex += 1; }
          await fs.rename(original, target);
          const newPath = toPosix(path.relative(root, target));
          evidencePathMap.set(item.id as string, newPath);
          movedPaths.set(originalRelativePath, newPath);
          const storedPath = String(item.path ?? "");
          if (storedPath !== originalRelativePath) movedPaths.set(storedPath, newPath);
        }

        const newLineId = `line-${Date.now()}`;
        const today = new Date().toISOString().slice(0, 10);
        const newLine: Record<string, unknown> = {
          ...structuredClone(source),
          id: newLineId,
          title: `${String(source.title ?? baseName)}${typeSuffix}`,
          folder: toPosix(path.relative(root, targetDir)),
          status: body.archive ? "archived" : "active",
          createdAt: today,
          submittedAt: body.archive ? undefined : source.submittedAt,
          archivedAt: body.archive ? new Date().toISOString() : undefined,
          lastArchiveRestore: undefined,
        };
        // 拆出的票据集不继承财务跟踪（报销单号/状态/凭证都属原集）
        for (const key of ["treasuryBillNo", "treasuryBillNos", "treasuryBills", "treasuryStatus", "treasuryStatusAt", "treasuryVoucherNo", "treasuryPostedAt", "treasuryAmountCny"]) delete newLine[key];
        // elabBills 按费用归属分流（不能整体复制：HC/CSF 登记指向的费用拆走后，两边覆盖判定都会错乱）——
        // 登记的 expenseIds 全部落在拆出费用 → 跟到新集；否则留源集（部分交叉保守留源，人工核对）。
        const sourceBills = Array.isArray(source.elabBills) ? (source.elabBills as Array<Record<string, unknown>>) : [];
        const billsToSplit = sourceBills.filter((bill) => {
          const ids = Array.isArray(bill.expenseIds) ? (bill.expenseIds as string[]).map(String) : [];
          return ids.length > 0 && ids.every((id) => selectedExpenseIds.has(id));
        });
        const billsKept = sourceBills.filter((bill) => !billsToSplit.includes(bill));
        if (billsToSplit.length) newLine.elabBills = billsToSplit;
        else delete newLine.elabBills;
        source.elabBills = billsKept.length ? billsKept : undefined;
        model.sets = [...(model.sets ?? []), newLine];
        // 费用迁移登记：拆分后打开着的旧窗口会以拆分前快照 PUT /api/model-state，把费用 setId 洗回原集
        // （2026-09-30 云服务拆分实证：材料搬走、费用留原 → 原集残留空节点+缺件误报）。model-state PUT 读此登记强制重定向。
        try {
          const remapPath = path.join(root, "data", "expense-set-remaps.json");
          const remaps = JSON.parse(await fs.readFile(remapPath, "utf8").catch(() => "{}")) as Record<string, unknown> & { evidencePaths?: Record<string, string> };
          const expenseMap = (remaps.expenses ?? {}) as Record<string, string>;
          for (const id of selectedExpenseIds) expenseMap[id] = newLineId;
          remaps.expenses = expenseMap;
          remaps.evidencePaths = { ...(remaps.evidencePaths ?? {}), ...Object.fromEntries(evidencePathMap) };
          await atomicWriteJson(remapPath, remaps);
        } catch { /* remap 写入失败不阻塞拆分 */ }
        model.expenses = (model.expenses ?? []).map((expense) => (selectedExpenseIds.has(expense.id as string) ? { ...expense, setId: newLineId } : expense));
        model.evidence = (model.evidence ?? []).map((item) => (evidencePathMap.has(item.id as string) ? { ...item, path: evidencePathMap.get(item.id as string) } : item));
        await writeFormalModel(root, model);
        // 源集的 elabBills 同步回 receipt-lines（前端 elabbills 权威源；refresh 后以此为准）
        try {
          const linesPath = path.join(root, "data", "receipt-lines.json");
          const linesDoc = JSON.parse(await fs.readFile(linesPath, "utf8")) as { lines?: Array<Record<string, unknown>> };
          const srcLineEntry = (linesDoc.lines ?? []).find((l) => l.id === sourceId);
          if (srcLineEntry) srcLineEntry.elabBills = billsKept.length ? billsKept : undefined;
          await atomicWriteJson(linesPath, linesDoc);
        } catch { /* receipt-lines 同步失败不阻塞拆分（refresh 后 elabPreapprovalGaps 会暴露差异） */ }
        // meta 键随文件迁移（拆出的文件归类记录不能失联）
        try {
          await withReceiptMetaWrite(async () => {
            const metaPath = path.join(root, "data", "receipt-meta.json");
            const metaDoc = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}")) as { metadata?: Record<string, unknown> };
            const meta = metaDoc.metadata ?? {};
            for (const [oldRel, newRel] of movedPaths) {
              if (meta[oldRel] !== undefined) { meta[newRel] = meta[oldRel]; delete meta[oldRel]; }
            }
            await atomicWriteJson(metaPath, metaDoc);
          });
        } catch { /* meta 迁移失败不阻塞拆分 */ }
        // 组快照重算（2026-09-19）：拆分后按剩余费用重算原集/新集的 requirements+groups——
        // 否则原集挂着无费用组的空壳（low-value-gear-elab 节点 visibleWhen=always 恒显示 AI 填报入口，用户误以为漏拆）。
        try {
          const dailyDefs = DAILY_REQUIREMENT_GROUPS;
          const groupLabelById = new Map(dailyDefs.map((g) => [g.id, g.label]));
          const recalcGroups = (lineId: string) => {
            const activeLabels = new Set<string>();
            for (const expense of model.expenses ?? []) {
              if (expense.setId !== lineId) continue;
              const label = expenseCollectionLabel(String(expense.typeId ?? ""), dailyDefs.map((g) => ({ label: g.label, nodeIds: g.requirements.map((r) => r.id) })));
              if (label) activeLabels.add(label);
            }
            const keptGroups = dailyDefs.filter((g) => activeLabels.has(g.label));
            const keptReqIds = new Set(keptGroups.flatMap((g) => g.requirements.map((r) => r.id)));
            return { groups: keptGroups, requirements: (source.requirements as Array<{ id: string }>).filter((r) => keptReqIds.has(r.id)) };
          };
          const srcCalc = recalcGroups(sourceId);
          source.groups = srcCalc.groups;
          source.requirements = srcCalc.requirements;
          const newSetForCalc = (model.sets ?? []).find((entry) => entry.id === newLineId) as Record<string, unknown> | undefined;
          if (newSetForCalc) {
            const newCalc = recalcGroups(newLineId);
            newSetForCalc.groups = newCalc.groups;
            newSetForCalc.requirements = newCalc.requirements;
          }
          await writeFormalModel(root, model);
        } catch { /* 组快照重算失败不阻塞拆分 */ }
        // finalize（2026-09-19 拆分递交语义：先递交成功、后拆分）：带 billNo 时新集直接置已递交并继承登记，
        // 原集移除该 billNo/组标记（无剩余登记回 active）——单号登记从原集迁移到新集， receipt-lines 同步写入。
        const finalize = body.finalize;
        if (finalize?.billNo) {
          const billNo = finalize.billNo;
          const srcBills = Array.isArray(source.treasuryBills) ? (source.treasuryBills as Array<Record<string, unknown>>) : [];
          const newSetEntry = (model.sets ?? []).find((entry) => entry.id === newLineId) as Record<string, unknown> | undefined;
          if (newSetEntry) {
            newSetEntry.status = "submitted";
            newSetEntry.submittedAt = new Date().toISOString().slice(0, 10);
            newSetEntry.treasuryBillNo = billNo;
            newSetEntry.treasuryBillNos = [billNo];
            newSetEntry.treasuryBills = [{ ...srcBills.find((entry) => entry.billNo === billNo), billNo, system: "YBX", group: finalize.group ?? "全部费用" }];
          }
          // elab 登记归属迁移：新集的 elabBills 按 registry 记到新集名下（旧窗口 PUT 错位时被剥离）
          try {
            const registryPath = path.join(root, "data", "elab-bill-registry.json");
            const billRegistry = JSON.parse(await fs.readFile(registryPath, "utf8").catch(() => "{}")) as Record<string, string>;
            for (const bill of ((newLine.elabBills ?? []) as Array<{ billNo?: string }>)) {
              if (bill.billNo) billRegistry[bill.billNo] = String(newLineId);
            }
            await atomicWriteJson(registryPath, billRegistry);
          } catch { /* registry 更新失败不阻塞拆分 */ }
          const nos = new Set(Array.isArray(source.treasuryBillNos) ? (source.treasuryBillNos as string[]) : []);
          nos.delete(billNo);
          source.treasuryBillNos = Array.from(nos);
          source.treasuryBills = srcBills.filter((entry) => entry.billNo !== billNo);
          if (source.treasuryBillNo === billNo) source.treasuryBillNo = nos.values().next().value ?? "";
          const srcGroups = new Set(Array.isArray(source.submittedGroups) ? (source.submittedGroups as string[]) : []);
          srcGroups.delete(finalize.group || "__all__");
          source.submittedGroups = Array.from(srcGroups);
          if (!nos.size) {
            source.status = "active";
            delete source.submittedAt;
          }
          // receipt-lines 同步（新集行 + 原集状态）：拆分此前只写 model——2026-09-19 实证缺行导致前端不可见
          try {
            const rlPath = path.join(root, "data", "receipt-lines.json");
            const rlDoc = JSON.parse(await fs.readFile(rlPath, "utf8").catch(() => "{}")) as { lines?: Array<Record<string, unknown>> };
            const lines = rlDoc.lines ?? [];
            const newLineRecord = {
              id: newLineId, title: newLine.title, kind: newLine.kind, createdAt: newLine.createdAt,
              status: "submitted", submittedAt: newSetEntry?.submittedAt, folder: newLine.folder,
              requirements: newLine.requirements, groups: newLine.groups,
              workflowId: newLine.workflowId, workflowVersion: newLine.workflowVersion,
              treasuryBillNo: billNo, treasuryBillNos: [billNo], treasuryBills: newSetEntry?.treasuryBills, projectId: source.projectId,
              elabBills: (Array.isArray(newLine.elabBills) && newLine.elabBills.length) ? newLine.elabBills : undefined,
            };
            const idx = lines.findIndex((l) => l.id === newLineId);
            if (idx >= 0) lines[idx] = newLineRecord; else lines.push(newLineRecord);
            const srcIdx = lines.findIndex((l) => l.id === sourceId);
            if (srcIdx >= 0) {
              lines[srcIdx] = { ...lines[srcIdx], status: source.status, treasuryBillNo: source.treasuryBillNo || undefined, treasuryBillNos: source.treasuryBillNos, treasuryBills: source.treasuryBills, submittedGroups: source.submittedGroups, requirements: source.requirements, groups: source.groups };
            }
            await atomicWriteJson(rlPath, rlDoc);
          } catch { /* receipt-lines 同步失败不阻塞拆分（前端 setState 双写兜底） */ }
        }
        sendJson(response, 200, { lineId: newLineId, folder: newLine.folder as string, moved: evidencePathMap.size, expenses: selectedExpenses.length, line: newLine });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "拆分票据集失败" });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/move-line") {
      try {
        const requestedFolder = requestUrl.searchParams.get("folder") ?? "";
        const destination = requestUrl.searchParams.get("destination");
        const action = destination === "archived" ? "archive" : destination === "restore" ? "restore" : destination === "submitted" ? "submit" : null;
        if (action) serverTrace({ level: "info", scope: "line-move", event: action });
        const folder = safeLineFolder(requestedFolder);
        const postedOnly = destination === "archived" && requestUrl.searchParams.get("postedOnly") === "true";
        const lineId = requestUrl.searchParams.get("lineId");
        if (postedOnly) {
          const model = await readFormalModel(root) as FormalModelState | null;
          const line = model?.sets?.find((entry) => entry.id === lineId);
          if (line?.status === "archived" && line.folder.startsWith("01_报销材料/90_已归档/") && existsSync(path.join(root, line.folder))) {
            await syncArchivedLineSnapshot(root, line);
            sendJson(response, 200, { folder: line.folder, archivedAt: line.archivedAt });
            return;
          }
          if (!model || !line || line.folder !== folder || !canArchivePostedLine(line)) {
            sendJson(response, 409, { error: "票据集尚未确认全部单据入账，或目录已变更" });
            return;
          }
          if (line.folder.startsWith("01_报销材料/90_已归档/")) {
            if (!existsSync(path.join(root, line.folder))) {
              sendJson(response, 404, { error: "票据集材料目录不存在，请刷新后重试" });
              return;
            }
            line.status = "archived";
            line.archivedAt = new Date().toISOString();
            await writeFormalModel(root, model);
            await syncArchivedLineSnapshot(root, line);
            sendJson(response, 200, { folder: line.folder, archivedAt: line.archivedAt });
            return;
          }
        }
        if (destination === "archived" && folder?.startsWith("01_报销材料/90_已归档/")) {
          if (!existsSync(path.join(root, folder))) {
            sendJson(response, 404, { error: "票据集材料目录不存在，请刷新后重试" });
            return;
          }
          const model = await readFormalModel(root) as FormalModelState | null;
          const line = model?.sets?.find((entry) => entry.folder === folder);
          if (model && line && line.status !== "archived") {
            line.status = "archived";
            line.archivedAt = new Date().toISOString();
            await writeFormalModel(root, model);
          }
          if (line) await syncArchivedLineSnapshot(root, line);
          sendJson(response, 200, { folder, archivedAt: line?.archivedAt });
          return;
        }
        // 还原（从已递交）：撤销递交语义——30_已提交 退回 10_办理中，status 回 active；
        // treasuryBillNos/Bills 历史保留（单据确实提交过），仅清当前跟踪单号；财务系统侧单据需人工处理。
        if (destination === "restore" && folder?.startsWith("01_报销材料/30_已提交/")) {
          const year = path.basename(folder).match(/^(\d{4})/)?.[1] ?? String(new Date().getFullYear());
          const restoreBase = path.join(root, "01_报销材料", "10_办理中", year);
          let restoreTarget = path.join(restoreBase, path.basename(folder));
          let restoreIndex = 2;
          while (existsSync(restoreTarget)) { restoreTarget = path.join(restoreBase, `${path.basename(folder)}-${restoreIndex}`); restoreIndex += 1; }
          await fs.mkdir(restoreBase, { recursive: true });
          await fs.rename(path.join(root, folder), restoreTarget);
          const newFolderRel = toPosix(path.relative(root, restoreTarget));
          try {
            await withReceiptMetaWrite(async () => {
              const metaPath = path.join(root, "data", "receipt-meta.json");
              const metaDoc = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}")) as { metadata?: Record<string, unknown> };
              const meta = metaDoc.metadata ?? {};
              for (const key of Object.keys(meta)) {
                if (key.startsWith(`${folder}/`)) { meta[newFolderRel + key.slice(folder.length)] = meta[key]; delete meta[key]; }
              }
              await atomicWriteJson(metaPath, metaDoc);
            });
            const moveModel = await readFormalModel(root) as unknown as { sets?: Array<Record<string, unknown>> } | null;
            if (moveModel?.sets) {
              for (const entry of moveModel.sets) if (entry.folder === folder) {
                entry.folder = newFolderRel;
                entry.status = "active";
                entry.treasuryBillNo = "";
              }
              await writeFormalModel(root, moveModel);
            }
          } catch { /* meta/model 同步失败不阻塞还原 */ }
          sendJson(response, 200, { folder: newFolderRel, status: "active" });
          return;
        }
        // 还原：手动归档的票据集从归档区退回——登记过报销单的回 30_已提交（submitted），否则回 10_办理中（active）。
        if (destination === "restore" && folder?.startsWith("01_报销材料/90_已归档/")) {
          // 已入账的归档是终态（凭证已生成），不允许还原——只有手动归档（未入账）可退回。
          const archivedModel = await readFormalModel(root) as FormalModelState | null;
          const archivedEntry = archivedModel?.sets?.find((entry) => entry.folder === folder);
          if (archivedEntry && isArchiveLocked(archivedEntry)) {
            sendJson(response, 409, { error: "已入账的归档为终态，不可还原" });
            return;
          }
          const restoreTo = archivedEntry
            ? restoreArchiveDestination(archivedEntry)
            : requestUrl.searchParams.get("restoreTo") === "submitted" ? "submitted" : "active";
          const restoreRoot = restoreTo === "submitted" ? "30_已提交" : "10_办理中";
          const restoreBase = path.join(root, "01_报销材料", restoreRoot, path.basename(folder).match(/^(\d{4})/)?.[1] ?? String(new Date().getFullYear()));
          let restoreTarget = path.join(restoreBase, path.basename(folder));
          let restoreIndex = 2;
          while (existsSync(restoreTarget)) { restoreTarget = path.join(restoreBase, `${path.basename(folder)}-${restoreIndex}`); restoreIndex += 1; }
          await fs.mkdir(restoreBase, { recursive: true });
          await fs.rename(path.join(root, folder), restoreTarget);
          const restoreRel = path.relative(root, restoreTarget).split(path.sep).join("/");
          const restoredAt = new Date().toISOString();
          if (archivedModel && archivedEntry) {
            archivedEntry.folder = restoreRel;
            archivedEntry.status = restoreTo;
            archivedEntry.lastArchiveRestore = { archivedAt: archivedEntry.archivedAt, restoredAt };
            delete archivedEntry.archivedAt;
            try {
              await writeFormalModel(root, archivedModel);
            } catch (error) {
              await fs.rename(restoreTarget, path.join(root, folder));
              throw error;
            }
            await syncArchivedLineSnapshot(root, archivedEntry);
          }
          sendJson(response, 200, { folder: restoreRel, status: restoreTo, restoredAt });
          return;
        }
        const allowedSource =
          (destination === "submitted" &&
            (folder?.startsWith("01_报销材料/10_办理中/") ||
              folder?.startsWith("01_报销材料/20_待提交/"))) ||
          (destination === "archived" &&
            (folder?.startsWith("01_报销材料/30_已提交/") ||
              folder?.startsWith("01_报销材料/10_办理中/") ||
              folder?.startsWith("01_报销材料/20_待提交/")));
        if (!folder || !allowedSource || (destination !== "submitted" && destination !== "archived")) {
          sendJson(response, 400, { error: "无效的报销 line 目录" });
          return;
        }

        const year = path.basename(folder).match(/^(\d{4})/)?.[1] ?? new Date().getFullYear().toString();
        const destinationRoot = destination === "submitted" ? "30_已提交" : "90_已归档";
        const targetBase = path.join(root, "01_报销材料", destinationRoot, year);
        const source = path.join(root, folder);
        let target = path.join(targetBase, path.basename(folder));
        let index = 2;
        while (existsSync(target)) {
          target = path.join(targetBase, `${path.basename(folder)}-${index}`);
          index += 1;
        }

        const sourceExists = existsSync(source);
        if (sourceExists) {
          await fs.mkdir(targetBase, { recursive: true });
          await fs.rename(source, target);
        } else if (postedOnly) {
          sendJson(response, 404, { error: "票据集材料目录不存在，请刷新后重试" });
          return;
        }
        const newFolderRel = toPosix(path.relative(root, target));
        const archivedAt = destination === "archived" ? new Date().toISOString() : undefined;
        let archiveSnapshot: FormalModelState["sets"][number] | undefined;
        if (destination === "archived") {
          try {
            const model = await readFormalModel(root) as FormalModelState | null;
            const line = model?.sets?.find((entry) => postedOnly ? entry.id === lineId : entry.folder === folder);
            if (postedOnly && (!model || !line || line.folder !== folder || !canArchivePostedLine(line))) {
              throw new Error("归档期间财务状态或目录已变更，请刷新后重试");
            }
            if (model && line) {
              line.folder = newFolderRel;
              line.status = "archived";
              line.archivedAt = archivedAt;
              await writeFormalModel(root, model);
              archiveSnapshot = line;
            }
          } catch (error) {
            if (sourceExists) await fs.rename(target, source);
            throw error;
          }
        }
        if (destination === "archived") {
          await fs.rm(templateWorkspace(folder), { recursive: true, force: true }).catch(() => undefined);
        }
        // meta 键随文件夹迁移（归类记录不能失联）+ model.sets.folder 同步（folder 快照过时会触发数据健康测试红）
        try {
          await withReceiptMetaWrite(async () => {
            const metaPath = path.join(root, "data", "receipt-meta.json");
            const metaDoc = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}")) as { metadata?: Record<string, unknown> };
            const meta = metaDoc.metadata ?? {};
            for (const key of Object.keys(meta)) {
              if (key.startsWith(`${folder}/`)) {
                const nk = newFolderRel + key.slice(folder.length);
                meta[nk] = meta[key];
                delete meta[key];
              }
            }
            await atomicWriteJson(metaPath, metaDoc);
          });
          if (destination === "submitted") {
            const moveModel = await readFormalModel(root) as FormalModelState | null;
            if (moveModel?.sets) {
              for (const entry of moveModel.sets) if (entry.folder === folder) {
                entry.folder = newFolderRel;
              }
              await writeFormalModel(root, moveModel);
            }
          }
        } catch { /* meta/model 同步失败不阻塞移动 */ }
        if (archiveSnapshot) await syncArchivedLineSnapshot(root, archiveSnapshot);
        sendJson(response, 200, { folder: newFolderRel, archivedAt });
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "移动报销 line 失败",
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/reveal") {
      try {
        const requestPath = requestUrl.searchParams.get("path") ?? "";
        const materialPath = safeMaterialPath(root, requestPath);
        if (!materialPath || !existsSync(materialPath) || !(await fs.stat(materialPath)).isFile()) {
          sendJson(response, 404, { error: "材料不存在" });
          return;
        }
        if (process.platform === "win32") {
          // Explorer may exit with code 1 after handing off to the existing shell.
          const explorer = spawn("explorer.exe", [`/select,${materialPath}`], { stdio: "ignore", detached: true });
          await new Promise<void>((resolve, reject) => {
            explorer.once("spawn", resolve);
            explorer.once("error", reject);
          });
          explorer.unref();
        } else await execFileAsync("open", ["-R", materialPath]);
        sendJson(response, 200, { revealed: true });
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "无法在文件管理器中显示材料",
        });
      }
      return;
    }

    // 物理删除材料文件；仅用于票据集归档时清理用户已移除的材料。
    if (request.method === "POST" && requestUrl.pathname === "/api/delete-material") {
      try {
        const requestPath = requestUrl.searchParams.get("path") ?? "";
        const materialPath = safeMaterialPath(root, requestPath);
        if (!materialPath || !existsSync(materialPath) || !(await fs.stat(materialPath)).isFile()) {
          sendJson(response, 404, { error: "材料不存在" });
          return;
        }
        await fs.rm(materialPath);
        sendJson(response, 200, { deleted: true });
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "无法删除材料",
        });
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/material-download") {
      try {
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 415, { error: "需要 JSON 格式的下载请求" });
          return;
        }
        const { path: sourcePath } = await readJsonBody(request) as { path?: unknown };
        const source = typeof sourcePath === "string" ? safeMaterialPath(root, encodeURIComponent(sourcePath)) : null;
        if (!source || !SUPPORTED_EXTENSIONS.has(path.extname(source).toLowerCase())) {
          sendJson(response, 400, { error: "材料路径无效" });
          return;
        }
        const [realSource, materialsRoot] = await Promise.all([
          fs.realpath(source),
          fs.realpath(path.join(root, MATERIAL_ROOTS[0])),
        ]);
        if (!realSource.startsWith(`${materialsRoot}${path.sep}`) || !(await fs.stat(realSource)).isFile()) {
          sendJson(response, 400, { error: "材料路径无效" });
          return;
        }
        const downloads = path.join(homedir(), "Downloads");
        await fs.mkdir(downloads, { recursive: true });
        let savedPath: string;
        for (;;) {
          savedPath = await uniqueFilePath(downloads, path.basename(source));
          try {
            await fs.copyFile(realSource, savedPath, fsConstants.COPYFILE_EXCL);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        sendJson(response, 200, { name: path.basename(savedPath) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          sendJson(response, 404, { error: "材料不存在或已移动" });
        } else {
          sendJson(response, 500, { error: "无法保存到系统下载目录" });
        }
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/preview") {
      try {
        const requestPath = requestUrl.searchParams.get("path") ?? "";
        const materialPath = safeMaterialPath(root, encodeURIComponent(requestPath));
        const extension = materialPath ? path.extname(materialPath).toLowerCase() : "";
        if (!materialPath || ![".pdf", ".doc", ".docx", ".xlsx", ".pptx", ".ofd"].includes(extension)) {
          sendJson(response, 400, { error: "该材料格式暂不支持转换预览" });
          return;
        }
        if (process.platform === "win32" && extension === ".pdf") {
          const directory = await fs.mkdtemp(path.join(tmpdir(), "receipt-preview-"));
          try {
            const output = path.join(directory, "page.png");
            await previewWindowsPdf(materialPath, output);
            const bytes = await fs.readFile(output);
            response.writeHead(200, { "Content-Type": "image/png", "Content-Length": bytes.length });
            response.end(bytes);
          } finally {
            await fs.rm(directory, { recursive: true, force: true });
          }
          return;
        }
        if (process.platform === "win32" && [".docx", ".xlsx", ".pptx", ".ofd"].includes(extension)) {
          const { stdout } = await runSchoolScript(root, "tools/office-preview.py", [materialPath], 15_000);
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(stdout.trim() || "文件没有可提取的文本，可下载原文件查看。");
          return;
        }
        if (extension === ".ofd") {
          const text = await materialTextForClassification(materialPath);
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(text || "此 OFD 文件没有可提取预览的文本，可下载原文件查看。");
          return;
        }
        await serveMaterial(request, response, await createQuickLookPreview(materialPath));
      } catch (error) {
        sendJson(response, 500, {
          error: "无法生成材料预览",
        });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/materials/")) {
      const materialPath = safeMaterialPath(
        root,
        requestUrl.pathname.slice("/materials/".length),
      );
      if (!materialPath) {
        sendJson(response, 403, { error: "无权访问该路径" });
        return;
      }
      await serveMaterial(request, response, materialPath);
      return;
    }

    next();
  };

  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    return diagnostics.track(request, response, pathname, () => middleware(request, response, next));
  };
}
