import { version as appVersion } from "../package.json";
import {
  Archive,
  FileCheck2,
  ClipboardList,
  Undo2,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  ArrowLeft,
  FilePenLine,
  LoaderCircle,
  Plus,
  Printer,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  UserCog,
  Wallet,
  X,
  TerminalSquare,
} from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { requirementKey, useReceiptStore } from "./store";
import { appLog } from "./console-log";
import { subscribeTrace, traceEntriesAfter, getTraceVersion } from "./trace";
import { FINANCE_ATTACHMENT_LIMIT, shouldPrioritizeIncomplete, sortIncompleteFirst } from "./reimbursement-policy";
import { classifiedFileAlsoMatches } from "./classification-rules";
import { withinAmountTier, type AmountMatchTier } from "./amount-matching";
import { cloudPaymentNodeKind } from "./cloud-payment";
import { FilePreviewTrigger } from "./FilePreviewTrigger";
import { orderLinesForView } from "./line-order";
import { useCardMasonry } from "./use-card-masonry";
import { loadCachedAiModels, saveCachedAiModels, type AiModelOption } from "./ai-model-cache";
import { createUserProfile, loadActiveUserProfileId, loadUserProfiles, saveActiveUserProfileId, saveUserProfiles, userProfileLabel, type MembershipProfile, type UserProfile, type UserProfileRecord } from "./user-profile";
import { orderMemberships } from "./membership-order";
import { chooseReceiptPair, resolveWorkflow } from "./workflow";
import { allTreasuryBillsPosted, archivedApplicationTotal, canArchivePostedLine, isArchiveLocked, lineBillNos, lineTreasuryBills, refreshTreasuryStatus, restoreArchiveDestination, treasuryProgress } from "./treasury-sync";
import { emptyDelivery } from "./first-run";
import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import { TreasuryDetailDialog } from "./TreasuryDetailDialog";
import { MaterialSearchDialog } from "./MaterialSearchDialog";
import { workflowForLine } from "./workflows";
import { classifyEvidenceType, cloudPaymentMonths, dedupeExpenses, elabPreapprovalGaps, expenseIssues, expenseNotices, groupAmountCny, isPreapprovalEvidence, lowValueGearBatchNotice, materialRowNumber, uniqueMaterialExpenseLinks, type Expense, type FormalModelState } from "./formal-model";
import { EXPENSE_TAXONOMY, elabPreapprovalFor } from "./expense-taxonomy";
import { expenseCollectionLabel, NODE_BINDINGS } from "./workflows";
import { renderMarkdownToHtml } from "./mini-markdown";
import { calculateDfMonth, currentQuarterKey, DF_DEFAULT_SPECIAL_DEDUCTION, DF_DEDUCTION_FIELDS, DF_INCOME_FIELDS, isFutureMonth, isQuarterConfirmationOpen, quarterKeyOf, quarterMonths } from "./df";
import { laborMonthKey, newLaborMember, type LaborMember } from "./labor";
import type { ClassificationAssignment, ElabBillRecord, ExpenseLine, LineDelivery, ReceiptMeta, ReceiptRecord, Requirement, RequirementGroup, ViewId } from "./types";

/** 上次递交使用的投递参数（全局记忆，作为下一次预填默认）。 */
const DiagnosticsDialog = lazy(() => import("./DiagnosticsDialog"));
const LAST_DELIVERY_KEY = "guanzizai:last-delivery:v2";
function readLastDelivery(firstRunDelivery?: LineDelivery): LineDelivery {
  try {
    const raw = localStorage.getItem(LAST_DELIVERY_KEY);
    if (raw) return JSON.parse(raw) as LineDelivery;
  } catch { /* 忽略坏数据 */ }
  return firstRunDelivery ?? emptyDelivery;
}
function rememberLastDelivery(delivery: LineDelivery) {
  try { localStorage.setItem(LAST_DELIVERY_KEY, JSON.stringify(delivery)); } catch { /* 存储不可用 */ }
}

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "active", label: "进行中" },
  { id: "submitted", label: "已递交" },
  { id: "archived", label: "已归档" },
];
const ProcessGuideDialog = lazy(async () => ({ default: (await import("./ProcessGuideDialog")).ProcessGuideDialog }));
const RuleLibraryDialog = lazy(async () => ({ default: (await import("./RuleLibraryDialog")).RuleLibraryDialog }));

const ACCEPTED_FILES = ".pdf,.ofd,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.pptx,.txt";
const AI_SETTINGS_KEY = "guanzizai-receipt-ai-settings:v1";
const AI_BACKEND_TEST_KEY = "guanzizai-receipt-ai-backend-test:v1";
const TRAFFIC_NOTE_JOBS_KEY = "guanzizai-receipt-traffic-note-jobs:v1";
const CLASSIFICATION_JOBS_KEY = "guanzizai-receipt-classification-jobs:v1";
/** CUPS 可直接打印的格式；docx/ofd 需先导出 PDF 再打印。 */
const PRINTABLE_EXTS = new Set(["pdf", "jpg", "jpeg", "png"]);
type AiBackend = "off" | "api" | "codex" | "opencode";
type AiSettings = { backend: AiBackend; model: string; apiBaseUrl: string };
type AiBackendTest = { backend: AiBackend; model: string };
type PrinterEntry = {
  name: string;
  deviceUri: string;
  isNetwork: boolean;
  state: "idle" | "printing" | "disabled" | "unknown";
  accepting: boolean;
  reachable: boolean | null;
};
type PrinterSummary = { printers: PrinterEntry[]; configured: string; platform?: string };
type PrintOutcome = { printed: string[]; unconfirmedHashes?: string[]; failed: Array<{ path: string; error: string }> };
const AI_MODEL_OPTIONS = [
  { value: "", label: "使用后端默认（推荐）" },
];
/** OpenAI 兼容端点预设；任何兼容服务商（含本地 Ollama）填 baseURL 即可接入。 */
const API_BASE_URL_PRESETS = [
  "https://api.openai.com/v1",
  "https://open.bigmodel.cn/api/coding/paas/v4",
  "https://open.bigmodel.cn/api/paas/v4",
  "https://api.deepseek.com/v1",
  "https://api.moonshot.cn/v1",
  "http://127.0.0.1:11434/v1",
];

function loadAiSettings(): AiSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) ?? "{}") as Partial<AiSettings>;
    return { backend: stored.backend === "api" || stored.backend === "codex" || stored.backend === "opencode" ? stored.backend : "off", model: stored.model ?? "", apiBaseUrl: stored.apiBaseUrl ?? "" };
  } catch {
    return { backend: "off", model: "", apiBaseUrl: "" };
  }
}

function loadTrafficNoteJobs() {
  try {
    const value = JSON.parse(localStorage.getItem(TRAFFIC_NOTE_JOBS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object") return {} as Record<string, string>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {} as Record<string, string>;
  }
}

function findRequirementFiles(records: ReceiptRecord[], requirement: Requirement) {
  if (requirement.requiredPaths?.length) {
    return requirement.requiredPaths.every((path) => records.some((record) => record.path === path))
      ? requirement.requiredPaths.flatMap((path) => records.find((record) => record.path === path)).filter((record): record is ReceiptRecord => Boolean(record))
      : [];
  }
  return records.filter((record) => {
    if (requirement.templateId && record.name.includes("模板")) return false;
    const classified = record.classifiedRequirementId ?? record.classifiedWorkflowNodeId;
    if (classified || record.classifiedRequirementId) {
      if (classified === requirement.id || (requirement.id === "return" && record.classifiedRequirementId === "return-confirmation")) return true;
      // 铁路电子客票发票一张顶两张（交通发票+乘車凭证），与 workflow.ts 例外保持一致，否则 UI 进度与流程图不一致。
      if (classifiedFileAlsoMatches(classified ?? "", requirement.id, record.name)) return true;
      return false;
    }
    const value = record.name.toLowerCase();
    const matches = requirement.keywords.map((keyword) => keyword.toLowerCase().split("&").map((part) => part.trim()).filter(Boolean).every((part) => value.includes(part)));
    return requirement.matchAll ? matches.every(Boolean) : matches.some(Boolean);
  });
}

function resolvedMembership(membership: MembershipProfile, memberships: MembershipProfile[]) {
  const parent = membership.parentId ? memberships.find((candidate) => candidate.id === membership.parentId) : undefined;
  return {
    parent,
    parentName: parent?.organization || membership.parentName || "",
    number: membership.number || parent?.number || "",
    level: membership.level || parent?.level || "",
    status: membership.status || parent?.status || "",
    effectiveDate: membership.effectiveDate || parent?.effectiveDate || "",
    validUntil: membership.validUntil || parent?.validUntil || "",
  };
}

interface BudgetRow { code: string; name: string; control: string; budget: number | null; spent: number | null; frozen: number | null; balance: number | null; executionRate: number | null }
interface BudgetFile { projectId: string; projectName: string; fetchedAt: string; projectInfo?: Record<string, string>; rows: BudgetRow[] }

/** 线上递交任务（卡片悬浮层显示全过程 + 草稿就绪后的确认环节）。 */
interface OnlineJobState {
  lineId: string; jobId: string; title: string;
  state: "running" | "awaiting" | "submitting" | "submitted" | "withdrawing" | "withdrawn" | "failed" | "stopped";
  step: string; billNo: string; error: string;
  startedAt: number; logTail: string[]; progress: number;
  /** 分组递交：本次 job 递交的费用组（拆分递交用）。 */
  group?: string;
  /** 已完成「递交成功 → 拆分进已递交」的收尾（防重复触发）。 */
  finalized?: boolean;
}

/** 线上递交任务本地持久化：页面刷新（dev 重启/HMR/切标签）后恢复悬浮层与轮询——后端任务仍在跑，状态从 status API 续上。 */
const ONLINE_JOB_KEY = "guanzizai.onlineJob";
function loadOnlineJob(): OnlineJobState | null {
  try {
    const raw = localStorage.getItem(ONLINE_JOB_KEY);
    if (!raw) return null;
    const job = JSON.parse(raw) as OnlineJobState;
    if (!job?.jobId) return null;
    if (["submitted", "withdrawn", "failed", "stopped"].includes(job.state)) return null;
    return job;
  } catch { return null; }
}

/** 线上递交清单（递交前由 /api/online-submit-plan 生成，面板确认后原样递交）。 */
interface SubmitPlan {
  lineId: string; title: string;
  invoiceCount: number; attachmentCount: number; expensesTotal: number;
  subsidyDays: number; subsidyPerDay: number; subsidy: number; expectedAmount: string;
  summary: string; payRemark: string; campus: string; approver: string; projectId: string;
  attachmentDesc: string;
  group?: string; groupLabel?: string;
  groupsOverview?: Array<{ group: string; label: string; hint: string; expenseCount: number; amountCny: number; preapproved: boolean; invoiceCount: number; attachmentCount: number }>;
  formFields?: Array<{ label: string; value: string }>;
}

const formatBudgetAmount = (value: number | null) => value === null ? "—" : value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface BudgetTreeRow { row: BudgetRow; guides: boolean[]; isLast: boolean; hasChildren: boolean }

// 层级色：L0 汇总 / L1 一级 / L2 二级 / L3 三级及更深
const BUDGET_LEVEL_COLORS = ["var(--red)", "var(--navy)", "#b07d2b", "#8a8a92"];

// 预算项代码层级树：父 code = 子 code 去掉末尾两位（A127020101 -> A1270201 -> A12702 -> A127）
const buildBudgetTree = (rows: BudgetRow[], collapsed: string[]): BudgetTreeRow[] => {
  const childrenMap = new Map<string, BudgetRow[]>();
  for (const row of rows) {
    const parent = row.code.length > 4 ? row.code.slice(0, -2) : "";
    const list = childrenMap.get(parent) ?? [];
    list.push(row);
    childrenMap.set(parent, list);
  }
  const out: BudgetTreeRow[] = [];
  const walk = (parentCode: string, guides: boolean[]) => {
    const children = childrenMap.get(parentCode) ?? [];
    children.forEach((row, index) => {
      const isLast = index === children.length - 1;
      const hasChildren = childrenMap.has(row.code);
      out.push({ row, guides, isLast, hasChildren });
      // 折叠节点不递归：内部已折叠的子树在展开父级时仍保持折叠
      if (hasChildren && !collapsed.includes(row.code)) walk(row.code, [...guides, !isLast]);
    });
  };
  walk("", []);
  return out;
};

function BudgetPanelDialog({ onClose }: { onClose: () => void }) {
  const [budgets, setBudgets] = useState<BudgetFile[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshJobId, setRefreshJobId] = useState("");
  const [viewProjectId, setViewProjectId] = useState("");
  const [collapsedCodes, setCollapsedCodes] = useState<string[]>([]);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/budgets");
      const body = await response.json() as { budgets?: BudgetFile[]; error?: string };
      if (!response.ok) throw new Error(body.error || "无法读取预算数据");
      setBudgets(body.budgets ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取预算数据");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!refreshJobId) return;
    const timer = window.setInterval(() => void (async () => {
      try {
        const response = await fetch(`/api/budgets-refresh-status?jobId=${encodeURIComponent(refreshJobId)}`);
        const status = await response.json() as { state?: string; error?: string };
        if (status.state === "running") return;
        window.clearInterval(timer);
        setRefreshJobId("");
        if (status.state === "failed") setError(status.error || "预算拉取失败");
        await load();
      } catch { /* 下一轮重试 */ }
    })(), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshJobId, load]);
  const startRefresh = async () => {
    setError("");
    try {
      const response = await fetch("/api/budgets-refresh", { method: "POST" });
      const body = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !body.jobId) throw new Error(body.error || "无法启动预算拉取");
      setRefreshJobId(body.jobId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "无法启动预算拉取");
    }
  };
  const refreshing = Boolean(refreshJobId);
  return <div className="dialog-backdrop ai-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className={`ai-settings-dialog budget-dialog ${viewProjectId ? "budget-dialog--detail" : ""}`} role="dialog" aria-modal="true" aria-labelledby="budget-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div>{viewProjectId && <button type="button" className="icon-button" title="返回项目列表" onClick={() => setViewProjectId("")}><ArrowLeft size={18} /></button>}<div><span>PROJECT BUDGET</span><h2 id="budget-title">{viewProjectId ? (budgets.find((budget) => budget.projectId === viewProjectId)?.projectName ?? "项目预算明细") : "项目预算表"}</h2></div></div><div className="dialog-header-actions"><button type="button" className="icon-button" title={refreshing ? "正在从财务系统拉取…" : "从财务系统重新拉取"} disabled={refreshing} onClick={() => void startRefresh()}>{refreshing ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />}</button><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></div></header>
      {loading && <p className="backend-status">读取预算数据中…</p>}
      {refreshing && <p className="backend-status">正在登录财务系统拉取最新预算（约半分钟）…</p>}
      {error && <p className="backend-status">{error}</p>}
      {!loading && !error && !budgets.length && <div className="budget-guide">
        <p>尚未拉取项目预算数据。</p>
        <ol>
          <li>在「用户资料」中保存学校 SSO 账号和密码</li>
          <li>运行拉取脚本：<code>python3 tools/fetch_budget.py</code></li>
        </ol>
        <p className="budget-guide-note">脚本自动登录财务系统 → 项目管理 → 项目查询 → 预算表（含子项目），数据存 <code>data/budgets/</code>。</p>
      </div>}
      {!budgets.length && !loading && !error && null}
      {viewProjectId && budgets.filter((budget) => budget.projectId === viewProjectId).map((budget) => <section key={budget.projectId} className="budget-project">
        <div className="budget-project-meta">
          <span className="budget-code-cell">{budget.projectId}</span>
          {(budget.projectInfo?.负责人 || budget.projectInfo?.负责人工号) && <span>负责人 {budget.projectInfo?.负责人 ?? "—"}{budget.projectInfo?.负责人工号 ? `（${budget.projectInfo.负责人工号}）` : ""}</span>}
          {budget.projectInfo?.所属部门 && <span>{budget.projectInfo.所属部门}</span>}
          {[budget.projectInfo?.项目类别, budget.projectInfo?.科研类型, budget.projectInfo?.经费类型].filter(Boolean).join(" · ") && <span>{[budget.projectInfo?.项目类别, budget.projectInfo?.科研类型, budget.projectInfo?.经费类型].filter(Boolean).join(" · ")}</span>}
          <span>抓取于 {budget.fetchedAt}</span>
        </div>
        <div className="budget-table-wrap">
          <table className="budget-table">
            <thead><tr><th className="budget-code-cell">代码</th><th>预算项</th><th>控制方式</th><th className="num">预算数</th><th className="num">支出数</th><th className="num" title="已被报销单占用、尚未支付的金额">冻结数</th><th className="num">余额</th><th title="红条 = 支出数 ÷ 预算数；黄条 = 冻结数 ÷ 预算数（已占用未支付）">执行率</th></tr></thead>
            <tbody>
              {buildBudgetTree(budget.rows, collapsedCodes).map(({ row, guides, isLast, hasChildren }) => {
                const collapsed = collapsedCodes.includes(row.code);
                return <tr key={row.code} className={guides.length === 0 ? "budget-summary-row" : undefined}>
                  <td className="budget-code-cell">{row.code}</td>
                  <td className="budget-name-cell" style={{ paddingLeft: `${12 + guides.length * 20}px` }}>
                    {hasChildren
                      ? <button type="button" className="tree-toggle" title={collapsed ? "展开子科目" : "收起子科目"} onClick={() => setCollapsedCodes((current) => current.includes(row.code) ? current.filter((code) => code !== row.code) : [...current, row.code])}>{collapsed ? "▸" : "▾"}</button>
                      : guides.length > 0 && <span className="tree-toggle-placeholder" />}
                    <i className="budget-level-dot" style={{ background: BUDGET_LEVEL_COLORS[Math.min(guides.length, BUDGET_LEVEL_COLORS.length - 1)] }} aria-hidden="true" />
                    {row.name}
                  </td>
                  <td>{row.control ? <span className={`budget-control ${row.control.includes("禁止") || row.control.includes("严") ? "strict" : "loose"}`}>{row.control}</span> : "—"}</td>
                  <td className="num">{formatBudgetAmount(row.budget)}</td>
                  <td className="num budget-num-spent">{formatBudgetAmount(row.spent)}</td>
                  <td className="num">{row.frozen ? <span className="budget-num-frozen">{formatBudgetAmount(row.frozen)}</span> : "—"}</td>
                  <td className="num">{formatBudgetAmount(row.balance)}</td>
                  <td>{row.executionRate === null && !row.frozen ? "—" : <span className="budget-rate" title={`已执行 ${Math.round((row.executionRate ?? 0) * 100)}% + 冻结 ${row.budget ? Math.round(((row.frozen ?? 0) / row.budget) * 100) : 0}%`}><span className="budget-rate-track"><span className="budget-rate-fill" style={{ width: `${Math.min(100, Math.round((row.executionRate ?? 0) * 100))}%` }} />{Boolean(row.frozen) && <span className="budget-rate-frozen" style={{ width: `${Math.min(100 - Math.min(100, Math.round((row.executionRate ?? 0) * 100)), Math.round(((row.frozen ?? 0) / (row.budget || 1)) * 100))}%` }} />}</span>{Math.round((row.executionRate ?? 0) * 100)}%</span>}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>)}
      {!viewProjectId && <div className="budget-project-list">
        {budgets.map((budget) => {
          const summary = budget.rows.find((row) => row.code === "A127") ?? budget.rows.find((row) => row.code === "A12702");
          return <button type="button" key={budget.projectId} className="budget-project-card" onClick={() => setViewProjectId(budget.projectId)}>
            <div className="budget-project-main"><strong>{budget.projectName}</strong><span>{[budget.projectId, budget.projectInfo?.负责人 && `负责人 ${budget.projectInfo.负责人}`, budget.projectInfo?.所属部门, budget.fetchedAt && `抓取于 ${budget.fetchedAt}`].filter(Boolean).join(" · ")}</span></div>
            {summary && <div className="budget-project-figures">
              <span>预算 {formatBudgetAmount(summary.budget)}</span>
              <span>已执行 {formatBudgetAmount(summary.spent)}</span>
              <span>余额 {formatBudgetAmount(summary.balance)}</span>
              {summary.executionRate !== null && <span className="budget-rate"><span className="budget-rate-track"><span className="budget-rate-fill" style={{ width: `${Math.min(100, Math.round(summary.executionRate * 100))}%` }} />{Boolean(summary.frozen) && <span className="budget-rate-frozen" style={{ width: `${Math.min(100 - Math.min(100, Math.round(summary.executionRate * 100)), Math.round(((summary.frozen ?? 0) / (summary.budget || 1)) * 100))}%` }} />}</span>{Math.round(summary.executionRate * 100)}%</span>}
            </div>}
          </button>;
        })}
      </div>}

    </section>
  </div>;
}

const DF_QUARTER_LABELS: Record<1 | 2 | 3 | 4, string> = { 1: "第一季度", 2: "第二季度", 3: "第三季度", 4: "第四季度" };
const formatDfAmount = (value: number) => value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** DF（党费）计算弹窗：季度/自定义月份范围 + 工资增量抓取 + 逐月计算与编辑。 */
function DfDialog({ onClose, showNotice }: { onClose: () => void; showNotice: (message: string) => void }) {
  const now = new Date();
  const [settings, setSettings] = useState<{ enabled: boolean; monthlySpecialDeduction: number; confirmedQuarters?: Record<string, string> }>({ enabled: true, monthlySpecialDeduction: DF_DEFAULT_SPECIAL_DEDUCTION, confirmedQuarters: {} });
  const [years, setYears] = useState<Record<string, Record<string, Record<string, number>>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [rangeMode, setRangeMode] = useState<"quarter" | "year" | "custom">("quarter");
  const [quarter, setQuarter] = useState<1 | 2 | 3 | 4>(currentQuarterKey(now));
  const [customStart, setCustomStart] = useState(1);
  const [customEnd, setCustomEnd] = useState(now.getMonth() + 1);
  const [fetchJobId, setFetchJobId] = useState("");
  const [fetchSummary, setFetchSummary] = useState("");
  const [expandedMonth, setExpandedMonth] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingMonth, setSavingMonth] = useState(false);
  const [deductionDraft, setDeductionDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/df");
      const body = await response.json() as { settings?: { enabled: boolean; monthlySpecialDeduction: number; confirmedQuarters?: Record<string, string> }; years?: Record<string, Record<string, Record<string, number>>>; error?: string };
      if (!response.ok) throw new Error(body.error || "无法读取 DF 数据");
      setSettings(body.settings ?? { enabled: true, monthlySpecialDeduction: DF_DEFAULT_SPECIAL_DEDUCTION, confirmedQuarters: {} });
      setDeductionDraft("");
      setYears(body.years ?? {});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取 DF 数据");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const refreshing = Boolean(fetchJobId);
  useEffect(() => {
    if (!fetchJobId) return;
    const timer = window.setInterval(() => void (async () => {
      try {
        const response = await fetch(`/api/df-refresh-status?jobId=${encodeURIComponent(fetchJobId)}`);
        const status = await response.json() as { state?: string; error?: string; log?: string };
        if (status.state === "running") return;
        window.clearInterval(timer);
        setFetchJobId("");
        if (status.state === "failed") { setError(status.error || "工资抓取失败"); return; }
        // 解析 fetch_salary.py 的 JSON 行进度生成摘要
        const events = (status.log ?? "").split("\n").flatMap((line) => {
          try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
        });
        const fetched = events.filter((event) => event.status === "fetched").map((event) => `${String(event.month).slice(5)}月`);
        const futureCount = events.filter((event) => event.status === "future").length;
        const empty = events.filter((event) => event.status === "empty").map((event) => `${String(event.month).slice(5)}月`);
        const failedCount = events.filter((event) => event.status === "failed").length;
        const skipped = Number(events.find((event) => event.done)?.skipped ?? 0);
        const parts = [
          fetched.length ? `已抓取 ${fetched.join("、")}` : "",
          skipped ? `已有数据跳过 ${skipped} 个月` : "",
          futureCount ? `未到发薪月的 ${futureCount} 个月已跳过` : "",
          empty.length ? `${empty.join("、")}暂无数据（可能未发薪）` : "",
          failedCount ? `${failedCount} 个月抓取失败` : "",
        ].filter(Boolean);
        setFetchSummary(parts.length ? parts.join("；") : "所选月份均已是最新数据");
        await load();
      } catch { /* 下一轮重试 */ }
    })(), 2_000);
    return () => window.clearInterval(timer);
  }, [fetchJobId, load]);

  const monthsOfRange = () => {
    const months = rangeMode === "year" ? Array.from({ length: 12 }, (_, index) => index + 1)
      : rangeMode === "quarter" ? quarterMonths(quarter)
        : Array.from({ length: Math.max(0, customEnd - customStart + 1) }, (_, index) => customStart + index);
    return months.map((month) => `${viewYear}-${String(month).padStart(2, "0")}`);
  };
  const rows = monthsOfRange().map((key) => {
    const [year, month] = key.split("-").map(Number);
    const values = years[String(year)]?.[String(month)];
    return { key, year, month, future: isFutureMonth(year, month, now), values, result: values && !isFutureMonth(year, month, now) ? calculateDfMonth(values, settings.monthlySpecialDeduction) : null };
  });
  // 未来月工资单不存在，即便数据文件有残留也不计入合计
  const totalDf = rows.reduce((sum, row) => sum + (row.result?.dfAmount ?? 0), 0);
  // 浏览季度的交费确认（quarter 模式）：勾选状态来自 settings.confirmedQuarters
  const browseQuarter = rangeMode === "quarter" ? {
    key: quarterKeyOf(viewYear, quarter),
    lastMonth: quarterMonths(quarter)[2],
    open: isQuarterConfirmationOpen(viewYear, quarter),
    confirmed: Boolean(settings.confirmedQuarters?.[quarterKeyOf(viewYear, quarter)]),
  } : null;

  const startRefresh = async () => {
    setError("");
    setFetchSummary("");
    try {
      // 未来发薪月工资单不存在，不发起抓取（财务系统对未来月会残留当前数据）
      const months = monthsOfRange().filter((key) => {
        const [year, month] = key.split("-").map(Number);
        return !isFutureMonth(year, month, now);
      });
      if (!months.length) { setError("所选月份均未到发薪月，无需抓取"); return; }
      const response = await fetch("/api/df-refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ months }) });
      const body = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !body.jobId) throw new Error(body.error || "无法启动工资抓取");
      setFetchJobId(body.jobId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "无法启动工资抓取");
    }
  };

  const beginEdit = (row: { key: string; values?: Record<string, number> }) => {
    setExpandedMonth(row.key);
    const base = Object.fromEntries([...DF_INCOME_FIELDS, ...DF_DEDUCTION_FIELDS].map((field) => [field, ""]));
    setDraft({ ...base, ...Object.fromEntries(Object.entries(row.values ?? {}).map(([field, value]) => [field, String(value)])) });
  };
  const saveMonth = async () => {
    const [year, month] = expandedMonth.split("-").map(Number);
    const original = years[String(year)]?.[String(month)] ?? {};
    // 保留编辑面板外的记录字段（交通费补贴等），空输入 = 删除该字段
    const values: Record<string, number> = { ...original };
    for (const [field, raw] of Object.entries(draft)) {
      if (raw.trim() === "") delete values[field];
      else {
        const num = Number(raw);
        if (Number.isFinite(num)) values[field] = num;
      }
    }
    setSavingMonth(true);
    try {
      const response = await fetch("/api/df/month", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ year, month, values }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "保存失败");
      setExpandedMonth("");
      await load();
      showNotice(`${year} 年 ${month} 月工资数据已保存`);
    } catch (saveError) {
      showNotice(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSavingMonth(false);
    }
  };
  const saveDeduction = async () => {
    const value = Number(deductionDraft);
    if (deductionDraft === "" || !Number.isFinite(value) || value < 0) { showNotice("专项附加扣除应为非负数字"); return; }
    try {
      const response = await fetch("/api/df/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlySpecialDeduction: value }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "保存失败");
      await load();
      showNotice("专项附加扣除已保存，计算已更新");
    } catch (saveError) {
      showNotice(saveError instanceof Error ? saveError.message : "保存失败");
    }
  };
  // 功能开关：仅隐藏 DF 功能内容（dock 入口保留），供不需要此功能的成员停用
  const toggleEnabled = async () => {
    try {
      const response = await fetch("/api/df/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !settings.enabled }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "保存失败");
      setSettings((current) => ({ ...current, enabled: !current.enabled }));
      showNotice(settings.enabled ? "DF 计算已停用（数据保留，可随时开启）" : "DF 计算已开启");
    } catch (toggleError) {
      showNotice(toggleError instanceof Error ? toggleError.message : "操作失败");
    }
  };
  // 季度交费确认：勾选记录到 settings.confirmedQuarters（"2026-Q3" → ISO 时间）
  const confirmQuarter = async (key: string, confirmed: boolean) => {
    try {
      const response = await fetch("/api/df/confirm-quarter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quarter: key, confirmed }) });
      const body = await response.json() as { confirmedQuarters?: Record<string, string>; error?: string };
      if (!response.ok) throw new Error(body.error ?? "保存失败");
      setSettings((current) => ({ ...current, confirmedQuarters: body.confirmedQuarters ?? current.confirmedQuarters }));
      showNotice(confirmed ? `${key.replace("-Q", " 年第 ")} 季度已确认交费` : `${key.replace("-Q", " 年第 ")} 季度交费确认已取消`);
    } catch (confirmError) {
      showNotice(confirmError instanceof Error ? confirmError.message : "操作失败");
    }
  };

  const yearOptions = [...new Set([now.getFullYear(), viewYear, ...Object.keys(years).map(Number)])].sort((a, b) => b - a);
  const expandedRow = rows.find((row) => row.key === expandedMonth);
  return <div className="dialog-backdrop ai-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ai-settings-dialog df-dialog" role="dialog" aria-modal="true" aria-labelledby="df-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>MONTHLY DANGFEI</span><h2 id="df-title">DF 计算
          <label className="df-toggle" title={settings.enabled ? "停用 DF 功能（数据保留）" : "启用 DF 功能"}>
            <input type="checkbox" checked={settings.enabled} onChange={() => void toggleEnabled()} />
            <span className="df-toggle-track"><span className="df-toggle-thumb" /></span>
          </label>
        </h2></div>
        <div className="dialog-header-actions">
          <button type="button" className="icon-button" title={refreshing ? "正在增量抓取工资…" : "抓取所选月份缺失的工资数据并重新计算"} disabled={refreshing || !settings.enabled} onClick={() => void startRefresh()}>{refreshing ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />}</button>
          <button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button>
        </div>
      </header>
      {loading && <p className="backend-status">读取工资数据中…</p>}
      {!loading && !settings.enabled && <div className="df-disabled-panel">
        <p>DF 计算功能已停用——工资数据仍保留在本机，拨动标题旁滑块即可重新开启。</p>
      </div>}
      {!loading && settings.enabled && <>
      <div className="df-range-row">
        <label>年份
          <select value={viewYear} onChange={(event) => setViewYear(Number(event.target.value))}>{yearOptions.map((year) => <option key={year} value={year}>{year} 年</option>)}</select>
        </label>
        <label>范围
          <select value={rangeMode} onChange={(event) => setRangeMode(event.target.value as typeof rangeMode)}>
            <option value="quarter">按季度</option>
            <option value="year">全年</option>
            <option value="custom">自定义月份</option>
          </select>
        </label>
        {rangeMode === "quarter" && <label>季度
          <select value={quarter} onChange={(event) => setQuarter(Number(event.target.value) as 1 | 2 | 3 | 4)}>{([1, 2, 3, 4] as const).map((item) => <option key={item} value={item}>{DF_QUARTER_LABELS[item]}</option>)}</select>
        </label>}
        {rangeMode === "custom" && <>
          <label>起始月
            <select value={customStart} onChange={(event) => setCustomStart(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{month} 月</option>)}</select>
          </label>
          <label>结束月
            <select value={customEnd} onChange={(event) => setCustomEnd(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{month} 月</option>)}</select>
          </label>
        </>}
      </div>
      {loading && <p className="backend-status">读取工资数据中…</p>}
      {refreshing && <p className="backend-status">正在登录财务系统增量抓取所选月份工资（每月约十余秒）…</p>}
      {fetchSummary && !refreshing && <p className="backend-status">{fetchSummary}。</p>}
      {error && <p className="backend-error">{error}</p>}
      {!loading && <div className="df-table-wrap">
        <table className="df-table">
          <thead><tr><th>月份</th><th className="num">月收入合计</th><th className="num">月均个税</th><th className="num">月DF基数</th><th className="num">比例</th><th className="num">应交DF</th><th aria-label="操作" /></tr></thead>
          <tbody>
            {rows.map((row) => expandedMonth === row.key ? <tr key={row.key} className="df-edit-row"><td colSpan={7}>
              <div className="df-edit-head"><strong>{row.month} 月工资明细</strong><span>空 = 清除该字段；其余记录字段（交通费补贴等）自动保留</span></div>
              <div className="df-edit-grid">
                {[...DF_INCOME_FIELDS, ...DF_DEDUCTION_FIELDS].map((field) => <label key={field}>{field}
                  <input value={draft[field] ?? ""} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} />
                </label>)}
              </div>
              <div className="df-edit-actions">
                <button type="button" className="quiet-button" onClick={() => setExpandedMonth("")}>取消</button>
                <button type="button" className="create-button" disabled={savingMonth} onClick={() => void saveMonth()}>保存</button>
              </div>
            </td></tr>
              : <tr key={row.key} onClick={() => beginEdit(row)} title="点击编辑工资明细">
                <td>{row.month} 月</td>
                {row.result ? <>
                  <td className="num">{formatDfAmount(row.result.monthlyIncome)}</td>
                  <td className="num">{formatDfAmount(row.result.monthlyTax)}</td>
                  <td className="num">{formatDfAmount(row.result.dfBase)}</td>
                  <td className="num">{(row.result.rate * 100).toFixed(1)}%</td>
                  <td className="num df-amount"><strong>{row.result.dfAmount}</strong> 元</td>
                </> : <td colSpan={5} className="df-missing">{row.future ? "未到发薪月 —— 工资单生成后自动可算" : "未抓取 —— 点击「刷新」从财务系统补齐"}</td>}
                <td className="df-row-action"><FilePenLine size={14} /></td>
              </tr>)}
          </tbody>
          <tfoot><tr><td><span className="df-total-label">合计</span>{browseQuarter && (browseQuarter.open
            ? <label className="df-confirm-check" title={browseQuarter.confirmed ? "再次点击取消确认" : "确认本季度 DF 已交"}><input type="checkbox" checked={browseQuarter.confirmed} onChange={(event) => void confirmQuarter(browseQuarter.key, event.target.checked)} />确认已交</label>
            : <span className="df-confirm-wait" title="季度最后一个月 7 号开启交费确认">{browseQuarter.lastMonth} 月 7 日开启确认</span>)}</td><td colSpan={4} /><td className="num df-amount"><strong>{totalDf}</strong> 元</td><td /></tr></tfoot>
        </table>
      </div>}
      <div className="df-deduction-row">
        <label>专项附加扣除（元/月）
          <input value={deductionDraft} placeholder={String(settings.monthlySpecialDeduction)} inputMode="decimal" onChange={(event) => setDeductionDraft(event.target.value)} />
        </label>
        <button type="button" className="quiet-button" disabled={deductionDraft === ""} onClick={() => void saveDeduction()}>保存扣除并重算</button>
      </div>
      <p className="df-formula-note">月度计算：收入合计（岗位/薪级/初见期/年薪津贴/沪岗贴/岗贴/基本津贴）→ 年度计税基数 = 收入×12 − 6万 − 专项附加×12，月均个税摊回 → 月DF基数 = 收入 − 公积金÷2 − 年金 − 三险 − 月均个税 → 按基数区间取 0.5%/1%/1.5%/2% 比例，取整为月应交 DF。</p>
      </>}
    </section>
  </div>;
}

const LABOR_DEGREE_OPTIONS = ["硕", "博", "其他"] as const;

/** 实验室学生津贴发放弹窗：名单管理 + 月度发放表生成（xlsx 到 ~/Downloads）+ 确认已发。 */
function LaborDialog({ onClose, showNotice }: { onClose: () => void; showNotice: (message: string) => void }) {
  const now = new Date();
  const [enabled, setEnabled] = useState(true);
  const [ownerName, setOwnerName] = useState("");
  const [members, setMembers] = useState<LaborMember[]>([]);
  const [months, setMonths] = useState<Record<string, { generatedAt?: string; confirmedAt?: string; rows?: Array<{ name: string; amount: number }> }>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1);
  const [rosterDirty, setRosterDirty] = useState(false);

  const monthKey = laborMonthKey(viewYear, viewMonth);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/labor");
      const body = await response.json() as { settings?: { enabled: boolean; ownerName: string }; members?: LaborMember[]; months?: Record<string, { generatedAt?: string; confirmedAt?: string }>; error?: string };
      if (!response.ok) throw new Error(body.error || "无法读取学生津贴数据");
      setEnabled(body.settings?.enabled ?? true);
      setOwnerName(body.settings?.ownerName ?? "");
      setMembers(body.members ?? []);
      setMonths(body.months ?? {});
      setRosterDirty(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取学生津贴数据");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const record = months[monthKey];
  const total = members.reduce((sum, member) => sum + (Number.isFinite(member.amount) ? member.amount : 0), 0);

  const toggleEnabled = async () => {
    try {
      const response = await fetch("/api/labor/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "保存失败");
      setEnabled((current) => !current);
      showNotice(enabled ? "学生津贴功能已停用（数据保留，可随时开启）" : "学生津贴功能已开启");
    } catch (toggleError) {
      showNotice(toggleError instanceof Error ? toggleError.message : "操作失败");
    }
  };
  const updateMember = (id: string, patch: Partial<LaborMember>) => {
    setRosterDirty(true);
    setMembers((current) => current.map((member) => member.id === id ? { ...member, ...patch } : member));
  };
  const addMember = () => {
    setRosterDirty(true);
    setMembers((current) => [...current, newLaborMember()]);
  };
  const removeMember = (id: string) => {
    setRosterDirty(true);
    setMembers((current) => current.filter((member) => member.id !== id));
  };
  const saveRoster = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/labor/roster", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ members }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "保存失败");
      await load();
      showNotice(`名单已保存（${members.filter((member) => member.name.trim()).length} 人）${record?.generatedAt ? "；已生成的表格如需同步请重新生成" : ""}`);
    } catch (saveError) {
      showNotice(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const generate = async () => {
    if (rosterDirty) await saveRoster();
    setGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/labor/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: monthKey }) });
      const body = await response.json() as { ok?: boolean; path?: string; total?: number; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? "生成失败");
      await load();
      showNotice(`发放表已生成：${body.path ?? ""}（合计 ${body.total ?? 0} 元），可用微信发送财务`);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };
  const confirmMonth = async (confirmed: boolean) => {
    try {
      const response = await fetch("/api/labor/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: monthKey, confirmed }) });
      const body = await response.json() as { months?: Record<string, { generatedAt?: string; confirmedAt?: string }>; error?: string };
      if (!response.ok) throw new Error(body.error ?? "保存失败");
      setMonths(body.months ?? {});
      showNotice(confirmed ? `${monthKey} 学生津贴已确认发送` : `${monthKey} 确认已取消`);
    } catch (confirmError) {
      showNotice(confirmError instanceof Error ? confirmError.message : "操作失败");
    }
  };

  const confirmed = Boolean(record?.confirmedAt);
  return <div className="dialog-backdrop ai-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ai-settings-dialog df-dialog labor-dialog" role="dialog" aria-modal="true" aria-labelledby="labor-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>MONTHLY LABOR FEE</span><h2 id="labor-title">学生津贴
          <label className="df-toggle" title={enabled ? "停用学生津贴功能（数据保留）" : "启用学生津贴功能"}>
            <input type="checkbox" checked={enabled} onChange={() => void toggleEnabled()} />
            <span className="df-toggle-track"><span className="df-toggle-thumb" /></span>
          </label>
        </h2></div>
        <div className="dialog-header-actions">
          <button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button>
        </div>
      </header>
      {loading && <p className="backend-status">读取学生津贴数据中…</p>}
      {generating && <p className="backend-status">正在生成发放表（xlsx → Downloads）…</p>}
      {error && <p className="backend-error">{error}</p>}
      {!loading && !enabled && <div className="df-disabled-panel">
        <p>学生津贴功能已停用——名单与发放记录仍保留在本机，拨动标题旁滑块即可重新开启。</p>
      </div>}
      {!loading && enabled && <>
      <div className="df-range-row">
        <label>年份
          <select value={viewYear} onChange={(event) => setViewYear(Number(event.target.value))}>{[now.getFullYear(), now.getFullYear() + 1].map((year) => <option key={year} value={year}>{year} 年</option>)}</select>
        </label>
        <label>月份
          <select value={viewMonth} onChange={(event) => setViewMonth(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{month} 月</option>)}</select>
        </label>
        <span className={`labor-status-chip${record?.generatedAt ? " ok" : ""}`}>{record?.generatedAt ? `表格已生成（${record.generatedAt.slice(0, 10)}）` : "当月表格未生成"}</span>
      </div>
      <div className="labor-table-wrap">
        <table className="df-table labor-table">
          <thead><tr><th>姓名</th><th>硕/博</th><th>学号</th><th>工作内容</th><th className="num">津贴（元）</th><th>备注</th><th aria-label="操作" /></tr></thead>
          <tbody>
            {members.map((member) => <tr key={member.id}>
              <td><input className="labor-input" value={member.name} placeholder="姓名" onChange={(event) => updateMember(member.id, { name: event.target.value })} /></td>
              <td><select className="labor-input labor-input--degree" value={member.degree} onChange={(event) => updateMember(member.id, { degree: event.target.value })}>{LABOR_DEGREE_OPTIONS.map((degree) => <option key={degree} value={degree}>{degree}</option>)}</select></td>
              <td><input className="labor-input" value={member.studentId} placeholder="学号" inputMode="numeric" onChange={(event) => updateMember(member.id, { studentId: event.target.value.replace(/\D/g, "") })} /></td>
              <td><input className="labor-input labor-input--wide" value={member.workContent} placeholder="工作内容" onChange={(event) => updateMember(member.id, { workContent: event.target.value })} /></td>
              <td className="num"><input className="labor-input labor-input--amount" value={String(member.amount)} inputMode="decimal" onChange={(event) => updateMember(member.id, { amount: Number(event.target.value) })} /></td>
              <td><input className="labor-input" value={member.note ?? ""} placeholder="备注（可选）" onChange={(event) => updateMember(member.id, { note: event.target.value })} /></td>
              <td className="df-row-action"><button type="button" className="icon-button" title="删除该成员" onClick={() => removeMember(member.id)}><Trash2 size={14} /></button></td>
            </tr>)}
            {!members.length && <tr><td colSpan={7} className="df-missing">名单为空——点击下方「添加人员」开始</td></tr>}
          </tbody>
          <tfoot><tr>
            <td colSpan={4}>
              <span className="df-total-label">{members.filter((member) => member.name.trim()).length} 人 · 合计</span>
              {record?.generatedAt && <label className="df-confirm-check" title={confirmed ? "再次点击取消确认" : "确认已用微信发送财务"}><input type="checkbox" checked={confirmed} onChange={(event) => void confirmMonth(event.target.checked)} />确认已发</label>}
            </td>
            <td className="num df-amount"><strong>{total}</strong> 元</td>
            <td colSpan={2} />
          </tr></tfoot>
        </table>
      </div>
      <div className="labor-actions-row">
        <button type="button" className="quiet-button" onClick={addMember}><Plus size={14} /> 添加人员</button>
        <button type="button" className="quiet-button" disabled={saving || !rosterDirty} onClick={() => void saveRoster()}>{rosterDirty ? "保存名单" : "名单已保存"}</button>
        <span className="labor-hint">导师列与文件名自动使用用户档案姓名{ownerName ? `（${ownerName}）` : ""}。</span>
        <button type="button" className="create-button" disabled={generating} onClick={() => void generate()}>{generating ? <><LoaderCircle size={15} className="spin" /> 正在生成…</> : <><Download size={15} /> 下载表格</>}</button>
      </div>
      </>}
    </section>
  </div>;
}

function AiSettingsDialog({ settings, onClose, onSave, onTestSuccess }: { settings: AiSettings; onClose: () => void; onSave: (settings: AiSettings, apiKey: string) => Promise<void>; onTestSuccess: (test: AiBackendTest) => void }) {
  const [backend, setBackend] = useState<AiBackend>(settings.backend);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.apiBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [cliVersion, setCliVersion] = useState("");
  const [opencodeVersion, setOpencodeVersion] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [modelCache, setModelCache] = useState(() => loadCachedAiModels());
  const [modelsLoading, setModelsLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testProgress, setTestProgress] = useState<{ stages: Array<{ key: string; pass: boolean | null; detail: string }>; cases: Array<{ id: string; expect: string; actual: string; pass: boolean; group?: string }> }>({ stages: [], cases: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/ai-backend-status").then(async (response) => {
      if (!response.ok) return;
      const status = (await response.json()) as { cliVersion?: string; opencodeVersion?: string; apiKeyConfigured?: boolean };
      setCliVersion(status.cliVersion ?? "");
      setOpencodeVersion(status.opencodeVersion ?? "");
      setApiKeyConfigured(Boolean(status.apiKeyConfigured));
    }).catch(() => undefined);
  }, []);

  const modelOptions = backend === "off" ? AI_MODEL_OPTIONS : modelCache[backend] ?? AI_MODEL_OPTIONS;

  const refreshModels = async () => {
    if (backend === "off") return;
    setModelsLoading(true);
    setError("");
    try {
      const query = backend === "api" && baseUrl.trim() ? `&baseUrl=${encodeURIComponent(baseUrl.trim().replace(/\/+$/, ""))}` : "";
      const response = await fetch(`/api/ai-models?backend=${backend}${query}`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "无法获取模型列表");
      }
      const payload = (await response.json()) as { models?: Array<{ id: string; ownedBy?: string; description?: string }> };
      const available = (payload.models ?? []).map((model) => ({ value: model.id, label: (model.description || model.ownedBy) ? `${model.id} · ${model.description || model.ownedBy}` : model.id }));
      const nextOptions = [{ value: "", label: "使用后端默认（推荐）" }, ...available];
      saveCachedAiModels(backend, nextOptions);
      setModelCache(loadCachedAiModels());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法获取模型列表");
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const save = async () => {
    setSaving(true);
    setError("");
    try { await onSave({ backend, model: model.trim(), apiBaseUrl: backend === "api" ? baseUrl.trim().replace(/\/+$/, "") : "" }, apiKey.trim()); onClose(); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "保存失败"); } finally { setSaving(false); }
  };
  const testBackend = async () => {
    setTesting(true); setError(""); setTestResult(""); setTestProgress({ stages: [], cases: [] });
    try {
      const response = await fetch("/api/ai-backend-test-stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ backend, model: model.trim(), baseUrl: backend === "api" ? baseUrl.trim().replace(/\/+$/, "") : "" }) });
      if (!response.ok || !response.body) throw new Error("测试服务不可用");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalMessage = "";
      const stages: Array<{ key: string; pass: boolean | null; detail: string }> = [];
      const cases: Array<{ id: string; expect: string; actual: string; pass: boolean; group?: string }> = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(chunk.slice(6)) as { type: string; payload: never };
            if (event.type === "stage") {
              const { key, pass, detail } = event.payload as { key: string; pass: boolean | null; detail: string };
              const existing = stages.findIndex((item) => item.key === key);
              if (existing >= 0) stages[existing] = { key, pass, detail }; else stages.push({ key, pass, detail });
            } else if (event.type === "case") {
              cases.push(event.payload as { id: string; expect: string; actual: string; pass: boolean });
            } else if (event.type === "error") {
              throw new Error((event.payload as { message?: string }).message ?? "后端测试失败");
            } else if (event.type === "done") {
              const summary = event.payload as { overallOk?: boolean };
              finalMessage = summary.overallOk ? "三级测试全部通过" : "存在未通过项，详见下方结果";
            }
          } catch (parseError) { if (parseError instanceof Error && parseError.message !== "Unexpected end of JSON input") throw parseError; }
          setTestProgress({ stages: [...stages], cases: [...cases] });
        }
      }
      // 汇总 message
      const businessStage = stages.find((item) => item.key === "business");
      const visionStage = stages.find((item) => item.key === "vision");
      finalMessage = ["连通 ✓", visionStage?.pass ? "视觉 ✓" : `视觉 ✗（${visionStage?.detail ?? ""}）`, businessStage ? `业务 ${businessStage.detail}` : ""].filter(Boolean).join(" · ");
      setTestResult(finalMessage);
      onTestSuccess({ backend, model: model.trim() });
    } catch (testError) { setError(testError instanceof Error ? testError.message : "后端测试失败"); } finally { setTesting(false); }
  };

  return <div className="dialog-backdrop ai-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>AI BACKEND</span><h2 id="ai-settings-title">识别后端</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <div className="backend-switch" role="group" aria-label="识别后端选择">
        <button type="button" className={backend === "off" ? "selected" : ""} onClick={() => setBackend("off")}>关闭</button>
        <button type="button" className={backend === "api" ? "selected" : ""} onClick={() => setBackend("api")}>API 直连</button>
        <button type="button" className={backend === "codex" ? "selected" : ""} onClick={() => setBackend("codex")}>Codex CLI</button>
        <button type="button" className={backend === "opencode" ? "selected" : ""} onClick={() => setBackend("opencode")}>OpenCode CLI</button>
      </div>
      {backend === "api" && <label>API Key（服务商任意）<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiKeyConfigured ? "已保存；留空则不改动" : "粘贴 API Key"} autoComplete="off" /></label>}
      {backend === "api" && <label>API 端点（OpenAI 兼容）<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="留空按 Key 前缀自动识别（OpenAI / 智谱）" list="api-base-url-presets" autoComplete="off" /><datalist id="api-base-url-presets">{API_BASE_URL_PRESETS.map((preset) => <option key={preset} value={preset} />)}</datalist></label>}
      {backend !== "off" && <div className="model-field"><label>模型<select value={model} disabled={modelsLoading} onChange={(event) => setModel(event.target.value)}>{!modelOptions.some((option) => option.value === model) && <option value={model}>{model}</option>}{modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button type="button" className="quiet-button model-refresh" disabled={modelsLoading} onClick={() => void refreshModels()}>{modelsLoading ? "获取中" : "获取列表"}</button></div>}
      {backend === "codex" && <p className="backend-status">{cliVersion ? `已检测到 ${cliVersion}；点击“获取列表”将读取 Codex 当前模型目录，失败时保留上次缓存。` : "未检测到可用的 Codex CLI"}</p>}
      {backend === "opencode" && <p className="backend-status">{opencodeVersion ? `已检测到 opencode ${opencodeVersion}；复用 ~/.config/opencode 的模型与凭证，点击“获取列表”读取已配置 provider 的模型。票据图片识别请选择带视觉能力的模型（如 zhipuai-coding-plan/glm-4.6v）。` : "未检测到可用的 opencode CLI"}</p>}
      {backend === "api" && <p className="backend-status">密钥保存在本机的系统加密存储；可接入 OpenAI 兼容服务商（OpenAI、智谱、DeepSeek、Moonshot、本地 Ollama 等）。</p>}
      {backend !== "off" && <button type="button" className="quiet-button backend-test" disabled={testing} onClick={() => void testBackend()}>{testing ? "测试中…" : "测试当前配置"}</button>}
      {(testing || testProgress.stages.length > 0) && <div className="backend-progress">
        <div className="progress-stages">
          {[["connectivity", "连通性"], ["vision", "视觉能力"], ["business", "业务准确率"]].map(([key, label]) => {
            const stage = testProgress.stages.find((item) => item.key === key);
            if (!stage) return null;
            return (
              <div key={key} className={`progress-stage ${stage.pass === true ? "is-pass" : stage.pass === false ? "is-fail" : "is-running"}`}>
                <span className="progress-stage-mark">{stage.pass === true ? "✓" : stage.pass === false ? "✗" : <span className="progress-spinner" />}</span>
                <span className="progress-stage-label">{label}</span>
                <span className="progress-stage-detail">{stage.detail}</span>
              </div>
            );
          })}
          {testing && !testProgress.stages.some((item) => item.key === "connectivity") && <div className="progress-stage is-running"><span className="progress-stage-mark"><span className="progress-spinner" /></span><span className="progress-stage-label">连通性</span><span className="progress-stage-detail">请求模型中…</span></div>}
        </div>
        {testProgress.cases.length > 0 && (
          <ul className="progress-cases">
            {testProgress.cases.map((item) => (
              <li key={item.id} className={`progress-case ${item.pass ? "is-pass" : "is-fail"}`}>
                <span className="progress-case-mark">{item.pass ? "✓" : "✗"}</span>
                <span className="progress-case-id" title={item.id}>{item.id}</span>
                <span className="progress-case-flow">{item.expect} → {item.actual}</span>
              </li>
            ))}
            {testing && <li className="progress-case is-running"><span className="progress-spinner" /><span>正在运行下一用例…</span></li>}
          </ul>
        )}
        {!testing && testResult && <p className="backend-status">{testResult}</p>}
      </div>}
      {!testing && testProgress.stages.length === 0 && testResult && <p className="backend-status">{testResult}</p>}
      {error && <p className="backend-error">{error}</p>}
      <footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="create-button" disabled={saving} onClick={() => void save()}>{saving ? "保存中" : "保存"}</button></footer>
    </section>
  </div>;
}

type ProfileTab = "identity" | "invoice" | "membership" | "systems";

function UserProfilesDialog({ profiles, activeId, onClose, onCreate, onEdit }: { profiles: UserProfileRecord[]; activeId: string; onClose: () => void; onCreate: () => void; onEdit: (id: string) => void }) {
  useEffect(() => { const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previousOverflow; }; }, []);
  return <div className="dialog-backdrop profile-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="profiles-dialog" role="dialog" aria-modal="true" aria-labelledby="profiles-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>USER DIRECTORY</span><h2 id="profiles-title">已录入用户</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <div className="profiles-list">{profiles.length ? profiles.map((record) => <button type="button" key={record.id} className={record.id === activeId ? "active" : ""} onClick={() => onEdit(record.id)}><b className="profile-avatar">{record.profile.avatar}</b><strong>{userProfileLabel(record)}</strong><span>{record.profile.englishName || "未填写英文名"}</span><i>{record.id === activeId ? "当前用户" : "查看资料"}</i></button>) : <p>尚未录入用户信息。</p>}</div>
      <footer><button type="button" className="quiet-button" onClick={onClose}>关闭</button><button type="button" className="create-button" onClick={onCreate}><Plus size={16} /> 添加用户</button></footer>
    </section>
  </div>;
}

function UserProfileDialog({ profileId, profile, onClose, onSave, onNotice }: { profileId: string; profile: UserProfile; onClose: () => void; onSave: (profile: UserProfile, schoolSsoPassword: string, signature: File | null) => Promise<void>; onNotice: (message: string) => void }) {
  const [draft, setDraft] = useState<UserProfile>(profile);
  const [tab, setTab] = useState<ProfileTab>("identity");
  const [schoolSsoPassword, setSchoolSsoPassword] = useState("");
  const [signature, setSignature] = useState<File | null>(null);
  const [credentialStatus, setCredentialStatus] = useState({ schoolSsoConfigured: false });
  const [browserRuntime, setBrowserRuntime] = useState({ executablePath: "", source: "none", customAvailable: false, managedAvailable: false, installing: false, installError: "", browserName: "", browserVersion: "" });
  const [browserPath, setBrowserPath] = useState("");
  const [browserCandidates, setBrowserCandidates] = useState<Array<{ label: string; executablePath: string }>>([]);
  const [browserValidation, setBrowserValidation] = useState("");
  const [browserValidationState, setBrowserValidationState] = useState<"idle" | "success" | "failed">("idle");
  const [browserRuntimeBusy, setBrowserRuntimeBusy] = useState(false);
  const [ssoValidation, setSsoValidation] = useState("");
  const [ssoValidationState, setSsoValidationState] = useState<"idle" | "success" | "failed" | "warning">(profile.schoolSsoVerifiedAt ? "success" : "idle");
  const [ssoVerifying, setSsoVerifying] = useState(false);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipName, setMembershipName] = useState("");
  const [membershipWebsite, setMembershipWebsite] = useState("");
  const [membershipParentName, setMembershipParentName] = useState("");
  const [membershipNumber, setMembershipNumber] = useState("");
  const [membershipLevel, setMembershipLevel] = useState("");
  const [membershipEffectiveDate, setMembershipEffectiveDate] = useState("");
  const [membershipValidUntil, setMembershipValidUntil] = useState("");
  const membershipInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { fetch(`/api/user-credential-status?profileId=${encodeURIComponent(profileId)}`).then(async (response) => response.ok ? setCredentialStatus(await response.json() as { schoolSsoConfigured: boolean }) : undefined).catch(() => undefined); }, [profileId]);
  const loadBrowserRuntime = async () => { const response = await fetch("/api/browser-runtime"); if (!response.ok) return; const runtime = await response.json() as typeof browserRuntime; setBrowserRuntime(runtime); setBrowserPath(runtime.executablePath); setBrowserValidationState(runtime.source === "none" ? "idle" : "success"); };
  useEffect(() => { void loadBrowserRuntime(); }, []);
  useEffect(() => { if (!browserRuntime.installing) return; const timer = window.setInterval(() => { void loadBrowserRuntime(); }, 1_500); return () => window.clearInterval(timer); }, [browserRuntime.installing]);
  useEffect(() => { const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previousOverflow; }; }, []);
  const setField = (field: keyof UserProfile, value: string) => {
    if (field === "schoolSsoAccount" && value !== draft.schoolSsoAccount) {
      setSsoValidationState("idle");
      setSsoValidation("");
      setDraft((current) => ({ ...current, schoolSsoAccount: value, schoolSsoVerifiedAt: "", employeeId: "", organization: "" }));
      return;
    }
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const addMembership = () => {
    const organization = membershipName.trim();
    if (!organization) return;
    const parentName = membershipParentName.trim();
    const parent = draft.memberships.find((membership) => !membership.parentId && membership.organization === parentName);
    setDraft((current) => ({ ...current, memberships: [...current.memberships, { id: `manual-${Date.now()}`, organization, website: membershipWebsite.trim(), parentId: parent?.id ?? "", parentName: parent ? "" : parentName, number: membershipNumber.trim(), level: membershipLevel.trim(), status: "", effectiveDate: membershipEffectiveDate, validUntil: membershipValidUntil }] }));
    setMembershipName("");
    setMembershipWebsite("");
    setMembershipParentName("");
    setMembershipNumber("");
    setMembershipLevel("");
    setMembershipEffectiveDate("");
    setMembershipValidUntil("");
  };
  const verifySchoolSso = async () => {
    setSsoVerifying(true);
    setSsoValidation("");
    setSsoValidationState("idle");
    try {
      const response = await fetch(`/api/verify-school-sso?profileId=${encodeURIComponent(profileId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schoolSsoAccount: draft.schoolSsoAccount }) });
      const payload = (await response.json()) as { error?: string; validation?: { state?: "success" | "failed" | "requires_interaction" | "missing_account"; message?: string; identity?: { employeeId?: string; organization?: string } } };
      if (!response.ok) throw new Error(payload.error ?? "学校 SSO 验证失败");
      const message = payload.validation?.message ?? "学校 SSO 验证完成";
      setSsoValidation(message);
      setSsoValidationState(payload.validation?.state === "success" ? "success" : payload.validation?.state === "requires_interaction" ? "warning" : "failed");
      if (payload.validation?.state === "success") {
        const identity = payload.validation.identity;
        const nextProfile = { ...draft, employeeId: identity?.employeeId || draft.schoolSsoAccount, organization: identity?.organization || draft.organization, schoolSsoVerifiedAt: new Date().toISOString() };
        setDraft(nextProfile);
        await onSave(nextProfile, "", null);
      }
      return message;
    } catch (validationError) {
      const message = validationError instanceof Error ? validationError.message : "学校 SSO 验证失败";
      setSsoValidation(message);
      setSsoValidationState("failed");
      return message;
    } finally {
      setSsoVerifying(false);
    }
  };
  const saveBrowserPath = async (nextPath = browserPath) => { setBrowserRuntimeBusy(true); setBrowserValidationState("idle"); try { const response = await fetch("/api/browser-runtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executablePath: nextPath }) }); const payload = await response.json() as typeof browserRuntime & { validation?: { available?: boolean; message?: string }; error?: string }; if (!response.ok) throw new Error(payload.error ?? "无法保存浏览器路径"); setBrowserRuntime(payload); setBrowserPath(payload.executablePath); setBrowserValidation(payload.validation?.message ?? ""); setBrowserValidationState(payload.validation?.available ? "success" : "failed"); } catch (runtimeError) { setError(runtimeError instanceof Error ? runtimeError.message : "无法保存浏览器路径"); setBrowserValidationState("failed"); } finally { setBrowserRuntimeBusy(false); } };
  const pickBrowserPath = async () => { setBrowserRuntimeBusy(true); try { const response = await fetch("/api/browser-runtime/pick", { method: "POST" }); const payload = await response.json() as { executablePath?: string; cancelled?: boolean; error?: string }; if (!response.ok) throw new Error(payload.error ?? "无法选择浏览器"); if (payload.executablePath) { setBrowserPath(payload.executablePath); await saveBrowserPath(payload.executablePath); } } catch (runtimeError) { setError(runtimeError instanceof Error ? runtimeError.message : "无法选择浏览器"); } finally { setBrowserRuntimeBusy(false); } };
  const scanBrowsers = async () => { setBrowserRuntimeBusy(true); try { const response = await fetch("/api/browser-runtime/scan"); const payload = await response.json() as { candidates?: Array<{ label: string; executablePath: string }>; error?: string }; if (!response.ok) throw new Error(payload.error ?? "无法扫描浏览器"); setBrowserCandidates(payload.candidates ?? []); } catch (runtimeError) { setError(runtimeError instanceof Error ? runtimeError.message : "无法扫描浏览器"); } finally { setBrowserRuntimeBusy(false); } };
  const installBrowserRuntime = async () => { setBrowserRuntimeBusy(true); try { const response = await fetch("/api/browser-runtime/install", { method: "POST" }); if (!response.ok) throw new Error("无法启动浏览器下载"); await loadBrowserRuntime(); onNotice("验证浏览器正在下载，完成后会自动可用"); } catch (runtimeError) { setError(runtimeError instanceof Error ? runtimeError.message : "无法下载验证浏览器"); } finally { setBrowserRuntimeBusy(false); } };
  const uploadMembership = async (file: File | null) => {
    if (!file) return;
    setMembershipLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/membership-document?profileId=${encodeURIComponent(profileId)}&filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type || "application/pdf" }, body: file });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "无法识别会员凭证");
      const payload = (await response.json()) as { membership: MembershipProfile };
      const existingIndex = draft.memberships.findIndex((existing) => existing.organization === payload.membership.organization && (!payload.membership.number || !existing.number || existing.number === payload.membership.number));
      let nextDraft: UserProfile;
      if (existingIndex < 0) {
        nextDraft = { ...draft, memberships: [...draft.memberships, payload.membership] };
      } else {
        const memberships = [...draft.memberships];
        memberships[existingIndex] = { ...memberships[existingIndex], ...Object.fromEntries(Object.entries(payload.membership).filter(([, value]) => Boolean(value))) } as MembershipProfile;
        nextDraft = { ...draft, memberships };
      }
      setDraft(nextDraft);
      await onSave(nextDraft, "", null);
    } catch (recognizeError) {
      setError(recognizeError instanceof Error ? recognizeError.message : "无法识别会员凭证");
    } finally {
      setMembershipLoading(false);
    }
  };
  const submit = async () => { setSaving(true); setError(""); try { await onSave(draft, schoolSsoPassword, signature); if (schoolSsoPassword) onNotice(await verifySchoolSso()); onClose(); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "保存失败"); } finally { setSaving(false); } };

  return <div className="dialog-backdrop profile-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>USER PROFILE</span><h2 id="profile-title">用户信息</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <div className="profile-tabs" role="tablist" aria-label="用户资料分类">{([ ["identity", "身份与签名"], ["invoice", "发票抬头"], ["membership", "会员"], ["systems", "系统凭证"] ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === "identity" && <div className="profile-panel"><label>中文姓名<input value={draft.chineseName} onChange={(event) => setField("chineseName", event.target.value)} placeholder="例如：张三" /></label><label>英文姓名<input value={draft.englishName} onChange={(event) => setField("englishName", event.target.value)} placeholder="例如：San Zhang" /></label><label>职务/职称<input value={draft.jobTitle} onChange={(event) => setField("jobTitle", event.target.value)} placeholder="未填写则使用教职工" /></label><label>常住地（用于判定去程/返程）<input value={draft.homeCity} onChange={(event) => setField("homeCity", event.target.value)} placeholder="如：上海" autoComplete="off" /></label><div className="avatar-field"><span>头像</span><div className="avatar-preview" aria-label={`当前头像 ${draft.avatar}`}>{draft.avatar}</div><div className="avatar-controls"><div className="avatar-options" role="radiogroup" aria-label="选择头像">{["🙂", "🧘", "👩‍🏫", "👨‍🏫", "📚", "🖋️", "🌿", "🌙"].map((avatar) => <button key={avatar} type="button" role="radio" aria-checked={draft.avatar === avatar} className={draft.avatar === avatar ? "selected" : ""} onClick={() => setField("avatar", avatar)}>{avatar}</button>)}</div><label className="avatar-custom"><input value={draft.avatar} maxLength={8} onChange={(event) => setField("avatar", event.target.value)} placeholder="自定义 Emoji" aria-label="自定义 Emoji" /></label></div></div><div className="signature-field"><div><strong>签名 PNG</strong><span>{signature?.name ?? (draft.signatureUpdated ? "已保存本地签名" : "尚未上传")}</span></div>{draft.signatureUpdated && !signature && <img src={`/api/user-signature?profileId=${encodeURIComponent(profileId)}`} alt="当前签名" />}<label className="quiet-button">选择 PNG<input type="file" accept="image/png" hidden onChange={(event) => setSignature(event.target.files?.[0] ?? null)} /></label></div></div>}
      {tab === "invoice" && <div className="profile-panel"><label>发票抬头<input value={draft.invoiceTitle} onChange={(event) => setField("invoiceTitle", event.target.value)} placeholder="单位全称" /></label><label>纳税人识别号<input value={draft.taxId} onChange={(event) => setField("taxId", event.target.value)} /></label><label>单位地址及电话（可选）<input value={draft.invoiceAddressPhone} onChange={(event) => setField("invoiceAddressPhone", event.target.value)} /></label><label>开户行及账号（可选）<input value={draft.invoiceBankAccount} onChange={(event) => setField("invoiceBankAccount", event.target.value)} /></label></div>}
      {tab === "membership" && <div className="profile-panel membership-panel"><header><div><strong>会员资料</strong><span>上传会员卡、证明或收据后自动提取关键信息</span></div><button type="button" className="quiet-button" disabled={membershipLoading} onClick={() => membershipInput.current?.click()}><Upload size={14} />{membershipLoading ? "识别中" : "上传会员凭证"}</button><input ref={membershipInput} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => { void uploadMembership(event.target.files?.[0] ?? null); event.currentTarget.value = ""; }} /></header><div className="membership-cards">{draft.memberships.length ? orderMemberships(draft.memberships).map((membership) => { const details = resolvedMembership(membership, draft.memberships); const validity = details.validUntil ? (details.validUntil < new Date().toISOString().slice(0, 10) ? "已过期" : "有效") : ""; return <article key={membership.id} className={details.parentName ? "membership-child" : ""}><div><strong>{membership.organization}</strong>{details.parentName && <em>隶属 {details.parentName}</em>}{membership.website && <a href={membership.website} target="_blank" rel="noreferrer">官网</a>}</div><p>{[details.level, validity, details.number && `会员号 ${details.number}`, details.effectiveDate && `生效 ${details.effectiveDate}`, details.validUntil && `有效至 ${details.validUntil}`].filter(Boolean).join(" · ") || "待从会员凭证识别"}</p>{details.parent && <small>会籍编号与有效期随主会员同步</small>}<div className="membership-card-actions"><button type="button" title={`删除 ${membership.organization}`} onClick={() => setDraft((current) => ({ ...current, memberships: current.memberships.filter((item) => item.id !== membership.id && item.parentId !== membership.id) }))}><X size={14} /></button></div></article>; }) : <p className="membership-empty">上传会员凭证后自动生成资料卡。</p>}</div><details className="membership-add"><summary>添加其他会员</summary><div><input value={membershipName} onChange={(event) => setMembershipName(event.target.value)} placeholder="其他会员名称" /><input value={membershipWebsite} onChange={(event) => setMembershipWebsite(event.target.value)} placeholder="官网（可选）" /><input value={membershipParentName} onChange={(event) => setMembershipParentName(event.target.value)} placeholder="隶属主会员（可选）" list="membership-parent-options" /><datalist id="membership-parent-options">{draft.memberships.filter((membership) => !membership.parentId).map((membership) => <option key={membership.id} value={membership.organization} />)}</datalist><input value={membershipNumber} onChange={(event) => setMembershipNumber(event.target.value)} placeholder="会员号（可选）" /><input value={membershipLevel} onChange={(event) => setMembershipLevel(event.target.value)} placeholder="会员等级（可选）" /><input type="date" value={membershipEffectiveDate} onChange={(event) => setMembershipEffectiveDate(event.target.value)} aria-label="生效日期" /><input type="date" value={membershipValidUntil} onChange={(event) => setMembershipValidUntil(event.target.value)} aria-label="有效期至" /><button type="button" className="quiet-button" onClick={addMembership}>添加</button></div></details></div>}
      {tab === "systems" && <div className="profile-panel systems-panel"><p>学校系统使用同一 SSO 凭证；密码保存在本机的系统加密存储，浏览器不会保存或回显。</p><fieldset className="browser-runtime"><legend>验证浏览器 <i className={`validation-dot ${browserValidationState}`} aria-label="验证浏览器状态" /></legend><input value={browserPath || "尚未选择浏览器"} readOnly aria-label="已选浏览器路径" /><button type="button" className="quiet-button" disabled={browserRuntimeBusy} onClick={() => void pickBrowserPath()}>选择浏览器</button><button type="button" className="quiet-button" disabled={browserRuntimeBusy} onClick={() => void scanBrowsers()}>扫描本机</button><button type="button" className="quiet-button" disabled={browserRuntimeBusy || browserRuntime.managedAvailable} onClick={() => void installBrowserRuntime()}>{browserRuntime.installing ? "下载中" : browserRuntime.managedAvailable ? "已下载" : "下载 Chromium"}</button><small className="sso-validation">{browserRuntime.browserName ? `当前使用：${browserRuntime.browserName}${browserRuntime.browserVersion ? ` ${browserRuntime.browserVersion}` : ""}` : browserValidation || browserRuntime.installError || (browserRuntime.source === "custom" ? "使用自选浏览器，验证通过" : browserRuntime.source === "managed" ? "使用票据簿管理的 Chromium，验证通过" : "请先选择、扫描或下载验证浏览器")}</small>{browserCandidates.length > 0 && <div className="browser-candidates">{browserCandidates.map((candidate) => <button type="button" key={candidate.executablePath} disabled={browserRuntimeBusy} onClick={() => void saveBrowserPath(candidate.executablePath)}><strong>{candidate.label}</strong><span>{candidate.executablePath}</span></button>)}</div>}</fieldset><fieldset><legend>学校 SSO <i className={`validation-dot ${ssoValidationState}`} aria-label="学校 SSO 验证状态" /></legend><input value={draft.schoolSsoAccount} onChange={(event) => setField("schoolSsoAccount", event.target.value)} placeholder="统一身份认证账号" /><input type="password" value={schoolSsoPassword} onChange={(event) => setSchoolSsoPassword(event.target.value)} placeholder={credentialStatus.schoolSsoConfigured ? "已保存；留空则不改动" : "输入密码"} autoComplete="new-password" /><button type="button" className="quiet-button" disabled={ssoVerifying || browserRuntime.source === "none"} onClick={() => void verifySchoolSso()}>{ssoVerifying ? "验证中" : "验证登录"}</button><small className="sso-validation">{ssoValidation || (draft.schoolSsoVerifiedAt ? "验证通过" : browserRuntime.source === "none" ? "请先配置并验证浏览器" : credentialStatus.schoolSsoConfigured ? "密码已存入 Keychain，等待验证" : "尚未保存密码")}</small>{draft.schoolSsoVerifiedAt && <div className="sso-identity"><span>工号 {draft.employeeId || draft.schoolSsoAccount}</span>{draft.organization && <strong>{draft.organization}</strong>}</div>}</fieldset></div>}
      {error && <p className="backend-error">{error}</p>}
      <footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="create-button" disabled={saving} onClick={() => void submit()}>{saving ? "保存中" : "保存"}</button></footer>
    </section>
  </div>;
}

/** 线上递交悬浮层：覆盖卡片全程显示开单进度（步骤进度条+实时日志），草稿就绪后转入确认环节（确认递交/上财务系统/撤回）。不提供暂停——修改需撤回重交。 */
function OnlineJobOverlay({ job, onDecide, onDismiss, onArchive, onStop }: { job: OnlineJobState; onDecide: (action: "confirm" | "withdraw") => void; onDismiss: () => void; onArchive: () => void; onStop: () => void }) {
  const [, setNow] = useState(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  // 日志窗全量留存：新行到达时贴底滚动，用户上翻查看历史时不打扰。
  useEffect(() => {
    const body = logRef.current;
    if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 60) body.scrollTop = body.scrollHeight;
  }, [job.logTail.length]);
  const active = job.state === "running" || job.state === "submitting" || job.state === "withdrawing";
  const elapsed = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const stepNo = Number(job.step.match(/^#(\d+)/)?.[1] ?? -1);
  const progress = job.state === "submitting" || job.state === "withdrawing" ? 15 : (job.progress ?? (stepNo >= 0 ? Math.min(stepNo, 16) : 0));
  return <div className={`line-online-overlay is-${job.state}`} role="status">
    <header>
      <span>ONLINE SUBMISSION</span>
      {active && <time>{mmss}</time>}
    </header>
    {(job.state === "running" || job.state === "submitting" || job.state === "withdrawing") && <>
      <h3>{job.state === "running" ? `线上递交 · ${job.title}` : job.state === "submitting" ? "正在财务系统提交申请" : "正在撤回草稿与发票"}</h3>
      <div className="online-overlay-progress" aria-label={`步骤进度 ${progress}/16`}>
        {Array.from({ length: 16 }, (_, index) => <i key={index} className={index < progress ? "is-done" : index === progress ? "is-current" : ""} />)}
      </div>
      <p className="online-overlay-step">{job.step || "正在连接财务系统…"}</p>
      <p className="online-overlay-note">完成后需要你确认：提交申请 / 撤回重做。</p>
      <div className="online-job-actions"><button type="button" className="online-job-withdraw" onClick={onStop}>停止任务</button></div>
    </>}
    {job.state === "awaiting" && <>
      <h3><CheckCircle2 size={16} className="is-ok" /> 草稿已生成</h3>
      <dl className="online-overlay-facts">
        {job.billNo && <div><dt>草稿单号</dt><dd>{job.billNo}</dd></div>}
        <div><dt>摘要</dt><dd>{job.title}</dd></div>
      </dl>
      <div className="online-job-actions">
        <button type="button" className="submit-button" onClick={() => onDecide("confirm")}><Send size={14} /> 确认递交</button>
        <a className="quiet-button online-job-link" href="https://treasury.ecnu.edu.cn/WFManager/home2.jsp" target="_blank" rel="noreferrer"><ExternalLink size={14} /> 上财务系统确认</a>
        <button type="button" className="online-job-withdraw" onClick={() => onDecide("withdraw")}>撤回递交</button>
      </div>
      <p className="online-overlay-note">确认后自动在财务系统「提交申请」；需修改内容请撤回（删除草稿与发票）后重新递交，以保证口径一致。</p>
    </>}
    {job.state === "submitted" && <>
      <h3><CheckCircle2 size={16} className="is-ok" /> 已提交申请</h3>
      <p className="online-overlay-step">{job.billNo ? `单号 ${job.billNo}` : ""}已进入财务审批，可在「递交跟踪」查看进度。</p>
      <div className="online-job-actions">
        <button type="button" className="submit-button" onClick={onArchive}><Archive size={14} /> 归档</button>
        <button type="button" className="quiet-button online-job-link" onClick={onDismiss}>关闭</button>
      </div>
    </>}
    {job.state === "failed" && <>
      <h3><AlertTriangle size={16} className="is-bad" /> 递交失败</h3>
      <p className="online-overlay-step is-bad">{job.error || "未知错误"}</p>
      <p className="online-overlay-note">失败现场已留证据包（data/autobx_logs/evidence/）；修复或清理后可重新发起线上递交。</p>
      <div className="online-job-actions">
        <button type="button" className="submit-button" onClick={onDismiss}>退出</button>
      </div>
    </>}
    {job.state === "stopped" && <>
      <h3><AlertTriangle size={16} className="is-bad" /> 已人工停止</h3>
      <p className="online-overlay-step is-bad">{job.error || "任务已停止"}</p>
      <p className="online-overlay-note">重新线上递交会按摘要自动撤掉残留旧单；也可先上财务系统确认现场。</p>
      <div className="online-job-actions">
        <a className="quiet-button online-job-link" href="https://treasury.ecnu.edu.cn/WFManager/home2.jsp" target="_blank" rel="noreferrer"><ExternalLink size={14} /> 上财务系统查看</a>
        <button type="button" className="submit-button" onClick={onDismiss}>退出</button>
      </div>
    </>}
    {job.logTail.length > 0 && <div className="online-overlay-log" ref={logRef}>
      {job.logTail.map((entry, index) => <p key={`${index}-${entry.slice(0, 12)}`}>{entry.slice(0, 200)}</p>)}
    </div>}
  </div>;
}

const ELAB_STATUS_LABEL: Record<ElabBillRecord["status"], string> = { draft: "填写中", submitted: "已提交待审", approved: "已审核通过", rejected: "已退回" };

/**
 * elab/wxzc 前置报账单登记：低耗→zcgl 材料易耗品报账单（HC）；云服务/AI 订阅→wxzc 软件服务费报账单（CSF）。
 * 线上递交财务前所有相关费用须有 approved 单覆盖；线下递交仅提示不拦截（财务助手会处理），登记本身仍鼓励——帮财务减轻核对负担。
 */

/** 归档对话框（系统风格）：整单归档 + 按费用分类拆分归档（如云服务走别人经费，拆出后归档留存）。 */
function ArchiveDialog({ line, expenses, ready, onClose, onArchive, onSplit, formalModel }: {
  line: ExpenseLine;
  expenses: Expense[];
  ready: boolean;
  onClose: () => void;
  onArchive: () => void;
  onSplit: (expenseIds: string[], archive: boolean) => void;
  formalModel?: FormalModelState | null;
}) {
  // 拆分勾选与递交对话框同款：组头 checkbox 批量勾/取消整组，费用行单独勾选；勾选的费用（含关联材料）即拆出范围。
  const [checkedExpenseIds, setCheckedExpenseIds] = useState<ReadonlySet<string>>(() => new Set());
  // 与递交对话框同款折叠交互：分组默认全部折叠（组头统计可见），点箭头展开看费用与材料明细。
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroupExpanded = (group: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  // 按票据集组拆分（与首页票据集分类一致）：云服务/市内交通/办公用品/低值易耗设备各自成组。
  const archiveCollections = workflowForLine(line).collections.filter((collection) => collection.scope === "finance");
  const groups = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const expense of expenses) {
      const group = expenseCollectionLabel(expense.typeId, archiveCollections) ?? "direct";
      const list = map.get(group) ?? [];
      list.push(expense);
      map.set(group, list);
    }
    const orderOf = (group: string) => {
      const index = archiveCollections.findIndex((collection) => collection.label === group);
      return index === -1 ? archiveCollections.length : index;
    };
    return [...map.entries()]
      .sort((a, b) => orderOf(a[0]) - orderOf(b[0]))
      .map(([group, list]) => ({
      group,
      label: group === "direct" ? "其它（直接财务）" : group,
      detail: (() => {
        const perType = new Map<string, number>();
        for (const expense of list) {
          const typeLabel = EXPENSE_TAXONOMY.find((entry) => entry.id === expense.typeId)?.label ?? expense.typeId;
          perType.set(typeLabel, (perType.get(typeLabel) ?? 0) + (expense.amountCny ?? 0));
        }
        return perType.size > 1 ? [...perType.entries()].map(([typeLabel, sum]) => `${typeLabel} CNY ${sum.toFixed(2)}`).join("、") : "";
      })(),
      expenses: list,
      total: list.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0),
    }));
  }, [expenses]);
  const toggleExpense = (expenseId: string) => setCheckedExpenseIds((current) => {
    const next = new Set(current);
    if (next.has(expenseId)) next.delete(expenseId); else next.add(expenseId);
    return next;
  });
  const toggleGroupChecked = (groupExpenseIds: string[]) => setCheckedExpenseIds((current) => {
    const allChecked = groupExpenseIds.length > 0 && groupExpenseIds.every((id) => current.has(id));
    const next = new Set(current);
    for (const id of groupExpenseIds) { if (allChecked) next.delete(id); else next.add(id); }
    return next;
  });
  const selectedExpenseIds = [...checkedExpenseIds];
  return <div className="dialog-backdrop archive-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog elab-dialog archive-dialog" role="dialog" aria-modal="true" aria-label="归档确认">
      <header className="dialog-head">
        <h3>归档「{line.title}」</h3>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="dialog-body">
        <p className={`archive-ready ${ready ? "is-ok" : "is-warn"}`}>
          {ready
            ? "全部关联报销单已入账。"
            : "这笔材料可手动归档，之后可在已归档列表还原。"}
        </p>
        {groups.length > 1 && <>
          <p className="archive-split-hint">按分类拆分归档：勾选要拆出的费用（例如走他人经费的云服务），其费用与关联材料文件将移入独立票据集；组头勾选框可整组勾选/取消。</p>
          <div className="submit-checklist">
            {groups.map((group) => <div key={group.group} className="submit-group-section">
              <div className="submit-group-head">
                <label className="submit-group-toggle">
                  <input type="checkbox" checked={group.expenses.length > 0 && group.expenses.every((expense) => checkedExpenseIds.has(expense.id))} onChange={() => toggleGroupChecked(group.expenses.map((expense) => expense.id))} />
                  <strong>{group.label}</strong>
                </label>
                <span>{group.detail}{group.detail && " · "}{group.expenses.length} 笔 · CNY {group.total.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <button type="button" className="submit-group-fold" title={expandedGroups.has(group.group) ? "折叠该组明细" : "展开该组明细"} aria-expanded={expandedGroups.has(group.group)} onClick={() => toggleGroupExpanded(group.group)}>
                  {expandedGroups.has(group.group) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {expandedGroups.has(group.group) && group.expenses.map((expense) => {
                const files = (formalModel?.links ?? [])
                  .filter((link) => link.expenseId === expense.id)
                  .map((link) => (formalModel?.evidence ?? []).find((item) => item.id === link.evidenceId)?.path.split("/").pop())
                  .filter(Boolean) as string[];
                return <div key={expense.id} className="archive-expense-block">
                  <label className="submit-file-row">
                    <input type="checkbox" checked={checkedExpenseIds.has(expense.id)} onChange={() => toggleExpense(expense.id)} />
                    <FileText size={15} />
                    <span className="submit-file-name">{expense.merchant || EXPENSE_TAXONOMY.find((entry) => entry.id === expense.typeId)?.label || expense.typeId}</span>
                    <span className="submit-file-state">{expense.amountCny != null ? `CNY ${expense.amountCny.toFixed(2)}` : ""}</span>
                  </label>
                  {files.map((file) => <div key={file} className="submit-file-row is-subfile">
                    <FileText size={13} />
                    <span className="submit-file-name">{file}</span>
                    <span className="submit-file-state">材料</span>
                  </div>)}
                </div>;
              })}
            </div>)}
          </div>
          {selectedExpenseIds.length > 0 && <div className="archive-split-actions">
            <button type="button" className="create-button" onClick={() => onSplit(selectedExpenseIds, true)}>拆分并归档所选</button>
            <button type="button" className="quiet-button" onClick={() => onSplit(selectedExpenseIds, false)}>仅拆分（留进行中）</button>
          </div>}
        </>}
      </div>
      <footer className="dialog-footer">
        <button type="button" className="quiet-button" onClick={onClose}>取消</button>
        <button type="button" className="create-button" onClick={onArchive}>整单归档</button>
      </footer>
    </div>
  </div>;
}

type ElabHcPlanView = {
  lineId: string; title: string; jfly: string; jflyProject: string;
  bills: Array<{ name: string; dj: string; sl: string; fph: string; invoiceFile?: string; fphSource?: string; bz?: string }>;
  attachments: string[]; expenseIds: string[]; total: number; warnings: string[];
};

function ElabBillsSection({ line, expenses, onSave, refreshLine, onSaveProject, budgets, forceOpen = false, presetSystem = "zcgl", onClose, inlineEntry = true }: {
  line: ExpenseLine;
  expenses: Expense[];
  onSave: (lineId: string, bills: ElabBillRecord[]) => void;
  refreshLine?: () => void;
  onSaveProject: (lineId: string, projectId: string) => void;
  budgets: Array<{ projectId: string; projectName: string }>;
  /** [AI 填报] 联动：外部置 true 时打开原生弹窗并按 presetSystem 定位 tab 与勾选未登记费用 */
  forceOpen?: boolean;
  presetSystem?: "zcgl" | "wxzc";
  onClose?: () => void;
  /** 卡片内嵌入口按钮（节点化后由行内 [AI 填报] 替代，传 false 隐藏） */
  inlineEntry?: boolean;
}) {
  const needing = useMemo(() => expenses.filter((expense) => elabPreapprovalFor(expense.typeId)), [expenses]);
  const [open, setOpen] = useState(false);
  // 系统切换主线：zcgl 材料易耗品低值品（自动填报 HC）/ wxzc 软件服务费（手动登记 CSF）。
  const [system, setSystem] = useState<"zcgl" | "wxzc">("zcgl");
  const [plan, setPlan] = useState<ElabHcPlanView | null>(null);
  const [planDraft, setPlanDraft] = useState<ElabHcPlanView | null>(null);
  // jobId 持久化：30s 对齐等引发的组件重挂载会把 job state 清零（「提交中」凭空消失）——
  // server 端任务还在跑，恢复 jobId 即恢复轮询，状态无损续接。
  const [jobId, setJobIdState] = useState(() => sessionStorage.getItem(`elabJobId:${line.id}`) ?? "");
  const setJobId = (id: string) => {
    setJobIdState(id);
    try {
      if (id) sessionStorage.setItem(`elabJobId:${line.id}`, id);
      else sessionStorage.removeItem(`elabJobId:${line.id}`);
    } catch { /* 忽略 */ }
  };

  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [job, setJob] = useState<{ state: string; step?: string; error?: string; billNo?: string; log: string[] } | null>(null);
  const [billNo, setBillNo] = useState("");
  // 登记一律初始「填写中」——真实状态由 elab 同步（手动按钮/每 10 分钟自动）流转，不再人工选择
  const [status] = useState<ElabBillRecord["status"]>("draft");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // [AI 填报] 联动：外部打开时默认勾选未登记（未覆盖）的 zcgl 费用，省一步手选
  useEffect(() => {
    if (!forceOpen) return;
    setOpen(true);
    setSystem(presetSystem);
    const gaps = elabPreapprovalGaps(line, expenses);
    setSelected(new Set(gaps.filter((gap) => elabPreapprovalFor(gap.expense.typeId)?.system === presetSystem).map((gap) => gap.expense.id)));
  }, [forceOpen]);
  const [amount, setAmount] = useState("");
  const bills = line.elabBills ?? [];
  const gaps = elabPreapprovalGaps(line, expenses);
  const eligible = gaps.map((gap) => gap.expense);
  const eligibleFor = (value: "zcgl" | "wxzc") => eligible.filter((expense) => elabPreapprovalFor(expense.typeId)?.system === value);
  const currentEligible = eligibleFor(system);
  const selectedExpenses = currentEligible.filter((expense) => selected.has(expense.id));
  const selectedTotal = selectedExpenses.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0);
  const switchSystem = (value: "zcgl" | "wxzc") => {
    setSystem(value);
    setSelected(new Set(eligibleFor(value).map((expense) => expense.id)));
    setAmount("");
    setBillNo("");
    setPlan(null);
    setPlanError("");
  };
  const toggleExpense = (expenseId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(expenseId)) next.delete(expenseId); else next.add(expenseId);
    return next;
  });
  const saveManual = () => {
    if (!billNo.trim() || !selected.size) return;
    const record: ElabBillRecord = {
      id: `elab-${Date.now()}`,
      system,
      billNo: billNo.trim(),
      status,
      expenseIds: [...selected],
      amountCny: amount.trim() ? Number(amount) : selectedTotal || undefined,
    };
    onSave(line.id, [...bills, record]);
    setBillNo("");
    setAmount("");
    setSelected(new Set());
  };
  const loadPlan = async () => {
    setPlanLoading(true);
    setPlanError("");
    setPlan(null);
    try {
      const ids = [...selected].join(",");
      const endpoint = system === "wxzc" ? "/api/elab-csf-plan" : "/api/elab-hc-plan";
      const resp = await fetch(`${endpoint}?lineId=${encodeURIComponent(line.id)}${ids ? `&expenseIds=${encodeURIComponent(ids)}` : ""}`);
      const data = await resp.json() as { plan?: ElabHcPlanView; error?: string };
      if (!resp.ok || !data.plan) throw new Error(data.error ?? "生成填报计划失败");
      setPlan(data.plan);
      setPlanDraft(structuredClone(data.plan));
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "生成填报计划失败");
    } finally {
      setPlanLoading(false);
    }
  };
  const startSubmit = async () => {
    setPlanError("");
    try {
      const endpoint = system === "wxzc" ? "/api/elab-csf-submit" : "/api/elab-hc-submit";
      const payload = system === "wxzc"
        ? { lineId: line.id, autoSubmit, plan: { bills: planDraft?.bills } }
        : { lineId: line.id, autoSubmit, plan: { bills: planDraft?.bills } };
      const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await resp.json() as { jobId?: string; error?: string };
      if (!resp.ok || !data.jobId) throw new Error(data.error ?? "启动失败");
      setJob({ state: "running", step: "启动", log: [] });
      setJobId(data.jobId);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "启动失败");
    }
  };
  // 轮询任务状态；完成时把单号登记进列表（服务端同时写 model，同号幂等）
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const tick = async () => {
      try {
        const statusEndpoint = jobId.startsWith("elabcsf-") ? "/api/elab-csf-status" : "/api/elab-hc-status";
        const resp = await fetch(`${statusEndpoint}?jobId=${encodeURIComponent(jobId)}`);
        if (resp.status === 404) {
          // 任务不存在（server 重启丢内存任务）——清持久 key，避免恢复轮询死循环
          setJobId("");
          return;
        }
        const data = await resp.json() as { state: string; step?: string; error?: string; billNo?: string; log: string[] };
        if (!alive) return;
        setJob(data);
        if (data.state === "running") { setTimeout(tick, 2000); return; }
        if (data.state === "draft_saved" && data.billNo && !(line.elabBills ?? []).some((item) => item.billNo === data.billNo) && plan) {
          onSave(line.id, [...(line.elabBills ?? []), {
            id: `elab-${Date.now()}`, system: jobId.startsWith("elabcsf-") ? "wxzc" : "zcgl", billNo: data.billNo, status: "draft",
            expenseIds: plan.expenseIds, amountCny: plan.total,
          }]);
        }
      } catch {
        if (alive) setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => { alive = false; };
  }, [jobId]);
  const [syncing, setSyncing] = useState(false);
  const syncStatus = async () => {
    setSyncing(true);
    try {
      const resp = await fetch("/api/elab-hc-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lineId: line.id, system }) });
      const data = await resp.json() as { elabBills?: ElabBillRecord[]; error?: string };
      if (!resp.ok) throw new Error(data.error ?? "同步失败");
      // 无条件应用（含空数组）：服务端移除了已删除的单时必须清掉本地残留
      onSave(line.id, (data.elabBills ?? []).map((bill) => ({ ...bill, status: bill.status as ElabBillRecord["status"] })));
    } catch { /* 同步失败静默，按钮可重试 */ }
    finally { setSyncing(false); }
  };
  const gapText = (expense: Expense) => {
    const gap = gaps.find((item) => item.expense.id === expense.id);
    if (!gap || gap.state === "missing") return "未登记";
    return `单 ${gap.billNo} ${ELAB_STATUS_LABEL[gap.billStatus ?? "submitted"]}`;
  };
  const allApproved = gaps.length === 0;
  const jobRunning = job?.state === "running";
  // 早退必须在全部 hooks 之后（React 规则）：费用列表为空翻转时早退位置变化会导致 hooks 数量崩溃
  if (!needing.length) return null;
  return <section className={inlineEntry ? "elab-section elab-section--compact" : "elab-section elab-section--hidden"} aria-label="elab 前置报账单">
    {inlineEntry && <button type="button" className={`elab-compact-button ${allApproved ? "is-ok" : bills.length ? "is-pending" : "is-missing"}`}
      title="点击查看 elab 前置报账单；低值设备单可一键自动填报"
      onClick={() => { setOpen(true); if (!selected.size && currentEligible.length) setSelected(new Set(currentEligible.map((expense) => expense.id))); }}>
      <ClipboardList size={14} />
      <span>elab 前置报账单</span>
      <em className={`elab-section-state ${allApproved ? "is-ok" : bills.length ? "is-pending" : "is-missing"}`}>
        {allApproved ? "✓ 已全部覆盖" : `${gaps.length} 笔待覆盖`}
      </em>
    </button>}
    {open && <div className="dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) { setOpen(false); onClose?.(); } }}>
      <div className={`dialog elab-dialog ${plan && !job ? "is-plan-open" : ""}`} role="dialog" aria-modal="true" aria-label="elab 前置报账单">
        <header className="dialog-head">
          <h3>elab 前置报账单 · {line.title}</h3>
          <button type="button" className="icon-button" aria-label="关闭" onClick={() => { setOpen(false); onClose?.(); }}><X size={16} /></button>
        </header>
        <div className="elab-dialog-body">
        <div className="dialog-body">
          <p className="elab-section-note">低值易耗设备先在 elab（zcgl）报「材料易耗品低值品报账单」；云服务与 AI 订阅先在 wxzc 报「软件服务费报账单」（科技处审）——审核通过的报账单是财务报销的前置。</p>
          <div className="elab-form">
            <label>系统<select value={system} onChange={(event) => switchSystem(event.target.value as "zcgl" | "wxzc")}>
              <option value="zcgl">zcgl · 材料易耗品低值品报账单（HC）</option>
              <option value="wxzc">wxzc · 软件服务费报账单（CSF）</option>
            </select></label>
            {system === "wxzc" && <>
              <label>单号<input value={billNo} onChange={(event) => setBillNo(event.target.value)} placeholder="CSF2600000" /></label>
              <label>单内金额<input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={selectedTotal ? selectedTotal.toFixed(2) : "选费用后自动合计"} inputMode="decimal" /></label>
            </>}
          </div>
          <div className="elab-form-expenses">
            {currentEligible.length ? currentEligible.map((expense) => <label key={expense.id} className="elab-expense-row">
              <input type="checkbox" checked={selected.has(expense.id)} onChange={() => toggleExpense(expense.id)} />
              <span>{expense.merchant || expense.typeId}</span>
              <span className="elab-expense-meta">{expense.amountCny != null ? `CNY ${expense.amountCny.toFixed(2)}` : ""} · {gapText(expense)}</span>
            </label>) : <span className="elab-form-empty">该系统暂无待覆盖费用。</span>}
          </div>
          {system === "wxzc" ? <>
            {!plan && !job && <div className="elab-hc-plan-actions">
              <button type="button" className="create-button" disabled={planLoading || !selected.size} onClick={() => void loadPlan()}>
                {planLoading ? "正在生成填报计划…" : `自动填报 CSF 单（${selected.size} 笔 · CNY ${selectedTotal.toFixed(2)}）`}
              </button>
            </div>}
            {planError && <p className="elab-form-error">{planError}</p>}
            {job && <div className="elab-hc-job">
              <p className={`elab-hc-job-state is-${job.state}`}>
                {job.state === "running" ? `填报中：${job.step ?? "…"}` : job.state === "submitted" ? `✓ 已提交审批：${job.billNo}（科技处审核中）` : job.state === "draft_saved" ? `✓ 草稿已保存 ${job.billNo}（未提交）` : job.state === "stopped" ? "已停止" : `失败：${job.error ?? "未知错误"}`}
              </p>
              <pre className="elab-hc-job-log">{(job.log ?? []).slice(-4).join("\n")}</pre>
              {jobRunning && <button type="button" className="quiet-button" onClick={() => { void fetch("/api/elab-csf-stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) }); }}>停止</button>}
              {(job.state === "failed" || job.state === "stopped") && <button type="button" className="quiet-button" onClick={() => { setJob(null); setJobId(""); }}>关闭</button>}
              {(job.state === "draft_saved" || job.state === "submitted") && <button type="button" className="quiet-button" onClick={() => { setJob(null); setJobId(""); setPlan(null); refreshLine?.(); }}>完成</button>}
            </div>}
            <p className="elab-form-hint">自动开单默认到<b>保存草稿</b>为止，勾选自动提交则直接进入科技处审核（以实际审批流程为准）。明细名称惯例「软件服务费」+备注区分，附件仅取 invoice/receipt 类材料。</p>
            {billNo.trim() && selected.size ? <div className="elab-hc-plan-actions"><button type="button" className="create-button" onClick={saveManual}>保存登记</button></div> : null}
            <p className="elab-form-hint">入口：elab.ecnu.edu.cn/wxzc → 报账管理 → 软件服务报账；同类账单可合并一张单。</p>
          </> : <>
            <label className="elab-project-row">报销项目<select
              value={line.projectId ?? ""}
              onChange={(event) => onSaveProject(line.id, event.target.value)}>
              <option value="">请选择项目…</option>
              {budgets.map((budget) => <option key={budget.projectId} value={budget.projectId}>{budget.projectId} · {budget.projectName.slice(0, 22)}</option>)}
            </select></label>
            {!line.projectId && <p className="elab-form-warning">⚠ 先选择报销项目——经费卡需通过项目预算表交叉验证（排除间接经费）。</p>}
            {!plan && !job && <div className="elab-hc-plan-actions">
              <button type="button" className="create-button" disabled={planLoading || !selected.size || !line.projectId} onClick={() => void loadPlan()}>
                {planLoading ? "正在生成填报计划…" : `自动填报 HC 单（${selected.size} 笔 · CNY ${selectedTotal.toFixed(2)}）`}
              </button>
            </div>}
            {planError && <p className="elab-form-error">{planError}</p>}
            {plan && !job && <p className="elab-form-hint">✓ 填报计划已生成——请在右侧面板核对明细，可直接修改品名/单价/发票号，确认后开始填报。</p>}
            {job && <div className="elab-hc-job">
              <p className={`elab-hc-job-state is-${job.state}`}>
                {job.state === "running" ? `填报中：${job.step ?? "…"}` : job.state === "submitted" ? `✓ 已提交审批：${job.billNo}` : job.state === "draft_saved" ? `✓ 草稿已保存 ${job.billNo}（未提交）` : job.state === "stopped" ? "已停止" : `失败：${job.error ?? "未知错误"}`}
              </p>
              <pre className="elab-hc-job-log">{(job.log ?? []).slice(-4).join("\n")}</pre>
              {jobRunning && <button type="button" className="quiet-button" onClick={() => { void fetch("/api/elab-hc-stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) }); }}>停止</button>}
              {(job.state === "failed" || job.state === "stopped") && <button type="button" className="quiet-button" onClick={() => { setJob(null); setJobId(""); }}>关闭</button>}
              {job.state === "draft_saved" && <button type="button" className="quiet-button" onClick={() => { setJob(null); setJobId(""); setPlan(null); refreshLine?.(); }}>完成</button>}
            </div>}
            <p className="elab-form-hint">自动开单到<b>保存草稿</b>为止；提交审批在 elab 里人工确认（&lt;1 万经费负责人自批）。明细名称格式「分类目录*商品名」。</p>
          </>}
          {bills.length > 0 && <ul className="elab-bill-list">
            {bills.map((bill) => <li key={bill.id} className={`elab-bill-row is-${bill.status}`}>
              <code>{bill.billNo}</code>
              <span className="elab-bill-system">{bill.system === "zcgl" ? "zcgl 材料易耗品" : "wxzc 软件服务"}</span>
              <span className={`elab-bill-status is-${bill.status}`}>{ELAB_STATUS_LABEL[bill.status]}</span>
              {bill.stage && <span className="elab-bill-stage" title="审核环节（常规品目走经费负责人自批，非常规品目转装备处人工审）">{bill.stage}</span>}
              {bill.amountCny != null && <span>CNY {bill.amountCny.toFixed(2)}</span>}
              <span className="elab-expense-meta">覆盖 {bill.expenseIds.length} 笔</span>
              <button type="button" className="icon-button" title="删除登记" onClick={() => onSave(line.id, bills.filter((item) => item.id !== bill.id))}><X size={13} /></button>
            </li>)}
          </ul>}
          {(bills.length > 0 || system === "zcgl") && <div className="elab-hc-plan-actions">
            <button type="button" className="quiet-button" disabled={syncing} onClick={() => void syncStatus()}>
              {syncing ? "正在从 elab 同步状态…" : "同步 elab 状态"}
            </button>
          </div>}
        </div>
        <aside className={`elab-hc-panel ${plan && !job ? "is-open" : ""}`} aria-label="HC 填报计划确认">
          <header><span>{system === "wxzc" ? "CSF 填报计划 · 确认与修改" : "HC 填报计划 · 确认与修改"}</span>{plan && <button type="button" className="icon-button" aria-label="关闭面板" onClick={() => { setPlan(null); setPlanDraft(null); setPlanError(""); }}><X size={14} /></button>}</header>
          {planDraft && <>
            {system !== "wxzc" && <p className="elab-hc-plan-meta">经费来源：{planDraft.jfly}（{planDraft.jflyProject.slice(0, 20)}）· 附件 {planDraft.attachments.length} 份</p>}
            {system === "wxzc" && <p className="elab-hc-plan-meta">附件 {planDraft.attachments.length} 份（invoice/receipt 类）· 无经费来源字段（CSF 单不填）</p>}
            <table className="elab-hc-plan-table">
              <thead><tr>{system === "wxzc" ? <><th>明细（软件服务费）</th><th>总价</th><th>备注</th></> : <><th>明细（分类目录*商品名）</th><th>单价</th><th>发票号</th></>}</tr></thead>
              <tbody>{planDraft.bills.map((bill, index) => <tr key={bill.invoiceFile || `${bill.name}-${index}`}>
                <td><input value={bill.name} onChange={(event) => setPlanDraft((current) => {
                  if (!current) return current;
                  const bills = current.bills.map((item, k) => (k === index ? { ...item, name: event.target.value } : item));
                  return { ...current, bills };
                })} /></td>
                <td><input className="elab-hc-num" value={bill.dj} inputMode="decimal" onChange={(event) => setPlanDraft((current) => {
                  if (!current) return current;
                  const bills = current.bills.map((item, k) => (k === index ? { ...item, dj: event.target.value } : item));
                  return { ...current, bills };
                })} /></td>
                {system === "wxzc" ? <td><input value={bill.bz ?? ""} onChange={(event) => setPlanDraft((current) => {
                  if (!current) return current;
                  const bills = current.bills.map((item, k) => (k === index ? { ...item, bz: event.target.value } : item));
                  return { ...current, bills };
                })} /></td> : <td><input className="elab-hc-num" value={bill.fph} onChange={(event) => setPlanDraft((current) => {
                  if (!current) return current;
                  const bills = current.bills.map((item, k) => (k === index ? { ...item, fph: event.target.value } : item));
                  return { ...current, bills };
                })} /></td>}
              </tr>)}</tbody>
            </table>
            {planDraft.warnings.map((warning) => <p key={warning} className="elab-form-warning">⚠ {warning}</p>)}
            <p className="elab-hc-plan-meta">合计 CNY {planDraft.bills.reduce((sum, bill) => sum + (Number(bill.dj) || 0) * (Number(bill.sl) || 1), 0).toFixed(2)}</p>
            {system === "wxzc" ? <>
              <label className="submit-auto-submit"><input type="checkbox" checked={autoSubmit} onChange={(event) => setAutoSubmit(event.target.checked)} />保存草稿后自动提交审批（提交后进入科技处审核，约 1 个工作日）</label>
              <button type="button" className="create-button" onClick={() => void startSubmit()}>{autoSubmit ? "开始填报并提交审批" : "开始填报（仅保存草稿）"}</button>
            </> : <>
              <label className="submit-auto-submit"><input type="checkbox" checked={autoSubmit} onChange={(event) => setAutoSubmit(event.target.checked)} />保存草稿后自动提交审批（提交即进入 elab 审核流）</label>
              <button type="button" className="create-button" disabled={planDraft.bills.some((bill) => !bill.fph.trim())} onClick={() => void startSubmit()}>{autoSubmit ? "开始填报并提交审批" : "开始填报（仅保存草稿）"}</button>
            </>}
          </>}
        </aside>
        </div>
      </div>
    </div>}
  </section>;
}

function materialHeadingRank(file: ReceiptRecord) {
  const type = classifyEvidenceType(file);
  if (type === "invoice" || type === "receipt") return 2;
  return type === "transport-ticket" ? 1 : 0;
}

function groupLinkedMaterials<T extends { file: ReceiptRecord }>(
  entries: T[],
  links: ReturnType<typeof uniqueMaterialExpenseLinks>,
  sharedSchedules: ReadonlyMap<string, ReadonlySet<string>>,
): T[][] {
  const headings = new Map<string, { entry: T; rank: number }>();
  for (const entry of entries) {
    const link = links.get(entry.file.path);
    if (!link?.primary) continue;
    const rank = materialHeadingRank(entry.file);
    if (rank > (headings.get(link.expenseId)?.rank ?? 0)) headings.set(link.expenseId, { entry, rank });
  }
  const expenseGroups = new Map<string, T[]>();
  const groups: T[][] = [];
  for (const entry of entries) {
    const shared = sharedSchedules.get(entry.file.path);
    const expenseId = links.get(entry.file.path)?.expenseId
      ?? (shared && [...headings.keys()].find((id) => shared.has(id)));
    const heading = expenseId && headings.get(expenseId);
    if (!expenseId || !heading) {
      groups.push([entry]);
      continue;
    }
    let group = expenseGroups.get(expenseId);
    if (!group) {
      group = [heading.entry];
      expenseGroups.set(expenseId, group);
      groups.push(group);
    }
    if (entry !== heading.entry) group.push(entry);
  }
  return groups;
}

function MatchedMaterialGroup({ tone, renderHeading, children }: {
  tone: number;
  renderHeading: (heading?: (label: string) => React.ReactNode) => React.ReactNode;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  if (children == null) {
    return <div className="matched-material-group" data-tone={tone % 4}>{renderHeading()}</div>;
  }
  const head = renderHeading((label) => <button type="button" className="matched-material-toggle"
    aria-expanded={expanded} aria-controls={contentId} title={expanded ? "折叠关联材料" : "展开关联材料"}
    onClick={() => setExpanded((current) => !current)}>
    <span>{label}</span><ChevronDown size={12} aria-hidden="true" />
  </button>);
  return <div className="matched-material-group" data-tone={tone % 4}>
    {head}
    <div id={contentId} hidden={!expanded}>{expanded && children}</div>
  </div>;
}

function LineCard({
  line,
  records,
  overrides,
  onToggleRequirement,
  onRemoveMaterial,
  onRefreshLine,
  onRefreshRecords,
  onUpload,
  onOpenSubmit,
  onAskAi,
  onArchive,
  onRestore,
  onOpenTemplate,
  onAiWrite,
  onOpenEvidenceSearch,
  onChangeKind,
  onSaveElabBills,
  onSaveProject,
  budgets,
  uploading,
  refreshing,
  treasuryPulsing,
  openingTemplate,
  formalModel,
  onlineJob,
  onOnlineDecide,
  onDismissOnlineJob,
  onStopOnlineJob,
  showNotice,
}: {
  line: ExpenseLine;
  records: ReceiptRecord[];
  overrides: Record<string, boolean>;
  onToggleRequirement: (lineId: string, requirementId: string, completed: boolean) => void;
  onRemoveMaterial: (filePath: string) => void;
  onRefreshLine: (line: ExpenseLine) => void;
  onRefreshRecords: () => void;
  onUpload: (files: FileList | null, requirement?: Requirement) => void;
  onOpenSubmit: (line: ExpenseLine) => void;
  onAskAi: (line: ExpenseLine) => void;
  onArchive: (line: ExpenseLine) => void;
  onRestore: (line: ExpenseLine) => void;
  onOpenTemplate: (line: ExpenseLine, requirement: Requirement) => void;
  onAiWrite: (line: ExpenseLine, requirement: Requirement) => void;
  onOpenEvidenceSearch: (line: ExpenseLine, requirement: Requirement) => void;
  onChangeKind: (line: ExpenseLine, kind: ExpenseLine["kind"]) => void;
  onSaveElabBills: (lineId: string, bills: ElabBillRecord[]) => void;
  onSaveProject: (lineId: string, projectId: string) => void;
  budgets: Array<{ projectId: string; projectName: string }>;
  uploading: boolean;
  refreshing: boolean;
  treasuryPulsing: boolean;
  openingTemplate: boolean;
  formalModel: FormalModelState | null;
  onlineJob: OnlineJobState | null;
  onOnlineDecide: (action: "confirm" | "withdraw") => void;
  onDismissOnlineJob: (lineId: string) => void;
  onStopOnlineJob: () => void;
  showNotice: (message: string) => void;
}) {
  const bulkInput = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // 分组金额悬浮小签：.line-card 是 overflow:hidden，内嵌 absolute 会被裁剪——用 fixed 定位逃逸（先例 .file-preview-popover）。
  const [ringTip, setRingTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [elabDialogOpen, setElabDialogOpenState] = useState(() => sessionStorage.getItem(`elabDialogOpen:${line.id}`) === "1");
  const [elabPresetSystem, setElabPresetSystem] = useState<"zcgl" | "wxzc">(() => (sessionStorage.getItem(`elabDialogSystem:${line.id}`) as "zcgl" | "wxzc") || "zcgl");
  // 刷新（dev 重启/误操作 full reload）会丢 React 状态——弹窗开合持久化到 sessionStorage，重载后自动恢复
  const setElabDialogOpen = (open: boolean) => {
    setElabDialogOpenState(open);
    try {
      if (open) sessionStorage.setItem(`elabDialogOpen:${line.id}`, "1");
      else { sessionStorage.removeItem(`elabDialogOpen:${line.id}`); sessionStorage.removeItem(`elabDialogSystem:${line.id}`); }
    } catch { /* 忽略 */ }
  };
  const openElabDialog = (preset: "zcgl" | "wxzc") => {
    setElabPresetSystem(preset);
    try { sessionStorage.setItem(`elabDialogSystem:${line.id}`, preset); } catch { /* 忽略 */ }
    setElabDialogOpen(true);
  };
  const [submittedExpanded, setSubmittedExpanded] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const titleEnd = line.title.match(/\S\s*$/u)?.[0] ?? "";
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const lineRecords = records.filter((record) => record.path.startsWith(`${line.folder}/`));
  const materialExpenseLinks = useMemo(() => uniqueMaterialExpenseLinks(formalModel, line.id), [formalModel, line.id]);
  const isExpenseMaterial = (file: ReceiptRecord) =>
    !isPreapprovalEvidence(file) && (materialExpenseLinks.has(file.path) || materialHeadingRank(file) > 0);
  const sharedSchedules = useMemo(() => {
    const expenseIds = new Set(formalModel?.expenses.filter((expense) => expense.setId === line.id).map((expense) => expense.id));
    const schedules = new Map(formalModel?.evidence.filter((item) => item.typeId === "fee-schedule" && item.path.startsWith(`${line.folder}/`))
      .map((item) => [item.id, item.path]));
    const grouped = new Map<string, Set<string>>();
    for (const link of formalModel?.links ?? []) {
      const path = schedules.get(link.evidenceId);
      if (!path || link.role !== "standard" || !expenseIds.has(link.expenseId)) continue;
      const expenses = grouped.get(path) ?? new Set<string>();
      expenses.add(link.expenseId);
      grouped.set(path, expenses);
    }
    return new Map([...grouped].filter(([, expenses]) => expenses.size > 1));
  }, [formalModel, line.folder, line.id]);
  const paymentMonths = line.kind === "日常" ? cloudPaymentMonths(formalModel, line.id, lineRecords) : new Map<string, string>();
  const fileDisplayName = (file: ReceiptRecord) => {
    const month = paymentMonths.get(file.path);
    if (month) return `${month} · ${file.name}`;
    return sharedSchedules.has(file.path) ? `共用清单 · ${file.name}` : file.name;
  };
  const renderArchivedFile = (file: ReceiptRecord, heading?: (label: string) => React.ReactNode) => <div className="archived-file-row" key={file.path}>
    <FileText size={15} /><span>{heading ? heading(fileDisplayName(file)) : fileDisplayName(file)}</span><FilePreviewTrigger file={file} />
  </div>;
  const lineExpenses = formalModel?.expenses.filter((expense) => expense.setId === line.id && expense.amountCny != null) ?? [];
  const lineDedupe = dedupeExpenses(lineExpenses);
  const lineTotalCny = lineDedupe.kept.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0);
  const workflow = resolveWorkflow(workflowForLine(line), line, lineRecords, overrides);
  // 已审核 elab 前置单覆盖的费用 → 反查凭证 path：这些设备材料行与报账单行同名同色（视觉成组，表示「该设备已走 elab 前置报账」）
  const preapprovalCoveredPaths = (() => {
    if (!formalModel) return new Set<string>();
    const approvedExpenseIds = new Set((line.elabBills ?? []).filter((bill) => bill.status === "approved").flatMap((bill) => bill.expenseIds ?? []));
    if (!approvedExpenseIds.size) return new Set<string>();
    const covered = new Set<string>();
    for (const link of formalModel.links) {
      if (!approvedExpenseIds.has(link.expenseId)) continue;
      const evidence = formalModel.evidence.find((item) => item.id === link.evidenceId);
      if (evidence) covered.add(evidence.path);
    }
    return covered;
  })();
  const formalIssues = formalModel
    ? formalModel.expenses.filter((expense) => expense.setId === line.id).flatMap((expense) => expenseIssues(formalModel, expense, overrides))
    : [];
  const formalNotices = formalModel
    ? [
        ...(lineDedupe.duplicates.length > 0
          ? [`检测到 ${lineDedupe.duplicates.length} 份同一笔支出的重复凭证（如发票+收据+截图），材料合计已按去重后 CNY ${lineTotalCny.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 计算。`]
          : []),
        ...formalModel.expenses.filter((expense) => expense.setId === line.id).flatMap(expenseNotices),
        ...lowValueGearBatchNotice(lineDedupe.kept),
      ]
    : [];
  // 组行以 line.groups（服务端按费用权威重算的组快照）为准——工作流定义里的 required: "always" 节点会让
  // 无此类费用的组恒亮（空壳组，如拆分后原集残留低值易耗设备组），必须按组快照过滤。
  const declaredGroupIds = useMemo(() => new Set((line.groups ?? []).map((group) => group.id)), [line.groups]);
  const groups: RequirementGroup[] = useMemo(() => workflow.definition.collections
    .filter((collection) => collection.scope === "finance")
    .map((collection) => ({
      id: collection.id,
      label: collection.label,
      hint: collection.hint,
      optional: !collection.nodeIds.some((id) => workflow.nodes[id]?.requiredForSubmission),
      requirements: collection.nodeIds.flatMap((id) => {
        const node = workflow.nodes[id];
        if (!node || node.kind !== "evidence" || (node.visibleWhen === "active" && !node.active)) return [];
        return [{ ...node, optional: !node.requiredForSubmission }];
      }),
    }))
    .filter((group) => group.requirements.length > 0)
    .filter((group) => declaredGroupIds.size === 0 || declaredGroupIds.has(group.id)), [workflow, declaredGroupIds]);
  const attachments = workflow.definition.collections
    .filter((collection) => collection.scope === "archive")
    .flatMap((collection) => collection.nodeIds.map((id) => workflow.nodes[id]).filter((node): node is NonNullable<typeof node> => Boolean(node)));
  const prioritizeIncomplete = shouldPrioritizeIncomplete(line.status);
  const isComplete = (requirement: Requirement) => {
    const key = requirementKey(line.id, requirement.id);
    return key in overrides ? overrides[key] : findRequirementFiles(lineRecords, requirement).length > 0;
  };
  const requiredInGroup = (group: RequirementGroup) => group.requirements.filter((requirement) => !requirement.optional);
  const isGroupComplete = (group: RequirementGroup) => requiredInGroup(group).every(isComplete);
  const requiredGroups = prioritizeIncomplete
    ? sortIncompleteFirst(groups.filter((group) => !group.optional), isGroupComplete)
    : groups.filter((group) => !group.optional);
  const optionalGroups = prioritizeIncomplete
    ? sortIncompleteFirst(groups.filter((group) => group.optional), isGroupComplete)
    : groups.filter((group) => group.optional);
  const allDone = workflow.submissionReady && formalIssues.length === 0;
  const progress = treasuryProgress({ status: line.treasuryStatus });
  const billsPosted = allTreasuryBillsPosted(line);
  const billRows = lineTreasuryBills(line).map((bill) => ({
    ...bill,
    label: treasuryProgress({ status: bill.status }).label,
  }));
  const financeTracked = lineBillNos(line).length > 0 || billRows.length > 0;
  const openBillNo = (no: string) => {
    void fetch(`/api/bill-open?billNo=${encodeURIComponent(no)}`, { method: "POST" }).then((response) => {
      if (!response.ok) throw new Error("bill-open failed");
      showNotice(`正在打开财务系统单据 ${no}——关闭窗口即自动回收；打开新单会替换旧窗口`);
    }).catch(() => {
      navigator.clipboard.writeText(no).catch(() => undefined);
      window.open("https://treasury.ecnu.edu.cn/WFManager/home2.jsp", "_blank");
      showNotice(`自动打开失败；单号 ${no} 已复制——在财务系统「全部报销单」的「报销单号」栏粘贴查询`);
    });
  };
  const renderBills = () => billRows.length > 0 && <span className="bill-status-list">
    {billRows.map((bill) => <span key={bill.billNo} className="bill-status-row">
      报销单 {bill.system && <i className="bill-system">{bill.view === "YBX-全部报销单" ? "智能报销" : bill.view === "YB6-报销单管理" ? "预约报销·在途" : bill.view === "YB6-历史报销单" ? "预约报销·已入账" : bill.system === "YBX" ? "智能报销" : "预约报销"}</i>}
      <button type="button" className="bill-link" title="在财务系统中打开这张报销单" onClick={() => openBillNo(bill.billNo)}>{bill.billNo}</button>
      {line.status === "submitted" && bill.label ? ` · ${bill.label}` : ""}
      {bill.postedAt && <> · <time className="bill-date" dateTime={bill.postedAt}>{bill.postedAt}</time> 入账</>}
      {bill.voucherNo ? ` · 凭证 ${bill.voucherNo}` : ""}
    </span>)}
  </span>;
  // 行标签带品名：从规范文件名抽商品名（date_商户_品名_分类_金额），泛词（账单/支付记录等）不算品名。
  const goodsFromName = (name: string): string => {
    const parts = name.replace(/\.[^.]+$/, "").split("_");
    const generic = /^(账单|支付记录|费用清单|发票|收据|截图|行程单|订单|水单|购买截图|低值设备发票|低值设备购买截图|报账单|资产入账单|套餐价格截图|套餐价格|价格截图|产品页面截图|产品页面|支付记录截图|收据截图)$/;
    // elab 单号段与金额段不是品名——单号在节点小字展示，标题重复显示过长
    const billNoLike = /^[A-Z]{2,6}\d{6,}$/;
    const amountLike = /^(CNY|USD|SGD|EUR|JPY|HKD)[\d.]+$/i;
    const candidates = /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? "") ? parts.slice(2) : parts.slice(1);
    for (const part of candidates) {
      if (part && !generic.test(part) && !billNoLike.test(part) && !amountLike.test(part) && !/^(?:[1-9]|1[0-2])月付款$/.test(part) && part.length <= 10) return part;
    }
    return "";
  };
  const renderSingleRow = (requirement: Requirement, attachment: boolean, files: ReceiptRecord[], index: number, heading?: (label: string) => React.ReactNode) => {
    const key = requirementKey(line.id, requirement.id);
    const resolvedNode = workflow.nodes[requirement.id];
    const file = files[index];
    // elab 前置单（资产入账单/软件服务费报账单）：完成 = 对应系统存在已审核单；[AI 填报] 打开前置弹窗
    const isPreapproval = requirement.templateId === "preapproval";
    const preSystem = requirement.id === "low-value-gear-elab" ? "zcgl" : "wxzc";
    const preBills = isPreapproval ? (line.elabBills ?? []).filter((bill) => bill.system === preSystem) : [];
    const preLatest = preBills.length ? preBills[preBills.length - 1] : null;
    const preApproved = preBills.some((bill) => bill.status === "approved");
    const preStatusText = !preLatest ? requirement.hint : preLatest.status === "approved" ? `${preLatest.billNo} · 已审核通过` : preLatest.status === "draft" ? `${preLatest.billNo} · 草稿（待提交）` : preLatest.status === "rejected" ? `${preLatest.billNo} · 已退回` : `${preLatest.billNo} · 已提交待审`;
    const complete = resolvedNode
      ? resolvedNode.status === "complete" || resolvedNode.status === "manually-confirmed"
      : key in overrides ? overrides[key] : files.length > 0;
    const manuallyConfirmed = complete && !file && overrides[key] === true;
    const goods = goodsFromName(file?.name ?? "");
    const baseLabel = goods ? `${goods} · ${requirement.label}` : requirement.label;
    const paymentMonth = file ? paymentMonths.get(file.path) : undefined;
    const number = materialRowNumber(files, index, materialExpenseLinks, Boolean(resolvedNode?.evidenceTypes?.includes("payment-proof")));
    const rowLabel = `${baseLabel}${number ? `-${number}` : ""}${paymentMonth ? ` · ${paymentMonth}` : ""}`;
    return <div
      className={`requirement-row ${attachment ? "is-attachment" : ""} ${prioritizeIncomplete ? "requirement-row--prioritized" : ""} ${manuallyConfirmed ? "is-manually-confirmed" : ""}`}
      key={files.length > 1 ? `${requirement.id}-${index + 1}` : requirement.id}
    >
      <button
        className={`check-control ${complete ? "is-complete" : ""} ${manuallyConfirmed ? "is-manual" : ""} ${resolvedNode?.status === "blocked" ? "is-blocked" : ""}`}
        title={complete ? "标记为未完成" : "标记为已完成"}
        onClick={() => onToggleRequirement(line.id, requirement.id, !complete)}
      >
        {complete && <Check size={14} />}
      </button>
      <div className="requirement-copy"><strong className={(file && preapprovalCoveredPaths.has(file.path)) || (isPreapproval && preApproved) ? "preapproval-linked" : undefined}>{heading ? heading(rowLabel) : rowLabel}{manuallyConfirmed && "（已提供）"}{index === 0 && (requirement.templateId === "traffic-explanation" || requirement.templateId === "rebooking-explanation") ? <button type="button" className="template-link" disabled={openingTemplate} onClick={() => onAiWrite(line, requirement)} title="根据事实生成草稿并保存为 PDF"><FilePenLine size={12} /> [AI 编写]</button> : index === 0 && requirement.templateId === "preapproval" ? <button type="button" className="template-link" onClick={() => openElabDialog(preSystem)} title={preSystem === "zcgl" ? "AI 填报 elab 材料易耗品低值品报账单，自动提交并自动审核" : "AI 填报 wxzc 软件服务费报账单（保存草稿，科技处人工提交）"}><Sparkles size={12} /> [AI 填报]</button> : index === 0 && requirement.id.endsWith("-fee-schedule") ? <button type="button" className="template-link" onClick={() => onOpenEvidenceSearch(line, requirement)} title="搜索历史费用清单，可按需用 AI 排序或选中引用"><Search size={12} /> [AI 搜索]</button> : index === 0 && requirement.templateId && <button type="button" className="template-link" disabled={openingTemplate} onClick={() => onOpenTemplate(line, requirement)} title="新建临时副本并打开编辑"><FilePenLine size={12} /> [模板]</button>}{file && <button type="button" className="icon-button file-remove" title={`移除 ${file.name}（磁盘文件保留，归档时清理）`} onClick={() => onRemoveMaterial(file.path)}><X size={12} /></button>}</strong><span>{isPreapproval ? preStatusText : manuallyConfirmed ? requirement.hint : complete && file ? fileDisplayName(file) : requirement.hint}</span></div>
      {file ? (
        <FilePreviewTrigger file={file} />
      ) : (
        <label className={`row-action ${uploading ? "is-disabled" : ""}`}><Upload size={14} /> 上传<input hidden disabled={uploading} type="file" multiple accept={ACCEPTED_FILES} onChange={(event) => onUpload(event.target.files, requirement)} /></label>
      )}
    </div>;
  };

  const renderGroup = (group: RequirementGroup, attachment = false) => {
    const required = requiredInGroup(group);
    let complete = required.filter(isComplete).length;
    let total = required.length;
    const useDailyLinks = line.kind === "日常" && Boolean(formalModel);
    // 日常进度读取实际费用关联，差旅保留既有的材料计数。
    if (!attachment && required.length >= 2) {
      const nodeById = new Map(required.map((requirement) => [requirement.id, workflow.nodes[requirement.id]]));
      const hasSupportNode = required.some((requirement) => {
        const types = nodeById.get(requirement.id)?.evidenceTypes ?? [];
        return types.includes("purchase-order") || types.includes("itinerary") || types.includes("payment-proof");
      });
      if (hasSupportNode) {
        // 同金额多期订阅歧义（如每月 SGD30 收据×N + 支付×N）：金额层平局时按文件名日期接近消歧
        const credentials: Array<ReceiptRecord & { amount: number; exempt: boolean; matched: boolean }> = [];
        const supportPool: Array<ReceiptRecord & { amount: number }> = [];
        // 权威配对优先：formalModel.links 的 primary↔itinerary 关联是费用层实证（不依赖金额/文件名日期），
        // 已关联的凭证直接视为已配对、其佐证退出模糊池——开票日与行程日跨度大时金额消歧会失效（2026-10-10 九月集实证）。
        const ringEvidenceByPath = new Map((formalModel?.evidence ?? []).map((item) => [item.path, item]));
        const ringItineraryByExpense = new Map<string, string>();
        for (const link of formalModel?.links ?? []) if (link.role === "itinerary") ringItineraryByExpense.set(link.expenseId, link.evidenceId);
        const ringLinkedPaths = new Set<string>();
        for (const requirement of required) {
          const types = nodeById.get(requirement.id)?.evidenceTypes ?? [];
          const isCredential = types.includes("invoice") || types.includes("receipt");
          const isSupport = types.includes("purchase-order") || types.includes("itinerary") || types.includes("payment-proof");
          if (!isCredential && !isSupport) continue;
          for (const record of findRequirementFiles(lineRecords, requirement)) {
            const amount = record.amount;
            if (amount == null) continue;
            if (isCredential) credentials.push({ ...record, amount, exempt: record.path.includes("上海监制"), matched: false });
            else supportPool.push({ ...record, amount });
          }
        }
        const supportedExpenseIds = new Set(supportPool.flatMap((record) => {
          const link = materialExpenseLinks.get(record.path);
          return link && !link.primary ? [link.expenseId] : [];
        }));
        for (const credential of credentials) {
          if (useDailyLinks) {
            const link = materialExpenseLinks.get(credential.path);
            credential.matched = Boolean(link?.primary && supportedExpenseIds.has(link.expenseId));
            continue;
          }
          const evidence = ringEvidenceByPath.get(credential.path);
          if (!evidence) continue;
          const primary = (formalModel?.links ?? []).find((lk) => lk.evidenceId === evidence.id && lk.role === "primary");
          if (!primary) continue;
          const itinId = ringItineraryByExpense.get(primary.expenseId);
          const itinEv = itinId ? ringEvidenceByPath.get((formalModel?.evidence ?? []).find((item) => item.id === itinId)?.path ?? "") : null;
          if (itinEv && itinEv.path.startsWith(`${line.folder}/`)) {
            credential.matched = true;
            ringLinkedPaths.add(itinEv.path);
          }
        }
        // 已被 link 配对的佐证退出模糊池
        total = credentials.length;
        const pool = supportPool.filter((support) => !ringLinkedPaths.has(support.path));
        const matchLayer = (tier: AmountMatchTier) => {
          for (const credential of credentials) {
            if (credential.exempt || credential.matched) continue;
            const candidates = pool.filter((entry) => entry.currency === credential.currency
              && withinAmountTier(entry.amount, credential.amount, credential.currency, tier));
            const match = chooseReceiptPair(credential, candidates);
            if (match) {
              pool.splice(pool.indexOf(match), 1);
              credential.matched = true;
            }
          }
        };
        if (!useDailyLinks) {
          matchLayer("precision");
          matchLayer("nearby");
        }
        complete = credentials.filter((credential) => credential.exempt || credential.matched).length;
        // elab 前置单（资产入账单/软件服务费报账单）不是文件凭证，圆环配对不覆盖——独立计入分母，完成=存在已审核单
        const preapprovalNodes = required.filter((requirement) => requirement.templateId === "preapproval");
        for (const requirement of preapprovalNodes) {
          const system = requirement.id === "low-value-gear-elab" ? "zcgl" : "wxzc";
          if ((line.elabBills ?? []).some((bill) => bill.system === system && bill.status === "approved")) complete += 1;
        }
        total += preapprovalNodes.length;
      }
    }
    const progress = total ? Math.round((complete / total) * 100) : 0;
    const orderedRequirements = prioritizeIncomplete
      ? [...sortIncompleteFirst(required, isComplete), ...group.requirements.filter((requirement) => requirement.optional)]
      : group.requirements;
    const groupTotalCny = formalModel ? groupAmountCny(formalModel, line.id, orderedRequirements.flatMap(
      (requirement) => findRequirementFiles(lineRecords, requirement).map((record) => record.path),
    )) : 0;
    return <section className={`bundle-row ${attachment ? "bundle-row--attachment" : ""}`} key={group.id}>
      <div className="progress-ring" style={{ "--progress": `${progress}%` } as React.CSSProperties} title={groupTotalCny > 0 ? `本组费用合计 CNY ${groupTotalCny.toFixed(2)}` : undefined}
        onMouseEnter={(event) => { if (groupTotalCny > 0) { const rect = event.currentTarget.getBoundingClientRect(); setRingTip({ x: rect.left + rect.width / 2, y: rect.bottom + 8, text: `本组费用合计 CNY ${groupTotalCny.toFixed(2)}` }); } }}
        onMouseLeave={() => setRingTip(null)}>
        <span>{complete}/{total}</span>
      </div>
      <div className="bundle-body"><header><div><strong>{group.label}</strong><span>{group.hint}</span></div></header><div className="bundle-items">{(() => {
              const rows: React.ReactNode[] = [];
              const fileless: Requirement[] = [];
              const entries: Array<{ requirement: Requirement; files: ReceiptRecord[]; index: number; file: ReceiptRecord }> = [];
              for (const requirement of orderedRequirements) {
                if (requirement.templateId === "preapproval") continue;
                const resolvedNode = workflow.nodes[requirement.id];
                const files = resolvedNode?.files?.length ? resolvedNode.files : findRequirementFiles(lineRecords, requirement);
                if (!files.length) fileless.push(requirement);
                files.forEach((file, index) => entries.push({ requirement, files, index, file }));
              }
              let tone = 0;
              const materialGroups = attachment ? entries.map((entry) => [entry]) : groupLinkedMaterials(entries, materialExpenseLinks, sharedSchedules);
              for (const [head, ...rest] of materialGroups) {
                if (!rest.length && (attachment || !isExpenseMaterial(head.file))) {
                  rows.push(renderSingleRow(head.requirement, attachment, head.files, head.index));
                  continue;
                }
                rows.push(<MatchedMaterialGroup key={`${head.requirement.id}:${head.file.path}`} tone={tone++}
                  renderHeading={(heading) => renderSingleRow(head.requirement, attachment, head.files, head.index, heading)}>
                  {rest.length ? rest.map((entry) => renderSingleRow(entry.requirement, attachment, entry.files, entry.index)) : null}
                </MatchedMaterialGroup>);
              }
              for (const requirement of fileless) rows.push(renderSingleRow(requirement, attachment, [], 0));
              // 前置单按未完成优先排序：无已审核单（未完成）置顶，已完成殿尾
              const preTop: React.ReactNode[] = [];
              const preTail: React.ReactNode[] = [];
              for (const requirement of group.requirements) {
                if (requirement.templateId !== "preapproval") continue;
                const system = requirement.id === "low-value-gear-elab" ? "zcgl" : "wxzc";
                const done = (line.elabBills ?? []).some((bill) => bill.system === system && bill.status === "approved");
                const preFiles = (() => { const node = workflow.nodes[requirement.id]; return node?.files?.length ? node.files : findRequirementFiles(lineRecords, requirement); })();
                (done ? preTail : preTop).push(renderSingleRow(requirement, attachment, preFiles, 0));
              }
              return [...preTop, ...rows, ...preTail];
            })()}</div></div>
    </section>;
  };

  return <>
    <article
      className={`line-card line-card--${line.status} ${isDropTarget ? "is-drop-target" : ""} ${treasuryPulsing ? "is-treasury-pulse" : ""}`}
      onDragOver={(event) => {
        if (line.status !== "active") return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setIsDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDropTarget(false);
      }}
      onDrop={(event) => {
        if (line.status !== "active") return;
        event.preventDefault();
        setIsDropTarget(false);
        onUpload(event.dataTransfer.files);
      }}
    >
      {ringTip && <i className="ring-amount" style={{ left: ringTip.x, top: ringTip.y }} role="presentation">{ringTip.text}</i>}
      {onlineJob && <OnlineJobOverlay job={onlineJob} onDecide={onOnlineDecide} onDismiss={() => onDismissOnlineJob(line.id)} onArchive={() => { onDismissOnlineJob(line.id); onArchive(line); }} onStop={onStopOnlineJob} />}
      <header className="line-header">
        <div>
          <div className="line-meta"><span>{line.createdAt}</span><i /> {line.status === "active"
            ? <span className="kind-menu-wrapper">
                <button type="button" className="kind-menu-trigger" onClick={() => setKindMenuOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={kindMenuOpen} aria-label="切换票据集类型">{line.kind}<ChevronDown size={11} className={kindMenuOpen ? "is-open" : ""} /></button>
                {kindMenuOpen && <>
                  <span className="dialog-backdrop kind-menu-backdrop" role="presentation" onMouseDown={() => setKindMenuOpen(false)} />
                  <div className="kind-menu" role="listbox">
                    {(["国际会议", "国内会议", "国内差旅", "日常"] as const).map((item) => <button key={item} type="button" role="option" aria-selected={item === line.kind} className={item === line.kind ? "is-current" : ""} onClick={() => { setKindMenuOpen(false); if (item !== line.kind) onChangeKind(line, item); }}>{item === line.kind && <Check size={11} />}{item}</button>)}
                  </div>
                </>}
              </span>
            : <span>{line.kind}</span>}
          {line.status !== "archived" && lineTotalCny > 0 && <><i /><span className="line-total" title="票据集中已识别金额的 CNY 合计（含汇率折算）">合计 CNY {lineTotalCny.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></>}</div>
          <div className="line-title-row">
            <h2 aria-label={line.title}>
              {line.title.slice(0, line.title.length - titleEnd.length)}
              <span className="line-title-end">
                {titleEnd}
                {line.status === "active"
                  ? <button type="button" className="guide-button" onClick={() => setGuideOpen(true)}><BookOpen size={13} /> 流程关系</button>
                  : <button type="button" className="guide-button" title="报销详情" aria-label="报销详情" aria-haspopup="dialog" onClick={() => setDetailOpen(true)}><Clock3 size={18} aria-hidden="true" /></button>}
              </span>
            </h2>
          </div>
        </div>
        <div className="line-header-actions">
          {line.status === "active" && <button className="icon-button line-refresh" title="重新对齐已有文件" disabled={refreshing} onClick={() => onRefreshLine(line)}><RefreshCw size={16} className={refreshing ? "spin" : ""} /></button>}
          <button type="button" className={`line-status line-status--${line.status === "active" ? "active" : line.status === "archived" ? "archived" : billsPosted ? "posted" : financeTracked && !progress.posted ? progress.stage : "untracked"} line-status--ask`} title="问问 AI：关于这个票据集的金额、材料、流程" onClick={() => onAskAi(line)}>
            {line.status === "active" ? "进行中" : line.status === "archived" ? "已归档" : billsPosted ? "已入账 · 待归档" : financeTracked ? progress.posted ? "等待全部单据入账" : progress.label : "待确认"}
          </button>
        </div>
      </header>

      {line.status === "active" ? (
        <>
          {isDropTarget && <div className="drop-overlay"><Upload size={24} /><strong>松开以加入“{line.title}”</strong><span>支持一次拖入多个文件</span></div>}
          <div className="requirement-list">
            {line.kind === "日常" ? groups.map((group) => renderGroup(group)) : <>
              {requiredGroups.length > 0 && <section className="material-group"><p>报销必填</p>{requiredGroups.map((group) => renderGroup(group))}</section>}
              {optionalGroups.length > 0 && <section className="material-group"><p>按实际发生补充</p>{optionalGroups.map((group) => renderGroup(group))}</section>}
            </>}
            {attachments.length > 0 && <section className="material-group material-group--attachments"><p>归档附件</p>{renderGroup({ id: "attachments", label: "项目附件", hint: "随票据集保存与归档", requirements: attachments }, true)}</section>}
          </div>
          <ElabBillsSection inlineEntry={false} forceOpen={elabDialogOpen} presetSystem={elabPresetSystem} onClose={() => setElabDialogOpen(false)} line={line} expenses={lineDedupe.kept} onSave={onSaveElabBills} refreshLine={onRefreshRecords} onSaveProject={onSaveProject} budgets={budgets} />
          <footer className="line-footer">
            <input ref={bulkInput} hidden type="file" multiple accept={ACCEPTED_FILES} onChange={(event) => onUpload(event.target.files)} />
            <button className="quiet-button" disabled={uploading} onClick={() => bulkInput.current?.click()}><Upload size={16} /> 批量补充</button>
            {/* 流程提示（elab/wxzc/图书馆验收等长文案）不入页面平铺——elab 前置见弹窗，其余在递交面板核验处呈现 */}
            <span className={`line-file-count ${formalIssues.length ? "is-model-issue" : ""}`}>{formalIssues.length ? formalIssues[0] : `已收录 ${lineRecords.length} 份文件`}</span>
            <button className={`archive-button ${billsPosted ? "" : "is-manual"}`} title={billsPosted ? "归档" : "手动归档材料"} onClick={() => onArchive(line)}><Archive size={16} /> 归档</button>
            <button className={`submit-button ${allDone ? "" : "is-conditional"}`} title={allDone ? "打开递交清单" : "存在未完成材料项——可仍递交（如拆分递交或部分打印），建议先核对清单"} onClick={() => onOpenSubmit(line)}><Send size={16} /> 递交</button>
          </footer>
        </>
      ) : line.status === "submitted" ? (
        <>
        <div className="observation-panel submitted-status-row">
          <span className="line-row-icon" aria-hidden="true">📤</span>
          <div>
            <strong>已于 {line.submittedAt} 递交{line.treasuryAmountCny != null ? ` · 申请 CNY ${line.treasuryAmountCny.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}</strong>
            {renderBills()}
            <span>
              {billsPosted
                ? "全部单据已入账，可归档。"
                : `${financeTracked && progress.posted ? "等待全部已登记单据入账" : line.treasuryStatus || financeTracked ? progress.label : "待匹配财务报销单"}。点击「刷新递交状态」可同步。`}
            </span>
          </div>
          <button className="archive-button" disabled={!billsPosted} title={billsPosted ? "归档" : financeTracked ? "等待全部已登记单据入账" : "待匹配财务报销单"} onClick={() => onArchive(line)}><Archive size={16} /> 归档</button>
        </div>
        <div className="archived-row submitted-status-row">
          <button type="button" className={`archived-panel submitted-materials-panel ${submittedExpanded ? "is-expanded" : ""}`} onClick={() => setSubmittedExpanded((expanded) => !expanded)}><span className="line-row-icon" aria-hidden="true">📁</span><span className="archived-panel-copy"><strong>已递交材料 · {lineRecords.length} 份{lineTotalCny > 0 ? ` · 发票合计 CNY ${lineTotalCny.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ""}</strong><span>{submittedExpanded ? "再点收起。" : "展开查看递交材料。"}</span></span></button>
          <button type="button" className="quiet-button restore-button" title="还原：撤销递交，退回进行中" onClick={() => onRestore(line)}><Undo2 size={15} /> 还原</button>
        </div>
        </>
      ) : (
        <>
          <div className="archived-row">
          <div className="archived-summary">
            <button type="button" className={`archived-panel ${archivedExpanded ? "is-expanded" : ""}`} aria-expanded={archivedExpanded} onClick={() => setArchivedExpanded((expanded) => !expanded)}><span className="line-row-icon" aria-hidden="true">🗃️</span><span className="archived-panel-copy"><strong>已归档 · {lineRecords.length} 份材料</strong>{!billRows.length && <span>{lineBillNos(line).length ? `报销单 ${lineBillNos(line).join("、")} · ${line.treasuryPostedAt || "尚未"}入账` : archivedExpanded ? "原始文件仍保留在本机目录。" : "展开查看归档材料。"}</span>}</span></button>
            {billRows.length > 0 && <div className="archived-bills">{renderBills()}</div>}
          </div>
          {!isArchiveLocked(line) && <button type="button" className="quiet-button restore-button" title="撤销当前归档" onClick={() => onRestore(line)}><Undo2 size={15} /> 还原</button>}
          </div>
        </>
      )}
      {((line.status === "submitted" && submittedExpanded) || (line.status === "archived" && archivedExpanded)) && lineRecords.length > 0 && (
        <div className="archived-file-list">
          {(() => {
            let tone = 0;
            return groupLinkedMaterials(lineRecords.map((file) => ({ file })), materialExpenseLinks, sharedSchedules).map(([{ file }, ...rest]) => rest.length || isExpenseMaterial(file)
              ? <MatchedMaterialGroup key={file.path} tone={tone++} renderHeading={(heading) => renderArchivedFile(file, heading)}>
                  {rest.length ? rest.map((entry) => renderArchivedFile(entry.file)) : null}
                </MatchedMaterialGroup>
              : renderArchivedFile(file));
          })()}
        </div>
      )}
    </article>
    {line.status === "active" && guideOpen && <Suspense fallback={null}><ProcessGuideDialog title={line.title} kind={line.kind} onClose={() => setGuideOpen(false)} /></Suspense>}
    {line.status !== "active" && detailOpen && <TreasuryDetailDialog line={line} budgets={budgets} materialCount={lineRecords.length} invoiceTotal={lineTotalCny} onOpenBill={openBillNo} onClose={() => setDetailOpen(false)} />}
  </>;
}

function NewLineDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, kind: ExpenseLine["kind"]) => void }) {
  const now = new Date();
  // 预填参考历史标题惯例：会议以名称开头，差旅带月份与地点，日常按月份命名
  const templates: Record<ExpenseLine["kind"], string> = {
    "国际会议": `${now.getFullYear()} 国际会议`,
    "国内会议": `${now.getFullYear()} 学术会议`,
    "国内差旅": `${now.getFullYear()} 年 ${now.getMonth() + 1} 月差旅`,
    "日常": `${now.getFullYear()} 年 ${now.getMonth() + 1} 月日常票据`,
  };
  const placeholders: Record<ExpenseLine["kind"], string> = {
    "国际会议": "可直接使用或改成：国际学术会议、会议注册",
    "国内会议": "可直接使用或改成：国内学术会议、研讨会",
    "国内差旅": "可改成：8月北京差旅、7月杭州住宿——补地点与事由",
    "日常": "有主题时可改成：本季度云服务",
  };
  const examples: Record<ExpenseLine["kind"], string> = {
    "国际会议": "国际学术会议",
    "国内会议": "国内学术会议",
    "国内差旅": "8月北京差旅",
    "日常": "2026 年 7 月日常票据",
  };
  const [title, setTitle] = useState(templates["国内会议"]);
  const [kind, setKind] = useState<ExpenseLine["kind"]>("国内会议");
  const switchKind = (item: ExpenseLine["kind"]) => {
    setKind(item);
    // 标题为空或仍是某个类型的预填模板 → 换成新类型预填；用户已自定义 → 保留
    setTitle((current) => (!current.trim() || Object.values(templates).some((value) => value.trim() === current.trim()) ? templates[item] : current));
  };
  return <div className="dialog-backdrop" role="presentation"><form className="new-line-dialog" onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return; onCreate(title.trim(), kind); }}>
    <header><div><span>NEW SET</span><h2>新建票据集</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
    <label>名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={placeholders[kind]} /></label>
    <p className="elab-form-hint">示例：{examples[kind]}——历史标题可在递交清单摘要里参考，改掉预填即可。</p>
    <fieldset><legend>类型</legend><div className="type-switch">{(["国际会议", "国内会议", "国内差旅", "日常"] as const).map((item) => <button key={item} type="button" className={kind === item ? "selected" : ""} onClick={() => switchKind(item)}>{item}</button>)}</div></fieldset>
    <p>{kind === "国际会议" ? "将建立出访与出入境、会议注册、交通与住宿材料检查。" : kind === "国内会议" ? "将建立交通、住宿，以及按实际发生补充的注册费材料。" : kind === "国内差旅" ? "将建立交通与住宿材料检查，不包含会议注册材料。" : "将建立发票/收据与支付记录两项检查。"}</p>
    <footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="create-button" type="submit"><Plus size={16} /> 创建票据集</button></footer>
  </form></div>;
}

function TrafficNoteDialog({ line, records, settings, profileId, signatureAvailable, onClose, onQueued }: { line: ExpenseLine; records: ReceiptRecord[]; settings: AiSettings; profileId: string; signatureAvailable: boolean; onClose: () => void; onQueued: (jobId: string) => void }) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [useSignature, setUseSignature] = useState(signatureAvailable);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const clues = useMemo(() => records.filter((record) => record.path.startsWith(`${line.folder}/`) && /打车|出租|滴滴|高德|行程/.test(record.name)).map((record) => `${record.invoiceDate ?? record.modifiedAt.slice(0, 10)} ${record.name}`).join("\n"), [line.folder, records]);
  const reasonOptions = ["距离较远，公共交通换乘时间长", "行程时间紧，需按时参加后续活动", "携带材料或行李，公共交通不便", "同行出行，需保障整体行程衔接"];
  const generate = async () => { setLoading(true); setError(""); try { const trafficDate = clues.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? ""; const response = await fetch("/api/ai-traffic-note", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ background: true, backend: settings.backend, model: settings.model, profileId, useSignature, folder: line.folder, trafficDate, context: `票据集：${line.title}\n已上传交通材料：\n${clues || "无可识别交通材料"}\n理由：${reasons.join("；")}\n补充：${extra}` }) }); const body = await response.json() as { jobId?: string; error?: string }; if (response.status !== 202 || !body.jobId) throw new Error(body.error || "无法启动交通说明生成"); onQueued(body.jobId); onClose(); } catch (generationError) { setError(generationError instanceof Error ? generationError.message : "AI 编写失败"); } finally { setLoading(false); } };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="traffic-note-dialog" role="dialog" aria-modal="true" aria-labelledby="traffic-note-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span>AI WRITE</span><h2 id="traffic-note-title">交通情况说明</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header><label>已识别交通材料<textarea readOnly value={clues || "尚未识别到交通票据；请先上传对应交通材料。"} /></label><fieldset><legend>选择理由</legend><div className="reason-options">{reasonOptions.map((reason) => <label key={reason}><input type="checkbox" checked={reasons.includes(reason)} onChange={() => setReasons((current) => current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason])} />{reason}</label>)}</div></fieldset><label>补充信息（可选）<textarea value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="例如活动地点、同行人或必须打车的特殊原因" /></label><label className="signature-option"><input type="checkbox" checked={useSignature} disabled={!signatureAvailable} onChange={(event) => setUseSignature(event.target.checked)} />使用电子签名</label>{error && <p className="backend-error">{error}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="create-button" disabled={loading || settings.backend === "off"} onClick={() => void generate()}>{loading ? "生成并上传中" : "AI 生成并上传"}</button></footer></section></div>;
}

const ASK_AI_TEMPLATES = [
  { id: "amount-audit", label: "金额一致性分析", hint: "对比材料合计与报销单申请金额" },
  { id: "completeness", label: "材料完整性检查", hint: "缺件与合规风险清单" },
  { id: "status-explain", label: "状态与下一步", hint: "解读流程阶段" },
] as const;

type AskAiMessage = { q: string; a: string };

function AskAiDialog({ line, settings, onClose }: { line: ExpenseLine; settings: AiSettings; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AskAiMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 打字机效果：记录最新一条 AI 回答已显示的字符数，逐帧推进
  const [typedChars, setTypedChars] = useState<number>(Number.MAX_SAFE_INTEGER);
  const latestIndex = messages.length - 1;
  useEffect(() => {
    const latest = messages[latestIndex];
    if (!latest || typedChars >= latest.a.length) return;
    const timer = window.setTimeout(() => {
      setTypedChars((current) => Math.min(latest.a.length, current + Math.max(2, Math.ceil(latest.a.length / 160))));
      const thread = document.querySelector(".ask-thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
    }, 16);
    return () => window.clearTimeout(timer);
  }, [messages, typedChars, latestIndex]);
  const ask = async (payload: { templateId?: string; question?: string }, displayLabel: string) => {
    if (loading || (!payload.templateId && !payload.question?.trim())) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/ask-ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setId: line.id, ...payload, history: messages.slice(-4), backend: settings.backend, model: settings.model }) });
      const body = await response.json() as { answer?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "AI 回答失败");
      setMessages((previous) => [...previous, { q: displayLabel, a: body.answer ?? "" }]);
      setTypedChars(0);
      setQuestion("");
    } catch (askError) { setError(askError instanceof Error ? askError.message : "AI 回答失败"); } finally { setLoading(false); }
  };
  return <div className="dialog-backdrop ai-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ai-settings-dialog ask-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ask-ai-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>ASK AI</span><h2 id="ask-ai-title">问问 AI · {line.title}</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      {settings.backend === "off"
        ? <p className="backend-status">尚未配置 AI 后端：请先在右侧工具条中设置模型并保存 API Key，再回来提问。</p>
        : <>
      <div className="ask-ai-templates">
        {ASK_AI_TEMPLATES.map((template) => (
          <button key={template.id} type="button" className="ask-template" title={template.hint} disabled={loading} onClick={() => void ask({ templateId: template.id }, template.label)}>{template.label}</button>
        ))}
      </div>
      {messages.length > 0 && <div className="ask-thread">
        {messages.map((message, index) => {
          const typing = index === latestIndex && typedChars < message.a.length;
          const visible = index === latestIndex ? message.a.slice(0, typedChars) : message.a;
          return (
            <div key={index} className="ask-message">
              <div className="ask-bubble ask-bubble--user"><span className="ask-avatar ask-avatar--user">我</span><p>{message.q}</p></div>
              <div className={`ask-bubble ask-bubble--ai ${typing ? "is-typing" : ""}`}>
                <span className="ask-avatar ask-avatar--ai">AI</span>
                <div className="ask-answer" dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(visible) }} />
                {typing && <span className="ask-caret" aria-hidden="true">▼</span>}
              </div>
            </div>
          );
        })}
        {loading && <div className="ask-bubble ask-bubble--ai is-loading"><span className="ask-avatar ask-avatar--ai">AI</span><span className="ask-dots" aria-label="思考中"><i /><i /><i /></span></div>}
      </div>}
      {error && <p className="backend-status is-error">{error}</p>}
      <div className="ask-composer">
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={loading ? "思考中…" : "选择上方模板一键提问，或输入自定义问题（Enter 发送）"} rows={2} disabled={loading} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask({ question }, question.trim()); } }} />
        <button type="button" className="submit-button" disabled={loading || !question.trim()} onClick={() => void ask({ question }, question.trim())}>{loading ? <>思考中…</> : <><Send size={14} /> 提问</>}</button>
      </div>
      </>}
    </section>
  </div>;
}

/** 本地检索历史费用清单，按需用 AI 排序，选中后以符号链接引用。 */
function EvidenceSearchDialog({ line, requirement, settings, onClose, onLinked }: { line: ExpenseLine; requirement: Requirement; settings: AiSettings; onClose: () => void; onLinked: (path: string, metadata: ReceiptMeta, name: string) => void }) {
  // 默认搜索词从材料项名称派生（「ChatGPT Pro 费用清单」→「ChatGPT Pro」）：打开即按订阅主体定向检索，可清空改查。
  const defaultQuery = requirement.label.replace(/费用清单\s*$/, "").trim();
  const [query, setQuery] = useState(defaultQuery);
  const [candidates, setCandidates] = useState<Array<{ path: string; name: string; setTitle: string; documentDate: string; amount: number | null; currency: string; issuer: string; reason: string }>>([]);
  const [degraded, setDegraded] = useState(false);
  const [searchPhase, setSearchPhase] = useState<"local" | "ai" | null>("local");
  const [linkingPath, setLinkingPath] = useState("");
  const [error, setError] = useState("");
  const search = async (searchQuery: string, rerank = false) => {
    setSearchPhase(rerank ? "ai" : "local"); setError(""); setDegraded(false);
    try {
      const response = await fetch("/api/evidence-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lineId: line.id, nodeId: requirement.id, query: searchQuery, rerank, backend: settings.backend, model: settings.model }) });
      const body = await response.json() as { candidates?: typeof candidates; degraded?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? "历史材料检索失败");
      setCandidates(body.candidates ?? []);
      setDegraded(Boolean(body.degraded));
    } catch (searchError) { setError(searchError instanceof Error ? searchError.message : "历史材料检索失败"); } finally { setSearchPhase(null); }
  };
  useEffect(() => { void search(defaultQuery); /* 打开即按默认词检索 */ }, []);
  const candidateRecord = (candidate: { path: string; name: string }): ReceiptRecord => ({
    path: candidate.path,
    name: candidate.name,
    folder: candidate.path.split("/").slice(0, -1).join("/"),
    ext: (candidate.name.split(".").pop() ?? "").toLowerCase(),
    size: 0,
    modifiedAt: "",
    category: "其他",
    status: "待识别",
    currency: "CNY",
  });
  const link = async (candidate: { path: string; name: string }) => {
    if (linkingPath) return;
    setLinkingPath(candidate.path); setError("");
    try {
      const response = await fetch("/api/evidence-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lineId: line.id, nodeId: requirement.id, sourcePath: candidate.path }) });
      const body = await response.json() as { path?: string; metadata?: ReceiptMeta; error?: string };
      if (!response.ok || !body.path || !body.metadata) throw new Error(body.error ?? "链接失败");
      onLinked(body.path, body.metadata, candidate.name);
      onClose();
    } catch (linkError) { setError(linkError instanceof Error ? linkError.message : "链接失败"); setLinkingPath(""); }
  };
  return <div className="dialog-backdrop ai-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ai-settings-dialog evidence-search-dialog" role="dialog" aria-modal="true" aria-labelledby="evidence-search-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>AI 搜索</span><h2 id="evidence-search-title">历史费用清单 · {requirement.label}</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <p className="evidence-search-hint">订阅类费用（如 ChatGPT Pro、云服务）逐月发生，费用清单通常每月相同：从历史材料选一份复用即可，选中后以<strong>符号链接</strong>挂入《{line.title}》——同一文件不占双份空间，源文件保持在原票据集。鼠标悬浮「预览」可查看材料内容。</p>
      <div className="evidence-search-bar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索关键词" placeholder="服务商或订阅名称" disabled={searchPhase !== null} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(query); } }} />
        <button type="button" className="submit-button" disabled={searchPhase !== null} onClick={() => void search(query)}><Search size={14} /> {searchPhase === "local" ? "检索中" : "搜索"}</button>
        {settings.backend !== "off" && <button type="button" className="quiet-button" disabled={searchPhase !== null || !candidates.length} onClick={() => void search(query, true)}><Sparkles size={14} /> {searchPhase === "ai" ? "排序中…" : "AI 排序"}</button>}
      </div>
      {degraded && <p className="backend-status">AI 排序暂不可用，仍可按本地结果选用。</p>}
      {error && <p className="backend-status is-error">{error}</p>}
      {candidates.length === 0 && !searchPhase && !error && <p className="backend-status">没有找到历史费用清单材料——该材料项或全库尚无同类清单，请直接上传新文件。</p>}
      <div className="evidence-search-list">
        {candidates.map((candidate) => (
          <div key={candidate.path} className="evidence-search-item">
            <div className="evidence-search-copy">
              <strong>{candidate.name}</strong>
              <span>{[candidate.setTitle || "未知票据集", candidate.issuer, candidate.documentDate, candidate.amount != null ? `${candidate.amount} ${candidate.currency}`.trim() : ""].filter(Boolean).join(" · ")}{candidate.reason ? ` —— ${candidate.reason}` : ""}</span>
            </div>
            <div className="evidence-search-actions">
              <FilePreviewTrigger file={candidateRecord(candidate)} label="预览" />
              <button type="button" className="submit-button" disabled={linkingPath !== ""} onClick={() => void link(candidate)}>{linkingPath === candidate.path ? "链接中…" : "使用此份"}</button>
            </div>
          </div>
        ))}
        {searchPhase === "local" && candidates.length === 0 && <p className="backend-status">正在从历史材料中检索…</p>}
      </div>
    </section>
  </div>;
}

function RebookingNoteDialog({ line, records, settings, profileId, signatureAvailable, onClose, onQueued }: { line: ExpenseLine; records: ReceiptRecord[]; settings: AiSettings; profileId: string; signatureAvailable: boolean; onClose: () => void; onQueued: (jobId: string) => void }) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [useSignature, setUseSignature] = useState(signatureAvailable);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const clues = useMemo(() => records.filter((record) => record.path.startsWith(`${line.folder}/`) && /机票|航班|登机|航旅|行程单|改签/.test(record.name)).map((record) => `${record.invoiceDate ?? record.modifiedAt.slice(0, 10)} ${record.name}`).join("\n"), [line.folder, records]);
  const reasonOptions = ["原计划行程临时取消，需提前返回", "行程时间变更，原航班不合适", "会议或活动日程调整", "航班取消或延误，被动改签"];
  const generate = async () => { setLoading(true); setError(""); try { const noteDate = clues.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? ""; const response = await fetch("/api/ai-rebooking-note", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ background: true, backend: settings.backend, model: settings.model, profileId, useSignature, folder: line.folder, noteDate, context: `票据集：${line.title}\n已上传机票材料：\n${clues || "无可识别机票材料"}\n改签原因：${reasons.join("；")}\n补充：${extra}` }) }); const body = await response.json() as { jobId?: string; error?: string }; if (response.status !== 202 || !body.jobId) throw new Error(body.error || "无法启动改签说明生成"); onQueued(body.jobId); onClose(); } catch (generationError) { setError(generationError instanceof Error ? generationError.message : "改签说明生成失败"); } finally { setLoading(false); } };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="traffic-note-dialog" role="dialog" aria-modal="true" aria-labelledby="rebooking-note-title" onMouseDown={(event) => event.stopPropagation()}><header><div><span>AI WRITE</span><h2 id="rebooking-note-title">机票改签情况说明</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header><label>已识别机票材料<textarea readOnly value={clues || "尚未识别到机票材料；请先上传对应票据。"} /></label><fieldset><legend>选择改签原因</legend><div className="reason-options">{reasonOptions.map((reason) => <label key={reason}><input type="checkbox" checked={reasons.includes(reason)} onChange={() => setReasons((current) => current.includes(reason) ? current.filter((item) => item !== reason) : [...current, reason])} />{reason}</label>)}</div></fieldset><label>补充信息（可选）<textarea value={extra} onChange={(event) => setExtra(event.target.value)} placeholder="例如原计划安排、取消原因、改签航班与费用金额" /></label><label className="signature-option"><input type="checkbox" checked={useSignature} disabled={!signatureAvailable} onChange={(event) => setUseSignature(event.target.checked)} />使用电子签名</label>{error && <p className="backend-error">{error}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="create-button" disabled={loading || settings.backend === "off"} onClick={() => void generate()}>{loading ? "生成并上传中" : "AI 生成并上传"}</button></footer></section></div>;
}

function printerStatusTone(printer: PrinterEntry): "success" | "warning" | "failed" {
  if (printer.state === "disabled" || !printer.accepting || printer.reachable === false) return "failed";
  if (printer.reachable === null || printer.state === "printing" || printer.state === "unknown") return "warning";
  return "success";
}

function printerStatusLabel(printer: PrinterEntry, platform?: string) {
  if (printer.state === "disabled") return "已暂停";
  if (!printer.accepting) return "不接受任务";
  if (printer.reachable === false) return printer.isNetwork ? "网络不可达" : "连接异常";
  if (printer.state === "printing") return "打印中";
  if (printer.reachable === null) return platform === "win32" ? (printer.state === "idle" ? "队列就绪" : "状态待确认") : "检测中";
  return printer.isNetwork ? "在线" : "就绪";
}

function configuredPrinterIssue(summary: PrinterSummary | null) {
  if (!summary) return "打印机状态检测中";
  if (!summary.configured) return "尚未配置打印机";
  const printer = summary.printers.find((entry) => entry.name === summary.configured);
  if (!printer) return "已配置的打印机不存在，请重新选择";
  if (printer.state === "disabled") return "打印机已暂停，请检查打印机面板";
  if (!printer.accepting) return "打印机暂不接受任务";
  if (printer.reachable === false) return "打印机网络不可达，请确认在同一网络";
  if (printer.reachable === null && summary.platform !== "win32") return "打印机状态检测中";
  return "";
}

function PrintSettingsDialog({ summary, loading, onClose, onSelect, onRefresh }: { summary: PrinterSummary | null; loading: boolean; onClose: () => void; onSelect: (printer: string) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previousOverflow; }; }, []);
  const select = async (printer: string) => {
    if (printer === summary?.configured) return;
    setSaving(printer);
    setError("");
    try { await onSelect(printer); } catch (selectError) { setError(selectError instanceof Error ? selectError.message : "无法保存打印机配置"); } finally { setSaving(""); }
  };
  return <div className="dialog-backdrop print-settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="print-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="print-settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>PRINTER</span><h2 id="print-settings-title">打印机</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <p className="print-settings-hint">{summary?.platform === "win32" ? "Windows 打印使用系统打印队列。出纸后可在递交清单确认。" : "网络打印机需与电脑处于同一网络；每次打印前会检测连通性。"}</p>
      <div className="printer-list">
        {loading && !summary ? <div className="empty-state printer-scanning"><LoaderCircle className="spin" size={18} /><span>正在扫描打印机</span></div>
          : summary?.printers.length ? summary.printers.map((printer) => {
            const tone = printerStatusTone(printer);
            const selectedPrinter = printer.name === summary.configured;
            return <button type="button" key={printer.name} className={`printer-row ${selectedPrinter ? "is-selected" : ""}`} disabled={Boolean(saving)} onClick={() => void select(printer.name)}>
              <i className={`validation-dot ${tone}`} title={printerStatusLabel(printer, summary?.platform)} />
              <span className="printer-copy"><strong>{printer.name}</strong><small>{printer.deviceUri ? printer.deviceUri.replace(/^[a-z]+:\/\//i, "").split(/[/?]/)[0] || printer.deviceUri : "未识别连接方式"}</small></span>
              <span className={`printer-state printer-state--${tone}`}>{printerStatusLabel(printer, summary?.platform)}</span>
              {selectedPrinter && <Check size={15} className="printer-selected-mark" />}
            </button>;
          }) : <p className="printer-empty">未发现系统打印机；请先在系统设置中添加打印机。</p>}
      </div>
      {error && <p className="backend-error">{error}</p>}
      <footer><button type="button" className="quiet-button" disabled={loading} onClick={() => void onRefresh()}>{loading ? "检测中" : "重新检测"}</button><button type="button" className="create-button" onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}

function SubmitDialog({ line, records, printLog, unconfirmedPrintHashes, onPrintConfirm, printerSummary, formalModel, applicantName, employeeId, firstRunDelivery, onClose, onPrint, onManualSubmit, onSaveDelivery, onSaveProject, onSplitLine, onOnlineSubmitted }: {
  line: ExpenseLine;
  records: ReceiptRecord[];
  printLog: Record<string, string>;
  unconfirmedPrintHashes: ReadonlySet<string>;
  onPrintConfirm: (paths: string[], printed: boolean) => Promise<void>;
  printerSummary: PrinterSummary | null;
  formalModel: FormalModelState | null;
  /** 报销人姓名（用户信息设置的活动 profile），用于摘要惯例 {姓名}{目的地}差旅与乘坐人。 */
  applicantName: string;
  /** 报销人工号（同上），开单乘坐人段使用。 */
  employeeId: string;
  firstRunDelivery?: LineDelivery;
  onClose: () => void;
  onPrint: (paths: string[]) => Promise<PrintOutcome>;
  onManualSubmit: (line: ExpenseLine, splitExpenseIds?: string[]) => Promise<void>;
  onSaveDelivery: (lineId: string, delivery: LineDelivery) => void;
  onSaveProject: (lineId: string, projectId: string) => void;
  onOnlineSubmitted: (lineId: string, jobId: string, title?: string) => void;
  /** 拆分递交：把指定费用（含关联材料）拆成独立票据集（线上递交按组递交时先拆再递）。 */
  onSplitLine: (line: ExpenseLine, expenseIds: string[]) => Promise<{ lineId: string; folder: string; moved: number; expenses: number }>;
}) {
  const lineRecords = useMemo(() => records.filter((record) => record.path.startsWith(`${line.folder}/`)), [records, line.folder]);
  const printedAt = useCallback((record: ReceiptRecord) => printLog[record.contentHash || record.path], [printLog]);
  // 清单勾选语义：可打印格式的材料都可勾选——已打印的也能重新勾选（打印后把发票交财务走其他经费，
  // 需按勾选材料拆分单独递交）；打印动作只针对「未打印」的选中项，勾着已打印文件不会重复打印。
  const checkableRecords = useMemo(() => lineRecords.filter((record) => PRINTABLE_EXTS.has(record.ext)), [lineRecords]);
  const recordByPath = useMemo(() => new Map(lineRecords.map((record) => [record.path, record])), [lineRecords]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(checkableRecords.map((record) => record.path)));
  const printTargets = useMemo(() => [...selected].filter((path) => {
    const record = recordByPath.get(path);
    return record && !printedAt(record) && !unconfirmedPrintHashes.has(record.contentHash || "") && PRINTABLE_EXTS.has(record.ext);
  }), [selected, recordByPath, printedAt, unconfirmedPrintHashes]);
  const pendingSelection = [...selected].filter((path) => unconfirmedPrintHashes.has(recordByPath.get(path)?.contentHash || ""));
  const [confirmingPrint, setConfirmingPrint] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<LineDelivery>(() => line.delivery ?? readLastDelivery(firstRunDelivery));
  const updateDelivery = (patch: Partial<LineDelivery>) => {
    setDelivery((current) => {
      const next = { ...current, ...patch };
      onSaveDelivery(line.id, next);
      return next;
    });
  };
  const [onlineOpen, setOnlineOpen] = useState(false);
  // 财务流程分组默认全部折叠（组头统计始终可见）；点组头右侧箭头展开单组看材料明细。
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroupExpanded = (group: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  const dialogRef = useRef<HTMLElement | null>(null);
  const [lockedHeight, setLockedHeight] = useState("");
  const toggleOnline = () => {
    // 展开瞬间锁定对话框高度：按内容自然高度的 1.5 倍放大（封顶视口），右面板内容再多也只在其内部滚动。
    if (!onlineOpen && dialogRef.current) {
      const target = Math.min(Math.round(dialogRef.current.offsetHeight * 1.5), window.innerHeight - 40);
      setLockedHeight(`${target}px`);
    } else setLockedHeight("");
    setOnlineOpen(!onlineOpen);
  };
  const [projectId, setProjectId] = useState(line.projectId ?? "");
  const [budgets, setBudgets] = useState<Array<{ projectId: string; projectName: string }>>([]);
  const [treasury, setTreasury] = useState<"loading" | "ready" | "stale" | "unavailable">("loading");
  const [treasuryReason, setTreasuryReason] = useState("");
  const [submittingOnline, setSubmittingOnline] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [draftCheck, setDraftCheck] = useState<{ state: "idle" | "running" | "clean" | "matched" | "error"; match?: { billNo: string; text: string; amountMatch: boolean | null }; error?: string }>({ state: "idle" });
  const [onlineError, setOnlineError] = useState("");
  const [plan, setPlan] = useState<SubmitPlan | null>(null);
  const [selectedGroup, setSelectedGroup] = useState("");
  // 材料清单按票据集组分批（与首页票据集分类一致）：每组材料独立成批（每组一张报销单）——手动/线上递交同口径。
  const recordGroups = useMemo(() => {
    const evidenceByPath = new Map((formalModel?.evidence ?? []).map((item) => [item.path, item]));
    const collections = workflowForLine(line).collections.filter((collection) => collection.scope === "finance");
    const labelOfNode = (nodeId?: string) => collections.find((collection) => collection.nodeIds.includes(nodeId ?? ""))?.label;
    const groupOfRecord = (path: string, classifiedNodeId?: string): string => {
      // ① 材料归类节点 → 所属票据集组（行程单/费用清单等辅助材料无需费用关联即可分组）
      const byNode = labelOfNode(classifiedNodeId);
      if (byNode) return byNode;
      // ② 回退：费用关联链（evidence → link → expense → 票据集组）
      const evidence = evidenceByPath.get(path);
      if (!evidence) return "未关联费用材料";
      const link = (formalModel?.links ?? []).find((item) => item.evidenceId === evidence.id);
      const expense = link ? (formalModel?.expenses ?? []).find((item) => item.id === link.expenseId) : undefined;
      return (expense && expenseCollectionLabel(expense.typeId, collections)) ?? "未关联费用材料";
    };
    const map = new Map<string, typeof lineRecords>();
    for (const record of lineRecords) {
      const group = groupOfRecord(record.path, record.classifiedWorkflowNodeId ?? record.classifiedRequirementId);
      const list = map.get(group) ?? [];
      list.push(record);
      map.set(group, list);
    }
    if (map.size <= 1) return null;
    // 排序与首页 section 一致（票据集组定义序），无组归属的殿后
    const orderOf = (group: string) => {
      const index = collections.findIndex((collection) => collection.label === group);
      return index === -1 ? collections.length : index;
    };
    const sorted = [...map.entries()].sort((a, b) => orderOf(a[0]) - orderOf(b[0]));
    return sorted.map(([group, recs]) => {
      const groupExpenses = (formalModel?.expenses ?? []).filter((expense) => {
        if (expense.setId !== line.id) return false;
        return recs.some((record) => {
          const evidence = evidenceByPath.get(record.path);
          return evidence && (formalModel?.links ?? []).some((item) => item.evidenceId === evidence.id && item.expenseId === expense.id);
        });
      });
      const perType = new Map<string, number>();
      for (const expense of groupExpenses) {
        const typeLabel = EXPENSE_TAXONOMY.find((entry) => entry.id === expense.typeId)?.label ?? expense.typeId;
        perType.set(typeLabel, (perType.get(typeLabel) ?? 0) + (expense.amountCny ?? 0));
      }
      const detail = perType.size > 1 ? [...perType.entries()].map(([typeLabel, sum]) => `${typeLabel} CNY ${sum.toFixed(2)}`).join("、") : "";
      return {
        group,
        label: group,
        detail,
        records: recs,
        expenseCount: groupExpenses.length,
        total: groupExpenses.reduce((sum, expense) => sum + (expense.amountCny ?? 0), 0),
      };
    });
  }, [formalModel, lineRecords, line.id]);
  // 手动递交拆分判定：勾选材料关联的费用（evidence → link → expense）是整单费用的真子集时走「拆分递交」——
  // 勾选费用拆成独立票据集单独递交，其余留在原集继续进行中；全选、未勾选或无费用关联时仍整单递交。
  const submitSplitExpenseIds = useMemo(() => {
    if (!formalModel || !recordGroups) return null;
    const evidenceByPath = new Map((formalModel.evidence ?? []).map((item) => [item.path, item]));
    const picked = new Set<string>();
    for (const recordPath of selected) {
      const evidence = evidenceByPath.get(recordPath);
      if (!evidence) continue;
      for (const link of formalModel.links ?? []) if (link.evidenceId === evidence.id) picked.add(link.expenseId);
    }
    const lineExpenseIds = new Set((formalModel.expenses ?? []).filter((expense) => expense.setId === line.id).map((expense) => expense.id));
    const pickedInLine = [...picked].filter((id) => lineExpenseIds.has(id));
    if (!pickedInLine.length || pickedInLine.length >= lineExpenseIds.size) return null;
    return pickedInLine;
  }, [formalModel, recordGroups, selected, line.id]);
  // 勾选联动：勾选材料全部属于同一票据集组时，plan/清单自动切到该组口径（摘要/份数/金额随勾选变化）
  useEffect(() => {
    if (!recordGroups) return;
    const labelOf = (path: string) => recordGroups?.find((g) => g.records.some((r) => r.path === path))?.label;
    const labels = new Set([...selected].map((p) => labelOf(p)).filter(Boolean));
    if (labels.size === 1) {
      const label = [...labels][0] as string;
      setSelectedGroup((cur) => (cur === label ? cur : label));
    } else {
      // 清空勾选或跨组混选：清单回「全部」口径（组过滤无法表达混选，保持勾选与清单一致）
      setSelectedGroup((cur) => (cur === "" ? cur : ""));
    }
  }, [selected, recordGroups]);
  const [summary, setSummary] = useState("");
  const [attachmentDesc, setAttachmentDesc] = useState("");
  const issues = useMemo(() => {
    if (!formalModel) return [];
    return formalModel.expenses
      .filter((expense) => expense.setId === line.id && expense.amountCny != null)
      .flatMap((expense) => expenseIssues(formalModel, expense).map((issue) => `${expense.typeId}（CNY ${expense.amountCny}）：${issue}`));
  }, [formalModel, line.id]);
  // 拆单警示（2026-10-16 财务上限）：发票+附件总数 ≤ 80，附件可合并为 1 份、发票不能——
  // 发票数+1 仍超限 = 合并救不了，必须拆单。口径与 server/local-materials.ts（plan 生成）/ daily_bx_draft.py（运行时 FAIL）一致。
  const splitRequired = plan != null && plan.attachmentCount > 0 && plan.invoiceCount + 1 > FINANCE_ATTACHMENT_LIMIT;
  // elab 前置核验：低耗/云服务/AI 订阅须有 approved 报账单覆盖（按去重后的费用计）；拆分递交时只核验本次递交的费用。
  const elabGaps = useMemo(() => {
    if (!formalModel) return [];
    const lineExpenses = dedupeExpenses(formalModel.expenses.filter((expense) => expense.setId === line.id)).kept;
    const gaps = elabPreapprovalGaps(line, lineExpenses);
    return submitSplitExpenseIds ? gaps.filter((gap) => submitSplitExpenseIds.includes(gap.expense.id)) : gaps;
  }, [formalModel, line, submitSplitExpenseIds]);
  // elab 前置只与低耗/云服务/AI 订阅费用相关——差旅等无此类费用的票据集不显示该核验区
  const hasElabRelevant = useMemo(() => {
    if (!formalModel) return false;
    return formalModel.expenses.some((expense) => expense.setId === line.id && elabPreapprovalFor(expense.typeId));
  }, [formalModel, line]);
  const elabGapText = (gap: ReturnType<typeof elabPreapprovalGaps>[number]) =>
    `${gap.expense.merchant || gap.expense.typeId}（${gap.expense.amountCny != null ? `CNY ${gap.expense.amountCny.toFixed(2)}` : "金额未知"}）${gap.state === "missing" ? `未登记 ${gap.pre.system === "zcgl" ? "zcgl 材料易耗品" : "wxzc 软件服务"}报账单` : `的报账单 ${gap.billNo} 尚未审核通过`}`;
  useEffect(() => {
    if (!onlineOpen) return;
    void fetch("/api/budgets").then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { budgets?: Array<{ projectId: string; projectName: string }> };
      const list = body.budgets ?? [];
      setBudgets(list);
      // 未选过项目时默认取列表第一项，减少一次点击；已存选择不覆盖。
      setProjectId((current) => {
        if (current || !list.length) return current;
        onSaveProject(line.id, list[0].projectId);
        return list[0].projectId;
      });
    }).catch(() => undefined);
    setTreasury("loading");
    void fetch("/api/treasury-status").then(async (response) => {
      const body = await response.json() as { state?: "ready" | "stale" | "unavailable"; reason?: string };
      setTreasury(body.state ?? "unavailable");
      setTreasuryReason(body.reason ?? "");
    }).catch(() => { setTreasury("unavailable"); setTreasuryReason("无法连接本地服务"); });
    // 递交清单：打开面板即生成预览，确认递交时原样回传；选中流程组后按组重新生成。
    // campus/approver 随请求传给后端：票据集未存过投递设置时预览用面板当前值（全局记忆预填），保证预览=实际递交。
    void fetch(`/api/online-submit-plan?lineId=${encodeURIComponent(line.id)}&name=${encodeURIComponent(applicantName)}&employeeId=${encodeURIComponent(employeeId)}${selectedGroup ? `&group=${encodeURIComponent(selectedGroup)}` : ""}&campus=${encodeURIComponent(delivery.campus)}&approver=${encodeURIComponent(delivery.approver)}`).then(async (response) => {
      const body = await response.json() as { plan?: SubmitPlan; error?: string };
      if (!response.ok || !body.plan) throw new Error(body.error || "无法生成递交清单");
      setPlan(body.plan);
      setSummary(body.plan.summary);
      setAttachmentDesc(body.plan.attachmentDesc);
    }).catch(() => { setPlan(null); });
    // 草稿箱查重：plan 生成时后端已后台起检查，这里轮询结果（约 30s 内出）。
    setDraftCheck({ state: "running" });
    const checkTimer = setInterval(() => {
      void fetch(`/api/draft-check?lineId=${encodeURIComponent(line.id)}`).then(async (response) => {
        const body = await response.json() as { state?: "idle" | "running" | "clean" | "matched" | "error"; match?: { billNo: string; text: string; amountMatch: boolean | null }; error?: string };
        setDraftCheck({ state: body.state ?? "idle", match: body.match, error: body.error });
        if (body.state === "clean" || body.state === "matched" || body.state === "error") clearInterval(checkTimer);
      }).catch(() => undefined);
    }, 4000);
    return () => clearInterval(checkTimer);
  }, [onlineOpen, line.id, applicantName, employeeId, selectedGroup, delivery.campus, delivery.approver]);
  const startOnlineSubmit = async () => {
    setSubmittingOnline(true);
    setOnlineError("");
    try {
      // 拆分递交（2026-09-19 定案）：对原集按组口径发起线上递交（group 过滤发票/金额）；
      // job 提交成功后由 App 轮询触发拆分——该组费用+材料拆成独立票据集进「已递交」，原集留「进行中」。
      const response = await fetch("/api/online-submit", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId: line.id, plan: { summary, attachmentDesc, campus: delivery.campus, approver: delivery.approver, projectId, totalExpected: plan?.expectedAmount ?? "", travelerName: applicantName, travelerSno: employeeId, autoSubmit: autoSubmit ? "true" : "false", group: selectedGroup } }) });
      const body = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !body.jobId) throw new Error(body.error || "无法启动线上递交");
      rememberLastDelivery(delivery);
      onOnlineSubmitted(line.id, body.jobId);
      onClose();
    } catch (startError) {
      setOnlineError(startError instanceof Error ? startError.message : "启动失败");
    } finally {
      setSubmittingOnline(false);
    }
  };
  useEffect(() => { const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previousOverflow; }; }, []);
  useEffect(() => { setSelected(new Set(checkableRecords.map((record) => record.path))); }, [checkableRecords]);
  const printerIssue = configuredPrinterIssue(printerSummary);
  const configuredPrinter = printerSummary?.printers.find((entry) => entry.name === printerSummary?.configured);
  const allSelected = checkableRecords.length > 0 && checkableRecords.every((record) => selected.has(record.path));
  const downloadZip = async () => {
    if (!selected.size) return;
    setZipping(true);
    setError("");
    try {
      const res = await fetch("/api/download-selected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [...selected] })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || "打包下载失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      // 选中材料全部属于同一财务流程组（如云服务/办公用品）时，文件名带上组名——发给财务时一眼可辨是哪一单
      const selectedPaths = [...selected];
      const owningGroup = recordGroups?.find((section) => selectedPaths.every((p) => section.records.some((record) => record.path === p)));
      const groupName = owningGroup ? `-${owningGroup.label.replace(/[/\\:]/g, "-")}` : "";
      anchor.download = `${line.title}${groupName}-递交材料-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (zipError) {
      setError(zipError instanceof Error ? zipError.message : "打包下载失败");
    } finally {
      setZipping(false);
    }
  };
  const print = async () => {
    if (!printTargets.length) return;
    setPrinting(true);
    setError("");
    try {
      // 只打印未打印的选中项；打印后保留勾选——打印完可直接拆分递交，不必重新勾选。
      const outcome = await onPrint(printTargets);
      if (outcome.failed.length) setError(`打印 ${outcome.failed.length} 份失败：${outcome.failed[0].error}`);
    } catch (printError) {
      setError(printError instanceof Error ? printError.message : "打印失败");
    } finally {
      setPrinting(false);
    }
  };
  const confirmPrint = async (printed: boolean) => {
    setConfirmingPrint(true);
    setError("");
    try {
      await onPrintConfirm(pendingSelection, printed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存打印确认");
    } finally {
      setConfirmingPrint(false);
    }
  };
  const submit = async () => { setSubmitting(true); setError(""); rememberLastDelivery(delivery); try { await onManualSubmit(line, submitSplitExpenseIds ?? undefined); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "递交失败"); setSubmitting(false); } };
  return <div className="dialog-backdrop submit-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} style={lockedHeight ? { height: lockedHeight } : undefined} className={`submit-dialog ${onlineOpen ? "is-online-open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="submit-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>SUBMISSION</span><h2 id="submit-dialog-title">递交「{line.title}」</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <div className="submit-body">
      <div className="submit-main">
      <div className="submit-checklist-head">
        <label className="submit-select-all">
          <input type="checkbox" checked={allSelected} disabled={!checkableRecords.length} onChange={() => setSelected(allSelected ? new Set() : new Set(checkableRecords.map((record) => record.path)))} />
          材料清单
        </label>
        <span>{checkableRecords.length ? `待打印 ${printTargets.length}/${checkableRecords.filter((record) => !printedAt(record)).length} · 已打印 ${lineRecords.length - checkableRecords.filter((record) => !printedAt(record)).length} 份` : `全部 ${lineRecords.length} 份均不可直接打印`}</span>
      </div>
      {recordGroups && <p className="submit-batch-note">{submitSplitExpenseIds ? `拆分递交：仅勾选的费用将拆成独立票据集单独递交，未勾选的费用与材料留在本票据集继续进行中。` : "按财务流程分批：每组材料独立成批递交（每组一张报销单），注意与线上递交的分组一致。"}</p>}
      <div className="submit-checklist">
        {recordGroups ? recordGroups.map((section) => {
          const groupCheckable = section.records.filter((record) => PRINTABLE_EXTS.has(record.ext));
          const groupAllChecked = groupCheckable.length > 0 && groupCheckable.every((record) => selected.has(record.path));
          const toggleGroup = () => setSelected((current) => {
            const next = new Set(current);
            for (const record of groupCheckable) {
              if (groupAllChecked) next.delete(record.path); else next.add(record.path);
            }
            return next;
          });
          return <div key={section.group} className="submit-group-section">
          <div className="submit-group-head">
            <label className="submit-group-toggle">
              <input type="checkbox" checked={groupAllChecked} disabled={!groupCheckable.length} onChange={toggleGroup} />
              <strong>{section.label}</strong>
            </label>
            <span>{section.detail}{section.detail && " · "}{section.expenseCount} 笔 · CNY {section.total.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · {section.records.length} 份材料</span>
            <button type="button" className="submit-group-fold" title={expandedGroups.has(section.group) ? "折叠该组材料" : "展开该组材料"} aria-expanded={expandedGroups.has(section.group)} onClick={() => toggleGroupExpanded(section.group)}>
              {expandedGroups.has(section.group) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
          {expandedGroups.has(section.group) && section.records.map((record) => {
            const printed = printedAt(record);
            const printable = PRINTABLE_EXTS.has(record.ext);
            const checked = selected.has(record.path);
            return <label key={record.path} className={`submit-file-row ${printed ? "is-printed" : ""} ${!printed && !printable ? "is-unsupported" : ""}`}>
              <input type="checkbox" checked={checked} disabled={!printable} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(record.path); else next.delete(record.path); return next; })} />
              <FileText size={15} />
              <span className="submit-file-name">{record.name}</span>
              <span className="submit-file-state">{printed ? `已打印 ${printed}` : printable ? record.ext.toUpperCase() : "需转 PDF 后打印"}</span>
            </label>;
          })}
        </div>;
        }) : lineRecords.length ? lineRecords.map((record) => {
          const printed = printedAt(record);
          const printable = PRINTABLE_EXTS.has(record.ext);
          const checked = selected.has(record.path);
          return <label key={record.path} className={`submit-file-row ${printed ? "is-printed" : ""} ${!printed && !printable ? "is-unsupported" : ""}`}>
            <input type="checkbox" checked={checked} disabled={!printable} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(record.path); else next.delete(record.path); return next; })} />
            <FileText size={15} />
            <span className="submit-file-name">{record.name}</span>
            <span className="submit-file-state">{printed ? `已打印 ${printed}` : printable ? record.ext.toUpperCase() : "需转 PDF 后打印"}</span>
          </label>;
        }) : <p className="printer-empty">该票据集尚未收录材料。</p>}
      </div>
      <div className="submit-printer-line">
        <i className={`validation-dot ${printerIssue ? (configuredPrinterIssue(printerSummary) === "打印机状态检测中" ? "warning" : "failed") : "success"}`} />
        <span>{printerIssue || `使用打印机：${configuredPrinter?.name ?? ""}`}</span>
      </div>
      {elabGaps.length > 0 && <p className="backend-error elab-manual-warning">注意：{elabGaps.map(elabGapText).join("；")}。elab 报账单是财务报销前置——线下递交可先交财务助手代办，但建议先登记进度（票据卡内「elab 前置报账单」）。</p>}
      {error && <p className="backend-error">{error}</p>}
      {pendingSelection.length > 0 && <div className="print-confirmation" role="group" aria-label="Windows 打印确认">
        <p>选中 {pendingSelection.length} 份打印结果待核对。请确认出纸或核对系统队列后再操作。</p>
        <button type="button" className="quiet-button" disabled={confirmingPrint || printing} onClick={() => void confirmPrint(true)}>确认已出纸</button>
        <button type="button" className="quiet-button" disabled={confirmingPrint || printing} onClick={() => void confirmPrint(false)}>未出纸，允许重试</button>
      </div>}
      <footer>
        <span className="submit-actions-group">
          <button type="button" className="quiet-button submit-print-button" disabled={printing || confirmingPrint || Boolean(printerIssue) || !printTargets.length} title={printTargets.length < selected.size ? "已打印的选中项不会重复打印" : undefined} onClick={() => void print()}><Printer size={15} />{printing ? "打印中" : `打印选中（${printTargets.length}）`}</button>
          <button type="button" className="quiet-button submit-print-button" disabled={zipping || !selected.size} title="把选中的材料打包为 zip 下载（发送给财务处理）" onClick={() => void downloadZip()}><Download size={15} />{zipping ? "打包中" : `下载选中（${selected.size}）`}</button>
          <button type="button" className="submit-button" disabled={submitting} onClick={() => void submit()}><Send size={15} />{submitting ? "递交中" : submitSplitExpenseIds ? `递交选中费用（${submitSplitExpenseIds.length} 笔）` : "手动递交"}</button>
        </span>
        <button type="button" className={`submit-online-button ${onlineOpen ? "is-active" : ""}`} onClick={toggleOnline}><Sparkles size={15} /> 线上递交</button>
      </footer>
      <p className="submit-footnote">手动递交：打印后随纸质材料交给财务助手；只勾选部分材料时，会先在观自在内拆出独立票据集再递交该部分，其余材料留在原集继续进行。</p>
      </div>
      <aside className={`submit-online-panel ${onlineOpen ? "is-open" : ""}`} aria-label="线上递交">
        <header>
          <span>ONLINE SUBMISSION</span>
          <button type="button" className="icon-button" title="收起" onClick={() => setOnlineOpen(false)}><X size={15} /></button>
        </header>
        <div className="submit-online-scroll">
          <section>
            <h4>递交清单</h4>
            {plan ? <>
              <div className="submit-online-delivery">
                <div className="submit-online-summary-row">
                  <label>摘要<input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="例如：张老师贵阳差旅" /></label>
                  <span className={`submit-online-check is-${draftCheck.state}`} title={draftCheck.error ?? ""}>
                    {draftCheck.state === "running" && <><span className="submit-online-check-spin">⟳</span> 查重中…</>}
                    {draftCheck.state === "clean" && "✓ 无重复"}
                    {draftCheck.state === "matched" && "⚠ 同摘要草稿"}
                    {draftCheck.state === "error" && "！检查失败"}
                  </span>
                </div>
                <label>附件补充说明<textarea rows={3} value={attachmentDesc} onChange={(e) => setAttachmentDesc(e.target.value)} placeholder="随发票池附件一并上传至报销单" /></label>
              </div>
              {draftCheck.state === "matched" && <p className="submit-online-warning">
                ⚠ 财务系统已存在相同摘要「{summary}」的草稿（单号 {draftCheck.match?.billNo}
                {draftCheck.match?.amountMatch === true ? "，金额与本次预期一致" : draftCheck.match?.amountMatch === false ? `，金额 ${draftCheck.match.text.match(/[\d,]+\.\d{2}/)?.[0] ?? "?"} 与本次预期不同` : ""}）——疑似重复提交。坚持递交将自动撤销该旧单（含其发票）后重新开单；若要保留旧单，请改摘要或先上财务系统处理。
              </p>}
              {draftCheck.state === "clean" && <p className="submit-online-note is-ok">✓ 已检查财务系统草稿箱：未发现相同摘要的草稿。</p>}
              {draftCheck.state === "error" && <p className="submit-online-note">草稿箱检查失败（不影响递交）：{draftCheck.error}</p>}
              <p className="submit-online-note">
                发票 {plan.invoiceCount} 份 · 附件 {plan.attachmentCount} 份 · 发票合计 {plan.expensesTotal.toFixed(2)}
              </p>
              <p className="submit-online-amount">预期金额 CNY {plan.expectedAmount}</p>
              <p className="submit-online-note">= 票面 {plan.expensesTotal.toFixed(2)}{plan.subsidyDays ? ` + 补贴 ${plan.subsidy.toFixed(2)}（${plan.subsidyPerDay}/天 × ${plan.subsidyDays} 天，伙食+市内交通包干）` : "（无行程日期，未计补贴）"}；开单后以财务系统金额总计为准。</p>
              {summary !== plan.summary && <p className="submit-online-issues">摘要已按你的修改递交：「{summary}」。</p>}
            </> : <p className="submit-online-issues">递交清单生成中…</p>}
          </section>
          <section>
            <h4>投递设置</h4>
            <div className="submit-online-delivery">
              <label>校区<select value={delivery.campus} onChange={(e) => updateDelivery({ campus: e.target.value as LineDelivery["campus"] })}><option value="">请选择校区</option><option>普陀校区</option><option>闵行校区</option></select></label>
              <label>打印<select value={delivery.printByFinance ? "委托财务" : "自行打印"} onChange={(e) => updateDelivery({ printByFinance: e.target.value === "委托财务" })}><option>委托财务</option><option>自行打印</option></select></label>
              <label>协同审批人<input placeholder="工号/姓名" value={delivery.approver} onChange={(e) => updateDelivery({ approver: e.target.value })} /></label>
            </div>
          </section>
          <section>
            <h4>报销项目</h4>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); onSaveProject(line.id, e.target.value); }}>
              <option value="">选择预算项目…</option>
              {budgets.map((budget) => <option key={budget.projectId} value={budget.projectId}>{budget.projectName}（{budget.projectId}）</option>)}
            </select>
          </section>
          {plan?.groupsOverview && plan.groupsOverview.length > 1 && <>
            <h4>财务流程分组（每组一张报销单）</h4>
            <div className="submit-groups">
              {plan.groupsOverview.map((overview) => {
                const active = (selectedGroup || "") === overview.group;
                const current = (plan.group ?? "") === overview.group;
                return (
                  <button key={overview.group} type="button" className={`submit-group-card ${active ? "is-active" : ""} ${current ? "is-current" : ""}`}
                    title={overview.hint}
                    onClick={() => setSelectedGroup(active ? "" : overview.group)}>
                    <strong>{overview.label}{current && <span className="submit-group-current"> 当前清单</span>}</strong>
                    <span>{overview.expenseCount} 笔 · CNY {overview.amountCny.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · 发票 {overview.invoiceCount} 份</span>
                    <em className={overview.preapproved ? "is-ok" : "is-blocked"}>{overview.preapproved ? "前置就绪" : "前置未批准——须先完成 elab 报账"}</em>
                  </button>
                );
              })}
            </div>
            <p className="submit-online-note">点击卡片切换本次递交的费用组；每组独立开单，混组费用会被财务退回。</p>
          </>}
          <section>
            <h4>材料核验</h4>
            <p className={`submit-online-issues ${issues.length ? "" : "is-clear"}`}>
              {issues.length ? issues.join("；") : "费用行材料闭环完整。"}
            </p>
            {splitRequired && plan && (
              <p className="submit-online-issues">
                ⚠ 发票 {plan.invoiceCount} 份 + 合并附件 1 份 = {plan.invoiceCount + 1}，仍超财务上限 {FINANCE_ATTACHMENT_LIMIT}——附件可合并、发票不能，请拆成多张报销单递交。
              </p>
            )}
            <p className="submit-online-note">存在缺件不阻塞递交——由你判断是否先补材料；开单后请在财务系统人工核对再提交。</p>
            {hasElabRelevant && <>
              <h4>elab 前置报账单</h4>
              {elabGaps.length ? <p className="submit-online-issues">
                {elabGaps.map(elabGapText).join("；")}——elab 报账单是财务报销前置，请先在 {elabGaps[0].pre.systemLabel} 完成报账并等审核通过。
              </p> : <p className="submit-online-issues is-clear">✓ 低耗/云服务/AI 订阅费用的 elab 前置报账单均已审核通过。</p>}
            </>}
          </section>
          <section>
            <h4>财务系统填写预览</h4>
            <dl className="submit-form-preview">
              {(plan?.formFields ?? []).map((field) => (
                <div key={field.label} className={field.value.trim() ? "" : "is-missing"}>
                  <dt>{field.label}</dt><dd>{field.value.trim() || "（空——将导致开单字段缺失）"}</dd>
                </div>
              ))}
            </dl>
            <p className="submit-online-note">以上为 e2e 将在财务系统逐项填写的内容，请递交前核对。</p>
            <label className="submit-auto-submit">
              <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} />
              草稿就绪后自动提交申请（单号/金额/摘要/项目四重校验通过才提交；取消勾选则回到人工确认）
            </label>
          </section>
          <section>
            <h4>财务系统</h4>
            <p className="submit-online-treasury">
              <i className={`validation-dot ${treasury === "ready" || treasury === "stale" ? (treasury === "stale" ? "warning" : "success") : "failed"}`} />
              {treasury === "loading" ? "检测中…" : treasury === "ready" ? "登录态可用" : treasury === "stale" ? `登录态较旧（${treasuryReason}）` : treasuryReason || "未检测"}
            </p>
          </section>
        </div>
        <footer>
          {onlineError && <p className="backend-error">{onlineError}</p>}
          <button type="button" className="submit-button" disabled={submittingOnline || treasury === "unavailable" || !plan || !summary.trim() || !delivery.approver || !delivery.campus || elabGaps.length > 0} title={elabGaps.length ? "存在未审核通过的 elab 前置报账单，线上递交被阻塞" : undefined} onClick={() => void startOnlineSubmit()}>
            <Sparkles size={15} />{elabGaps.length ? "elab 报账未通过，暂不能线上递交" : submittingOnline ? "启动中…" : "确认线上递交"}
          </button>
          <p className="submit-online-note">自动完成：上传发票 → 开单 → 填单 → 保存草稿；财务系统里的最终「提交申请」由你人工确认。</p>
        </footer>
      </aside>
      </div>
    </section>
  </div>;
}

/** 右下角收缩式调试终端：展开查看前后端运行日志（trace 事件流），黑底等宽风格。 */
function TerminalConsole() {
  useSyncExternalStore(subscribeTrace, getTraceVersion, getTraceVersion);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const all = traceEntriesAfter(0);
  const entries = useMemo(() => all.filter((entry) => showDebug || entry.level !== "debug"), [all, showDebug]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const errorCount = useMemo(() => all.reduce((count, entry) => count + (entry.level === "error" ? 1 : 0), 0), [all]);
  const runningTasks = useMemo(() => {
    const latest: Record<string, "start" | "completed" | "failed"> = {};
    for (const entry of all) if (entry.task && ["start", "completed", "failed"].includes(entry.event)) latest[entry.task] = entry.event as "start" | "completed" | "failed";
    return Object.values(latest).filter((state) => state === "start").length;
  }, [all]);
  useLayoutEffect(() => {
    if (!open) { setUnread((count) => count + 1); return; }
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [all.length, open]);
  return <>
    {open ? <section className="debug-terminal" role="dialog" aria-label="调试终端">
      <header>
        <TerminalSquare size={14} />
        <span>TERMINAL</span>
        {errorCount > 0 && <em className="debug-terminal-errors">{errorCount} 错误</em>}
        <span className="debug-terminal-actions">
          <button type="button" data-on={showDebug || undefined} onClick={() => setShowDebug((value) => !value)}>{showDebug ? "含调试" : "仅重要"}</button>
          <button type="button" title="收起" onClick={() => setOpen(false)}><X size={14} /></button>
        </span>
      </header>
      <div className="debug-terminal-body" ref={bodyRef}>
        {entries.length ? entries.map((entry) => <p key={entry.id} className={`debug-line is-${entry.level}`}>
          <time>{new Date(entry.t).toLocaleTimeString("zh-CN", { hour12: false })}</time>
          <code>{entry.task && <i className="debug-task">{entry.task}</i>}<i className="debug-scope">{entry.scope}</i>{entry.event}{entry.detail ? ` — ${entry.detail}` : ""}{entry.durationMs != null ? ` (${entry.durationMs}ms)` : ""}</code>
        </p>) : <p className="debug-line is-empty"><code>暂无日志 — 前后端操作与异常都会出现在这里</code></p>}
      </div>
    </section> : <button type="button" className="debug-terminal-fab" title="调试终端" onClick={() => { setOpen(true); setUnread(0); }}>
      <TerminalSquare size={17} />
      {runningTasks > 0 && <i className="debug-terminal-running" title={`${runningTasks} 个任务运行中`} />}
      {unread > 0 && <i className="debug-terminal-badge">{unread > 99 ? "99+" : unread}</i>}
    </button>}
  </>;
}

function App({ firstRunDelivery }: { firstRunDelivery?: LineDelivery }) {
  // 项目预算表列表：elab 前置单弹窗的报销项目下拉（与线上递交 /api/budgets 同源）
  const [projectBudgets, setProjectBudgets] = useState<Array<{ projectId: string; projectName: string }>>([]);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/budgets");
        const body = await response.json() as { budgets?: Array<{ projectId: string; projectName: string }> };
        setProjectBudgets((body.budgets ?? []).map((budget) => ({ projectId: budget.projectId, projectName: budget.projectName })));
      } catch { /* 预算列表缺失时下拉为空 */ }
    })();
  }, []);
  const { records, state, formalModel, loading, error, refresh, pullModelState, updateMeta, toggleRequirement, reconcileLine, removeMaterial, applyClassifications, importFiles, exportBackup, addLine, updateLineKind, saveLineDelivery, saveLineProject, saveLineElabBills, moveLine, splitLine, splitSubmitLine, applyGroupSplit, updateExchangeRates, refreshExchangeRates, treasuryPulse } = useReceiptStore();
  const [view, setView] = useState<ViewId>("active");
  const [newLineOpen, setNewLineOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<ExpenseLine | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ExpenseLine | null>(null);
  const [splitting, setSplitting] = useState(false);
  // 上传状态按票据集隔离：一个票据集分类中不影响其他票据集/材料行的上传。
  const [uploadingLineId, setUploadingLineId] = useState("");
  const [refreshingLineId, setRefreshingLineId] = useState("");
  const [openingTemplateId, setOpeningTemplateId] = useState("");
  const [askAiTarget, setAskAiTarget] = useState<ExpenseLine | null>(null);
  const [evidenceSearchTarget, setEvidenceSearchTarget] = useState<{ line: ExpenseLine; requirement: Requirement } | null>(null);
  const [materialSearchOpen, setMaterialSearchOpen] = useState(false);
  const [trafficNoteTarget, setTrafficNoteTarget] = useState<{ line: ExpenseLine; requirement: Requirement } | null>(null);
  const [trafficNoteJobs, setTrafficNoteJobs] = useState<Record<string, string>>(loadTrafficNoteJobs);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [budgetPanelOpen, setBudgetPanelOpen] = useState(false);
  const [dfOpen, setDfOpen] = useState(false);
  const [laborOpen, setLaborOpen] = useState(false);
  // dock 状态灯：当前系统季度交费是否已确认（null = 未知/加载中/功能停用，不显示灯）
  const [dfStatus, setDfStatus] = useState<{ enabled: boolean; currentConfirmed: boolean } | null>(null);
  const refreshDfStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/df");
      const body = await response.json() as { settings?: { enabled: boolean; confirmedQuarters?: Record<string, string> }; error?: string };
      if (!response.ok) return;
      const enabled = body.settings?.enabled ?? true;
      const now = new Date();
      const currentConfirmed = Boolean(body.settings?.confirmedQuarters?.[quarterKeyOf(now.getFullYear(), currentQuarterKey(now))]);
      setDfStatus({ enabled, currentConfirmed });
    } catch { /* 保持原状，下轮弹窗关闭时再刷 */ }
  }, []);
  useEffect(() => { void refreshDfStatus(); }, [refreshDfStatus]);
  // dock 状态灯：当月学生津贴是否已确认发送（null = 未知/功能停用，不显示灯）
  const [laborStatus, setLaborStatus] = useState<{ enabled: boolean; currentConfirmed: boolean } | null>(null);
  const refreshLaborStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/labor");
      const body = await response.json() as { settings?: { enabled: boolean }; months?: Record<string, { confirmedAt?: string }>; error?: string };
      if (!response.ok) return;
      const enabled = body.settings?.enabled ?? true;
      const now = new Date();
      const currentConfirmed = Boolean(body.months?.[laborMonthKey(now.getFullYear(), now.getMonth() + 1)]?.confirmedAt);
      setLaborStatus({ enabled, currentConfirmed });
    } catch { /* 保持原状 */ }
  }, []);
  useEffect(() => { void refreshLaborStatus(); }, [refreshLaborStatus]);
  const [budgetsReady, setBudgetsReady] = useState<boolean | null>(null);
  const refreshBudgetStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/budgets");
      const body = await response.json() as { budgets?: Array<{ projectId: string; projectName: string }> };
      const list = body.budgets ?? [];
      setBudgetsReady(list.length > 0);
      setProjectBudgets(list.map((budget) => ({ projectId: budget.projectId, projectName: budget.projectName })));
    } catch { setBudgetsReady(false); }
  }, []);
  useEffect(() => { void refreshBudgetStatus(); }, [refreshBudgetStatus]);
  const [ruleLibraryOpen, setRuleLibraryOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettings>(loadAiSettings);
  const [aiBackendTest, setAiBackendTest] = useState<AiBackendTest | null>(() => { try { const saved = JSON.parse(localStorage.getItem(AI_BACKEND_TEST_KEY) ?? "null") as AiBackendTest | null; return saved?.backend && typeof saved.model === "string" ? saved : null; } catch { return null; } });
  const [userProfilesOpen, setUserProfilesOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState("");
  const [newProfile, setNewProfile] = useState<UserProfileRecord | null>(null);
  const [userProfiles, setUserProfiles] = useState<UserProfileRecord[]>(loadUserProfiles);
  const [activeProfileId, setActiveProfileId] = useState(loadActiveUserProfileId);
  const [notice, setNotice] = useState("");
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const [printSettingsOpen, setPrintSettingsOpen] = useState(false);
  const [printerSummary, setPrinterSummary] = useState<PrinterSummary | null>(null);
  const [treasuryPolling, setTreasuryPolling] = useState(false);
  const [archivingPosted, setArchivingPosted] = useState(false);
  const showNotice = (message: string) => { appLog(/失败|错误|异常/.test(message) ? "error" : "info", message); setNotice(message); window.setTimeout(() => setNotice(""), 3200); };
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printLog, setPrintLog] = useState<Record<string, string>>({});
  const [unconfirmedPrintHashes, setUnconfirmedPrintHashes] = useState<ReadonlySet<string>>(() => new Set());
  const [submitTarget, setSubmitTarget] = useState<ExpenseLine | null>(null);
  const [onlineJob, setOnlineJob] = useState<OnlineJobState | null>(loadOnlineJob);
  useEffect(() => {
    if (onlineJob) localStorage.setItem(ONLINE_JOB_KEY, JSON.stringify(onlineJob));
    else localStorage.removeItem(ONLINE_JOB_KEY);
  }, [onlineJob]);
  useEffect(() => {
    if (!onlineJob) return;
    let alive = true;
    const tick = async () => {
      try {
        const response = await fetch(`/api/online-submit-status?jobId=${encodeURIComponent(onlineJob.jobId)}`);
        if (response.status === 404) {
          if (!alive) return;
          setOnlineJob(null);
          showNotice("后台递交任务已丢失（本地服务重启过），请重新发起");
          return;
        }
        if (!response.ok) return;
        const body = await response.json() as { state?: OnlineJobState["state"]; step?: string; progress?: number; billNo?: string; error?: string; startedAt?: number; log?: string[]; group?: string };
        if (!alive) return;
        setOnlineJob((current) => (current && current.jobId === onlineJob.jobId ? { ...current, state: body.state ?? current.state, step: body.step ?? "", progress: body.progress ?? current.progress, billNo: body.billNo ?? "", error: body.error ?? "", startedAt: body.startedAt ?? current.startedAt, logTail: body.log ?? current.logTail, group: body.group ?? current.group } : current));
      } catch { /* 网络抖动下一轮重试 */ }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [onlineJob]);
  // 撤回完成：提示并退出跟踪，卡片回到普通态（可重新线上递交）。
  useEffect(() => {
    if (onlineJob?.state === "withdrawn") { showNotice("已撤回：草稿与发票已删除，可重新线上递交"); setOnlineJob(null); }
  }, [onlineJob?.state]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 分组递交收尾（2026-09-19 定案）：提交成功后把该组费用+材料拆成独立票据集进「已递交」，原集留「进行中」。
  const [finalizingGroup, setFinalizingGroup] = useState(false);
  useEffect(() => {
    if (!onlineJob || onlineJob.state !== "submitted" || !onlineJob.group || onlineJob.finalized || finalizingGroup || !formalModel) return;
    const sourceLine = state.lines.find((item) => item.id === onlineJob.lineId);
    if (!sourceLine) { setOnlineJob((cur) => (cur ? { ...cur, finalized: true } : cur)); return; }
    const collections = workflowForLine(sourceLine).collections.filter((c) => c.scope === "finance");
    const lineExpenses = formalModel.expenses.filter((expense) => expense.setId === sourceLine.id);
    const groupExpenseIds = lineExpenses
      .filter((expense) => expenseCollectionLabel(expense.typeId, collections) === onlineJob.group)
      .map((expense) => expense.id);
    if (!groupExpenseIds.length || groupExpenseIds.length >= lineExpenses.length) {
      // 组费用为空（异常）或整集即该组（无需拆分）：仅清登记语义，卡片收尾
      setOnlineJob((cur) => (cur ? { ...cur, finalized: true } : cur));
      return;
    }
    setFinalizingGroup(true);
    void (async () => {
      try {
        const split = await splitLine(sourceLine, groupExpenseIds, false, { billNo: onlineJob.billNo, group: onlineJob.group });
        const moveResponse = await fetch(`/api/move-line?folder=${encodeURIComponent(split.folder)}&destination=submitted`, { method: "POST" });
        if (!moveResponse.ok) {
          const moveBody = await moveResponse.json() as { error?: string };
          throw new Error(moveBody.error ?? "移动拆分票据集失败");
        }
        const moveBody = await moveResponse.json() as { folder: string };
        applyGroupSplit(split.lineId, sourceLine.id, moveBody.folder, onlineJob.billNo);
        showNotice(`「${onlineJob.group}」已递交（单号 ${onlineJob.billNo}），已拆分为独立票据集进「已递交」；原集留在进行中`);
        setOnlineJob((cur) => (cur ? { ...cur, finalized: true } : cur));
      } catch (finalizeError) {
        showNotice(finalizeError instanceof Error ? `拆分收尾失败：${finalizeError.message}（单据已提交成功，可稍后在已递交中手动拆分）` : "拆分收尾失败");
        setOnlineJob((cur) => (cur ? { ...cur, finalized: true } : cur));
      } finally {
        setFinalizingGroup(false);
      }
    })();
  }, [onlineJob?.state, onlineJob?.group, onlineJob?.finalized]);  // eslint-disable-line react-hooks/exhaustive-deps
  const dismissOnlineJob = (lineId: string) => {
    if (onlineJob?.lineId === lineId) setOnlineJob(null);
  };
  const stopOnlineJob = async () => {
    if (!onlineJob || (onlineJob.state !== "running" && onlineJob.state !== "submitting" && onlineJob.state !== "withdrawing")) return;
    try {
      const response = await fetch("/api/online-submit-stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: onlineJob.jobId }) });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "停止失败");
      showNotice("正在停止任务…");
    } catch (stopError) {
      showNotice(stopError instanceof Error ? stopError.message : "停止失败");
    }
  };
  const decideOnlineJob = async (action: "confirm" | "withdraw") => {
    if (!onlineJob || onlineJob.state !== "awaiting") return;
    try {
      const response = await fetch("/api/online-submit-decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: onlineJob.jobId, action }) });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "操作失败");
      setOnlineJob((current) => (current ? { ...current, state: action === "confirm" ? "submitting" : "withdrawing", step: "" } : current));
      showNotice(action === "confirm" ? "正在向财务系统提交申请…" : "正在撤回草稿与发票…");
    } catch (decideError) {
      showNotice(decideError instanceof Error ? decideError.message : "操作失败");
    }
  };

  useEffect(() => {
    fetch("/api/ai-settings").then(async (response) => {
      if (!response.ok) return;
      const payload = (await response.json()) as { settings?: Partial<AiSettings> };
      const stored = payload.settings;
      if (!stored) return;
      const next = { backend: stored.backend === "api" || stored.backend === "codex" || stored.backend === "opencode" ? stored.backend : "off", model: typeof stored.model === "string" ? stored.model : "", apiBaseUrl: typeof stored.apiBaseUrl === "string" ? stored.apiBaseUrl : "" } satisfies AiSettings;
      localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
      setAiSettings(next);
    }).catch(() => undefined);
  }, []);

  const lines = useMemo(() => orderLinesForView(state.lines, view), [state.lines, view]);
  const lineBoardRef = useCardMasonry(view !== "active");
  const postedArchiveLines = view === "submitted" ? lines.filter(canArchivePostedLine) : [];
  const counts = useMemo(() => ({ active: state.lines.filter((line) => line.status === "active").length, submitted: state.lines.filter((line) => line.status === "submitted").length, archived: state.lines.filter((line) => line.status === "archived").length }), [state.lines]);

  useEffect(() => {
    fetch("/api/user-profiles").then(async (response) => {
      if (!response.ok) return;
      const payload = (await response.json()) as { profiles?: UserProfileRecord[] };
      const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
      if (!profiles.length) return;
      // 一次性迁移：常住地原存于后端 AI 配置，现归身份信息；空档案回填旧值。
      let legacyHomeCity = "上海";
      try { const parsed = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) ?? "{}") as { homeCity?: string }; if (typeof parsed.homeCity === "string" && parsed.homeCity.trim()) legacyHomeCity = parsed.homeCity.trim(); } catch { /* keep default */ }
      const migrated = profiles.map((record) => record.profile.homeCity?.trim() ? record : { ...record, profile: { ...record.profile, homeCity: legacyHomeCity } });
      saveUserProfiles(migrated);
      setUserProfiles(migrated);
      setActiveProfileId((current) => {
        const next = profiles.some((profile) => profile.id === current) ? current : profiles[0].id;
        saveActiveUserProfileId(next);
        return next;
      });
    }).catch(() => undefined);
  }, []);
  const archivedFileCount = records.filter((record) => record.path.startsWith("01_报销材料/90_已归档/")).length;
  const archivedAmount = view === "archived" ? archivedApplicationTotal(lines) : undefined;
  const pollTreasury = useCallback(async () => {
    setTreasuryPolling(true);
    try {
      showNotice(await refreshTreasuryStatus(pullModelState));
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "财务轮询失败，请稍后重试");
    } finally {
      setTreasuryPolling(false);
    }
  }, [pullModelState]);
  const refreshPrinters = useCallback(async () => {
    setPrintersLoading(true);
    try {
      const response = await fetch("/api/printers");
      if (response.ok) setPrinterSummary(await response.json() as PrinterSummary);
    } catch {
      // 状态指示器保持上次结果；递交打印时会再次检测。
    } finally {
      setPrintersLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshPrinters();
    fetch("/api/print-log").then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { entries?: Record<string, string>; unconfirmedHashes?: string[] };
      if (payload.entries) setPrintLog(payload.entries);
      if (payload.unconfirmedHashes) setUnconfirmedPrintHashes(new Set(payload.unconfirmedHashes));
    }).catch(() => undefined);
  }, [refreshPrinters]);
  useEffect(() => { if (submitTarget) void refreshPrinters(); }, [submitTarget, refreshPrinters]);
  // 从后台切回前台（换网络/合盖恢复）立即确认打印机可达性；不刷其他数据，避免过度轮询。
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void refreshPrinters(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshPrinters]);
  const savePrinterSelection = useCallback(async (printer: string) => {
    const response = await fetch("/api/print-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ printer }) });
    if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "无法保存打印机配置");
    setPrinterSummary((current) => current ? { ...current, configured: printer } : current);
  }, []);
  const handlePrint = useCallback(async (paths: string[]) => {
    const response = await fetch("/api/print", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
    const payload = await response.json() as PrintOutcome & { entries?: Record<string, string>; error?: string };
    if (!response.ok) throw new Error(payload.error ?? "打印失败");
    if (payload.entries) setPrintLog(payload.entries);
    const waiting = payload.unconfirmedHashes;
    if (waiting?.length) setUnconfirmedPrintHashes((current) => new Set([...current, ...waiting]));
    // 打印后重探打印机：若队列滞留（任务未确认完成），状态灯转红并禁用下一次打印。
    void refreshPrinters();
    return { printed: payload.printed ?? [], failed: payload.failed ?? [] };
  }, [refreshPrinters]);
  const handlePrintConfirm = useCallback(async (paths: string[], printed: boolean) => {
    const response = await fetch("/api/print-confirm", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths, printed }),
    });
    const result = await response.json() as { entries: Record<string, string>; unconfirmedHashes: string[]; error?: string };
    if (!response.ok) throw new Error(result.error || "无法保存打印确认");
    setPrintLog(result.entries);
    setUnconfirmedPrintHashes(new Set(result.unconfirmedHashes));
  }, []);
  const handleManualSubmit = async (line: ExpenseLine, splitExpenseIds?: string[]) => {
    try {
      if (splitExpenseIds?.length) {
        // 拆分递交：勾选费用拆成独立票据集单独递交，原集保留其余费用/材料继续进行中。
        const result = await splitSubmitLine(line, splitExpenseIds);
        setSubmitTarget(null);
        setView("submitted");
        showNotice(`已拆出 ${result.expenses} 笔费用单独递交，其余材料留在原票据集继续进行中`);
        return;
      }
      await moveLine(line, "submitted");
      setSubmitTarget(null);
      setView("submitted");
      showNotice(`${line.title} 已递交，进入财务进度跟踪`);
    } catch (moveError) {
      throw moveError instanceof Error ? moveError : new Error("递交失败");
    }
  };
  const configuredPrinter = printerSummary?.printers.find((entry) => entry.name === printerSummary?.configured);
  const printerIndicatorTone = !printerSummary || !printerSummary.configured ? "" : configuredPrinterIssue(printerSummary) === "打印机状态检测中" ? "warning" : configuredPrinter ? printerStatusTone(configuredPrinter) : "failed";
  const updateTrafficNoteJobs = (next: Record<string, string>) => { setTrafficNoteJobs(next); localStorage.setItem(TRAFFIC_NOTE_JOBS_KEY, JSON.stringify(next)); };
  const [classificationJobs, setClassificationJobs] = useState<Record<string, string>>(() => loadTrafficNoteJobs());
  const updateClassificationJobs = (next: Record<string, string>) => { setClassificationJobs(next); localStorage.setItem(CLASSIFICATION_JOBS_KEY, JSON.stringify(next)); };
  // 后台识别轮询：任务完成自动应用归类结果并入账。
  const applyClassificationsRef = useRef(applyClassifications);
  applyClassificationsRef.current = applyClassifications;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const reconcileLineRef = useRef(reconcileLine);
  reconcileLineRef.current = reconcileLine;
  useEffect(() => {
    const entries = Object.entries(classificationJobs);
    if (!entries.length) return;
    let cancelled = false;
    const poll = async () => {
      for (const [lineId, jobId] of entries) {
        if (cancelled) return;
        try {
          const response = await fetch(`/api/auto-classify-status?jobId=${encodeURIComponent(jobId)}`);
          if (!response.ok) { // 任务已失效（服务重启）：直接丢弃，避免永久轮询
            const next = { ...classificationJobs };
            delete next[lineId];
            updateClassificationJobs(next);
            continue;
          }
          const status = await response.json() as { state?: string; error?: string; assignments?: ClassificationAssignment[] };
          if (status.state === "running") continue;
          const next = { ...classificationJobs };
          delete next[lineId];
          updateClassificationJobs(next);
          if (status.state === "completed" && status.assignments?.length) {
            applyClassificationsRef.current(status.assignments);
            await refreshRef.current();
            reconcileLineRef.current(lineId);
            showNotice(`后台识别完成，已入账 ${status.assignments.length} 份材料`);
          } else if (status.state === "failed") {
            showNotice(status.error || "后台识别失败");
          }
        } catch { /* 网络抖动：下一轮重试 */ }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [classificationJobs]);
  const lineRequirements = (line: ExpenseLine) => workflowForLine(line).nodes
    .filter((node) => node.kind === "evidence" || node.kind === "attachment")
    .map(({ id, label, hint }) => ({ id, label, hint }));
  const lineClassificationContext = (line: ExpenseLine) => {
    const requirements = workflowForLine(line).nodes.filter((node) => node.kind === "evidence" || node.kind === "attachment");
    return records
      .filter((record) => record.path.startsWith(`${line.folder}/`))
      .map((record) => {
        const value = record.name.toLowerCase();
        const requirementId = record.classifiedWorkflowNodeId ?? record.classifiedRequirementId ?? requirements.find((item) => {
          const matches = item.keywords.map((keyword) => keyword.toLowerCase().split("&").map((part) => part.trim()).filter(Boolean).every((part) => value.includes(part)));
          return item.matchAll ? matches.every(Boolean) : matches.some(Boolean);
        })?.id;
        return requirementId ? {
          path: record.path, name: record.name, requirementId, amount: record.amount, currency: record.currency,
          documentDate: record.invoiceDate,
          paymentDateBlocked: record.paymentDateBlocked,
          paymentDate: record.paymentDateBlocked ? undefined : record.paymentDate ?? (record.paymentDateBlocked === undefined && cloudPaymentNodeKind(requirementId) === "payment" ? record.invoiceDate : undefined),
        } : null;
      })
      .filter((item) => item !== null);
  };
  const handleUpload = async (line: ExpenseLine, files: FileList | null, requirement?: Requirement) => {
    if (!files?.length) return;
    setUploadingLineId(line.id);
    try {
      const importedPaths = await importFiles(files, line.folder, (names) => {
        showNotice(`跳过 ${names.length} 份重复材料（内容与已收录文件相同）：${names.join("、")}`);
      });
      if (!importedPaths.length) return;
      // 云服务发票、收据和付款记录还需要提取日期，行内上传也走同一识别入口。
      if (requirement && !cloudPaymentNodeKind(requirement.id)) {
        applyClassifications(importedPaths.map((filePath) => ({ path: filePath, requirementId: requirement.id })));
        await refresh();
        reconcileLine(line.id);
        showNotice(`已收录 ${files.length} 份材料，归入「${requirement.label}」`);
        return;
      }
      if (aiSettings.backend !== "off" || line.kind === "日常") {
        let assignments: ClassificationAssignment[];
        let recognitionFailed = false;
        try {
          const response = await fetch("/api/auto-classify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder: line.folder, paths: importedPaths, requirements: lineRequirements(line), contextMaterials: lineClassificationContext(line), preferredRequirementId: requirement?.id, backend: aiSettings.backend, model: aiSettings.model, homeCity: userProfiles.find((profile) => profile.id === activeProfileId)?.profile.homeCity?.trim() || "上海" }),
          });
          const body = await response.json() as { assignments?: ClassificationAssignment[]; error?: string };
          if (!response.ok) throw new Error(body.error || "AI 自动分类失败");
          assignments = body.assignments ?? [];
        } catch (error) {
          if (!requirement) throw error;
          assignments = importedPaths.map((filePath) => ({ path: filePath, requirementId: requirement.id }));
          recognitionFailed = true;
        }
        applyClassifications(assignments);
        await refresh();
        reconcileLine(line.id);
        showNotice(recognitionFailed ? `已归入「${requirement!.label}」，付款日期待识别` : `已收录 ${files.length} 份材料，已识别 ${assignments.length} 份`);
      } else {
        reconcileLine(line.id);
        showNotice(`已收录并对齐 ${files.length} 份材料`);
      }
    } catch (uploadError) { showNotice(uploadError instanceof Error ? uploadError.message : "材料上传失败"); } finally { setUploadingLineId(""); }
  };
  const handleRefreshLine = async (line: ExpenseLine) => {
    setRefreshingLineId(line.id);
    try {
      const jobId = trafficNoteJobs[line.id];
      if (jobId) {
        const statusResponse = await fetch(`/api/ai-traffic-note-status?jobId=${encodeURIComponent(jobId)}`);
        const status = await statusResponse.json() as { state?: string; error?: string };
        if (status.state === "running") { showNotice("说明仍在后台生成"); return; }
        const nextJobs = { ...trafficNoteJobs };
        delete nextJobs[line.id];
        updateTrafficNoteJobs(nextJobs);
        if (status.state === "failed") { showNotice(status.error || "说明生成失败"); return; }
      }
      const response = await fetch(`/api/normalize-line?folder=${encodeURIComponent(line.folder)}`, { method: "POST" }); const body = await response.json() as { changes?: Array<unknown>; error?: string }; if (!response.ok) throw new Error(body.error || "材料规范命名失败");
      await refresh(); reconcileLine(line.id);
      // 直接拷入文件夹的新文件没有经过上传识别：补跑 AI 归类，让金额进入费用行合计。
      const materialsResponse = await fetch("/api/materials");
      const freshRecords = materialsResponse.ok ? await materialsResponse.json() as ReceiptRecord[] : [];
      const unclassifiedPaths = freshRecords.filter((record) => record.path.startsWith(`${line.folder}/`) && !record.classifiedWorkflowNodeId && !record.classifiedRequirementId).map((record) => record.path).slice(0, 20);
      let recognizedHint = "";
      if (unclassifiedPaths.length && aiSettings.backend !== "off" && !classificationJobs[line.id]) {
        // 识别转后台任务：刷新立即完成，识别完成后由轮询自动入账。
        const classifyResponse = await fetch("/api/auto-classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ background: true, folder: line.folder, paths: unclassifiedPaths, requirements: lineRequirements(line), contextMaterials: lineClassificationContext(line), backend: aiSettings.backend, model: aiSettings.model, homeCity: userProfiles.find((profile) => profile.id === activeProfileId)?.profile.homeCity?.trim() || "上海" }) });
        const classifyBody = await classifyResponse.json() as { jobId?: string };
        if (classifyResponse.ok && classifyBody.jobId) { updateClassificationJobs({ ...classificationJobs, [line.id]: classifyBody.jobId }); recognizedHint = `；${unclassifiedPaths.length} 份新材料正在后台识别`; }
      } else if (unclassifiedPaths.length && aiSettings.backend === "off") { recognizedHint = `，${unclassifiedPaths.length} 份新材料待识别（需开启 AI 后端）`; }
      const renamed = body.changes?.length ?? 0; showNotice(renamed || recognizedHint ? `${line.title} 已重命名 ${renamed} 份并重新对齐${recognizedHint}` : `${line.title} 已按本机文件重新对齐`);
    } catch (refreshError) { showNotice(refreshError instanceof Error ? refreshError.message : "材料重新对齐失败"); } finally { setRefreshingLineId(""); }
  };
  const handleOpenTemplate = async (line: ExpenseLine, requirement: Requirement) => {
    if (!requirement.templateId) return;
    const key = `${line.id}:${requirement.templateId}`;
    setOpeningTemplateId(key);
    try {
      const response = await fetch(`/api/template?folder=${encodeURIComponent(line.folder)}&template=${encodeURIComponent(requirement.templateId)}`, { method: "POST" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法打开模板");
      showNotice("已在临时副本中打开；完成后拖入此票据集上传");
    } catch (templateError) {
      showNotice(templateError instanceof Error ? templateError.message : "无法打开模板");
    } finally {
      setOpeningTemplateId("");
    }
  };
  const saveAiSettings = async (nextSettings: AiSettings, apiKey: string) => {
    if (nextSettings.backend === "api" && apiKey) {
      const response = await fetch("/api/ai-api-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "无法保存 API Key");
      }
    }
    const settingsResponse = await fetch("/api/ai-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nextSettings) });
    if (!settingsResponse.ok) {
      const body = (await settingsResponse.json()) as { error?: string };
      throw new Error(body.error ?? "无法保存 AI 设置");
    }
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(nextSettings));
    if (aiBackendTest?.backend !== nextSettings.backend || aiBackendTest.model !== nextSettings.model) { localStorage.removeItem(AI_BACKEND_TEST_KEY); setAiBackendTest(null); }
    setAiSettings(nextSettings);
    showNotice(nextSettings.backend === "off" ? "AI 识别已关闭" : "AI 后端设置已保存");
  };
  const persistProfiles = async (profiles: UserProfileRecord[]) => {
    const response = await fetch("/api/user-profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profiles }) });
    if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "无法保存用户列表");
  };
  const saveProfile = async (profileId: string, nextProfile: UserProfile, schoolSsoPassword: string, signature: File | null) => {
    if (schoolSsoPassword) {
      const response = await fetch(`/api/user-credentials?profileId=${encodeURIComponent(profileId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schoolSsoPassword, schoolSsoAccount: nextProfile.schoolSsoAccount }) });
      const payload = (await response.json()) as { error?: string; validation?: { message?: string } };
      if (!response.ok) throw new Error(payload.error ?? "无法保存系统凭证");
      if (payload.validation?.message) showNotice(payload.validation.message);
    }
    if (signature) {
      if (signature.type !== "image/png") throw new Error("签名仅支持 PNG 图片");
      const response = await fetch(`/api/user-signature?profileId=${encodeURIComponent(profileId)}`, { method: "POST", headers: { "Content-Type": "image/png" }, body: signature });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "无法保存签名");
      nextProfile = { ...nextProfile, signatureUpdated: true };
    }
    const savedRecord = { id: profileId, profile: nextProfile, updatedAt: new Date().toISOString() };
    const nextProfiles = userProfiles.some((record) => record.id === profileId) ? userProfiles.map((record) => record.id === profileId ? savedRecord : record) : [...userProfiles, savedRecord];
    await persistProfiles(nextProfiles);
    saveUserProfiles(nextProfiles);
    saveActiveUserProfileId(profileId);
    setUserProfiles(nextProfiles);
    setActiveProfileId(profileId);
    showNotice("用户信息已保存");
  };
  const createProfile = () => {
    const record = createUserProfile();
    setUserProfilesOpen(false);
    setNewProfile(record);
  };
  const editProfile = (profileId: string) => { saveActiveUserProfileId(profileId); setActiveProfileId(profileId); setUserProfilesOpen(false); setEditingProfileId(profileId); };
  const editingProfile = userProfiles.find((profile) => profile.id === editingProfileId);
  // 进行中归档可能拆分（打开对话框）；已递交不再拆单——点归档即整单归档，停留当前视图便于连续操作。
  const handleArchive = (line: ExpenseLine) => {
    if (archivingPosted) return;
    if (view === "submitted") { void confirmArchive(line); return; }
    setArchiveTarget(line);
  };
  const confirmArchive = async (line: ExpenseLine) => {
    try {
      await moveLine(line, "archived", { postedOnly: line.status === "submitted" });
      showNotice(`${line.title} 已归档`);
    } catch (moveError) {
      showNotice(moveError instanceof Error ? moveError.message : "归档失败");
    }
  };
  const archivePosted = async () => {
    if (treasuryPolling || archivingPosted || !postedArchiveLines.length) return;
    setArchivingPosted(true);
    let archived = 0;
    const failures: string[] = [];
    try {
      for (const line of postedArchiveLines) {
        try {
          await moveLine(line, "archived", { postedOnly: true, deferRefresh: true });
          archived += 1;
        } catch (error) {
          failures.push(`${line.title}（${error instanceof Error ? error.message : "移动失败"}）`);
        }
      }
      await refresh();
      showNotice(failures.length
        ? `已归档 ${archived} 个票据集，${failures.length} 个失败。${failures[0]}`
        : `已归档 ${archived} 个票据集`);
    } finally {
      setArchivingPosted(false);
    }
  };
  const handleSplit = async (line: ExpenseLine, expenseIds: string[], archive: boolean) => {
    setSplitting(true);
    try {
      const result = await splitLine(line, expenseIds, archive);
      setArchiveTarget(null);
      showNotice(`已拆出 ${result.expenses} 笔费用、移动 ${result.moved} 份材料${archive ? "并归档" : ""}。`);
    } catch (splitError) { showNotice(splitError instanceof Error ? splitError.message : "拆分失败"); } finally { setSplitting(false); }
  };
  const handleRestore = (line: ExpenseLine) => setRestoreTarget(line);
  const confirmRestore = async (line: ExpenseLine) => {
    try { await moveLine(line, "restore"); showNotice(`${line.title} 已还原`); } catch (moveError) { showNotice(moveError instanceof Error ? moveError.message : "还原失败"); }
    setRestoreTarget(null);
  };

  return <main className="editorial-shell">
    <header className="masthead">
      <div className="brand-lockup"><strong>观自在 · 票据簿</strong><span>一笔一明，一单一安。</span></div>
      <nav aria-label="报销状态">{VIEWS.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}<b>{counts[item.id]}</b></button>)}</nav>
      <div className="masthead-actions"><button type="button" className="icon-button" title="系统设置" aria-label="系统设置" aria-haspopup="dialog" onClick={() => setSystemSettingsOpen(true)}><Settings size={18} /></button><button className="icon-button" title="用户信息配置" onClick={() => setUserProfilesOpen(true)}><UserCog size={18} /></button><button className="icon-button rule-library-button" title="规则库" onClick={() => setRuleLibraryOpen(true)}><ScrollText size={18} /></button><button className="icon-button" title="重新扫描材料" onClick={() => void refresh()}><RefreshCw size={18} className={loading ? "spin" : ""} /></button><button className="icon-button" title="导出本地备份" onClick={exportBackup}><Download size={18} /></button><button className="create-button" onClick={() => setNewLineOpen(true)}><Plus size={17} /> 票据集</button></div>
      <aside className="side-dock" aria-label="快捷入口">
        <button type="button" className="dock-button" title={budgetsReady === false ? "项目预算表（未拉取，点击查看如何配置）" : budgetsReady === null ? "项目预算表（检测中）" : "项目预算表"} onClick={() => setBudgetPanelOpen(true)}><Wallet size={19} />{budgetsReady !== null && <i className={`validation-dot ${budgetsReady ? "success" : "warning"}`} aria-label={budgetsReady ? "已拉取预算数据" : "尚未拉取预算数据"} />}</button>
        <button type="button" className="dock-button" title="AI 后端设置" onClick={() => setAiSettingsOpen(true)}><Sparkles size={19} />{aiBackendTest?.backend === aiSettings.backend && aiBackendTest.model === aiSettings.model && <i className="validation-dot success" aria-label="当前模型测试通过" />}</button>
        <button type="button" className="dock-button" title="打印机设置" onClick={() => setPrintSettingsOpen(true)}><Printer size={18} /><i className={`validation-dot ${printerIndicatorTone}`} aria-label="打印机状态" /></button>
        <button type="button" className="dock-button" title="文件搜索" aria-label="文件搜索" aria-haspopup="dialog" onClick={() => setMaterialSearchOpen(true)}><Search size={18} /></button>
        <button type="button" className="dock-button dock-button--text" title={laborStatus?.enabled === false ? "学生津贴（已停用）" : laborStatus?.currentConfirmed ? "学生津贴（本月已发）" : laborStatus ? "学生津贴（本月未发）" : "学生津贴"} onClick={() => setLaborOpen(true)}><span className="dock-text">津贴</span>{laborStatus?.enabled && <i className={`validation-dot ${laborStatus.currentConfirmed ? "success" : "failed"}`} aria-label={laborStatus.currentConfirmed ? "本月已发" : "本月未发"} />}</button>
        <button type="button" className="dock-button dock-button--text" title={dfStatus?.enabled === false ? "DF 计算（已停用）" : dfStatus?.currentConfirmed ? "DF 计算（本季度已交）" : dfStatus ? "DF 计算（本季度未交）" : "DF 计算"} onClick={() => setDfOpen(true)}><span className="dock-text">DF</span>{dfStatus?.enabled && <i className={`validation-dot ${dfStatus.currentConfirmed ? "success" : "failed"}`} aria-label={dfStatus.currentConfirmed ? "本季度已交" : "本季度未交"} />}</button>
      </aside>
    </header>
    {view !== "active" && <section className="title-band title-band--slim">
      <div>
        <span>{view === "submitted" ? "SUBMISSION TRACKING" : "LOCAL ARCHIVE"}</span>
        <div className="title-heading-row">
          <h1>{view === "submitted" ? "递交之后，跟着财务进度走。" : "已入账的报销，连凭证号一起归档。"}</h1>
          {view === "submitted" && <>
            <button type="button" className="quiet-button treasury-poll-button" disabled={treasuryPolling || archivingPosted} onClick={() => void pollTreasury()} data-polling={treasuryPolling || undefined}>
              <span className="treasury-poll-label"><RefreshCw size={14} className={treasuryPolling ? "spin" : ""} />{treasuryPolling ? "查询财务中" : "刷新递交状态"}</span>
            </button>
            <button type="button" className="quiet-button treasury-archive-button" onClick={() => void archivePosted()} disabled={treasuryPolling || archivingPosted || !postedArchiveLines.length} title="归档所有已确认全部单据入账的票据集">
              {archivingPosted ? <LoaderCircle size={14} className="spin" /> : <Archive size={14} />}
              {archivingPosted ? "归档中" : `一键归档（${postedArchiveLines.length}）`}
            </button>
          </>}
        </div>
      </div>
      {view === "submitted" ? (
        <p>点击「刷新递交状态」同步财务系统。票据集的全部报销单入账后，可单笔归档或点击「一键归档」。</p>
      ) : (
        <dl className="archive-stats" aria-label="归档统计">
          <div><dt>归档票据集</dt><dd>{counts.archived}</dd></div>
          <div><dt>归档材料</dt><dd>{archivedFileCount}</dd></div>
          <div title="已归档报销单中有金额记录的申请金额合计"><dt>申请金额</dt><dd>{archivedAmount?.toLocaleString("zh-CN", { style: "currency", currency: "CNY" }) ?? "暂无"}</dd></div>
        </dl>
      )}
    </section>}
    <section ref={lineBoardRef} className={`line-board line-board--${view}`}>
      {loading && !lines.length ? <div className="empty-state"><LoaderCircle className="spin" /><span>正在读取本地材料</span></div> : error ? <div className="empty-state"><FileText /><span>{error}</span></div> : lines.length ? lines.map((line) => <ErrorBoundary key={line.id} label={`票据卡 ${line.title}`}><LineCard key={line.id} line={line} records={records} overrides={state.requirementOverrides} formalModel={formalModel} onToggleRequirement={toggleRequirement} onRemoveMaterial={(filePath) => { removeMaterial(filePath); void refresh(); showNotice("已从系统移除该材料；磁盘文件保留，归档时清理"); }} onRefreshLine={(line) => void handleRefreshLine(line)} onRefreshRecords={() => void refresh()} onUpload={(files, requirement) => void handleUpload(line, files, requirement)} onOpenSubmit={setSubmitTarget} onAskAi={setAskAiTarget} onArchive={(line) => void handleArchive(line)} onRestore={(line) => void handleRestore(line)} onOpenTemplate={(line, requirement) => void handleOpenTemplate(line, requirement)} onAiWrite={(line, requirement) => setTrafficNoteTarget({ line, requirement })} onOpenEvidenceSearch={(line, requirement) => setEvidenceSearchTarget({ line, requirement })} onChangeKind={(line, kind) => { updateLineKind(line.id, kind); showNotice(`已切换为「${kind}」，材料项已更新；已归类文件保持不变`); }} onSaveElabBills={saveLineElabBills} onSaveProject={saveLineProject} budgets={projectBudgets} uploading={uploadingLineId === line.id} refreshing={refreshingLineId === line.id} treasuryPulsing={treasuryPulse.includes(line.id)} openingTemplate={openingTemplateId.startsWith(`${line.id}:`)} onlineJob={onlineJob && onlineJob.lineId === line.id ? onlineJob : null} onOnlineDecide={(action) => void decideOnlineJob(action)} onDismissOnlineJob={dismissOnlineJob} onStopOnlineJob={() => void stopOnlineJob()} showNotice={showNotice} /></ErrorBoundary>) : <div className="empty-state"><Archive size={28} /><strong>{view === "active" ? "还没有进行中的票据集" : "此处暂时没有内容"}</strong>{view === "active" && <button className="create-button" onClick={() => setNewLineOpen(true)}><Plus size={16} /> 新建票据集</button>}</div>}
    </section>
    {newLineOpen && <NewLineDialog onClose={() => setNewLineOpen(false)} onCreate={(title, kind) => { addLine(title, kind); setNewLineOpen(false); showNotice("已创建新的票据集"); }} />}
    {archiveTarget && <ArchiveDialog line={archiveTarget} expenses={formalModel?.expenses.filter((expense) => expense.setId === archiveTarget.id) ?? []} ready={allTreasuryBillsPosted(archiveTarget)} formalModel={formalModel} onClose={() => setArchiveTarget(null)} onArchive={() => void confirmArchive(archiveTarget)} onSplit={(expenseIds, archive) => void handleSplit(archiveTarget, expenseIds, archive)} />}
    {restoreTarget && <div className="dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setRestoreTarget(null); }}>
      <div className="dialog elab-dialog archive-dialog" role="dialog" aria-modal="true" aria-label="还原确认">
        <header className="dialog-head"><h3>还原「{restoreTarget.title}」</h3><button type="button" className="icon-button" aria-label="关闭" onClick={() => setRestoreTarget(null)}><X size={16} /></button></header>
        <div className="dialog-body"><p className="archive-ready is-ok">{restoreTarget.status === "archived"
          ? `还原后回到「${restoreArchiveDestination(restoreTarget) === "submitted" ? "已递交" : "进行中"}」，并保留这次还原记录。`
          : "撤销票据簿中的递交记录，退回「进行中」。"}</p></div>
        <footer className="dialog-footer">
          <button type="button" className="quiet-button" onClick={() => setRestoreTarget(null)}>取消</button>
          <button type="button" className="create-button" disabled={splitting} onClick={() => void confirmRestore(restoreTarget)}>确认还原</button>
        </footer>
      </div>
    </div>}
    {budgetPanelOpen && <BudgetPanelDialog onClose={() => { setBudgetPanelOpen(false); void refreshBudgetStatus(); }} />}
    {dfOpen && <DfDialog showNotice={showNotice} onClose={() => { setDfOpen(false); void refreshDfStatus(); }} />}
    {laborOpen && <LaborDialog showNotice={showNotice} onClose={() => { setLaborOpen(false); void refreshLaborStatus(); }} />}
    {aiSettingsOpen && <AiSettingsDialog settings={aiSettings} onClose={() => setAiSettingsOpen(false)} onSave={saveAiSettings} onTestSuccess={(test) => { localStorage.setItem(AI_BACKEND_TEST_KEY, JSON.stringify(test)); setAiBackendTest(test); }} />}
    {printSettingsOpen && <PrintSettingsDialog summary={printerSummary} loading={printersLoading} onClose={() => setPrintSettingsOpen(false)} onSelect={savePrinterSelection} onRefresh={refreshPrinters} />}
    {submitTarget && <SubmitDialog line={submitTarget} firstRunDelivery={firstRunDelivery} records={records} printLog={printLog} unconfirmedPrintHashes={unconfirmedPrintHashes} onPrintConfirm={handlePrintConfirm} printerSummary={printerSummary} formalModel={formalModel} applicantName={userProfiles.find((profile) => profile.id === activeProfileId)?.profile.chineseName.trim() ?? ""} employeeId={userProfiles.find((profile) => profile.id === activeProfileId)?.profile.employeeId.trim() ?? ""} onClose={() => setSubmitTarget(null)} onPrint={handlePrint} onManualSubmit={handleManualSubmit} onSaveDelivery={saveLineDelivery} onSaveProject={saveLineProject} onSplitLine={(line, expenseIds) => splitLine(line, expenseIds, false)} onOnlineSubmitted={(lineId, jobId, title) => { setOnlineJob({ lineId, jobId, title: title ?? submitTarget.title, state: "running", step: "", progress: 0, billNo: "", error: "", startedAt: Date.now(), logTail: [] }); showNotice("线上递交已启动，卡片将全程显示进度"); }} />}
    {ruleLibraryOpen && <Suspense fallback={null}><RuleLibraryDialog onClose={() => setRuleLibraryOpen(false)} exchangeRates={formalModel?.exchangeRates} onUpdateExchangeRates={(rates) => { updateExchangeRates(rates); showNotice(`已保存 ${rates.length} 个手动汇率；未锁定汇率的费用已同步补齐`); }} onRefreshExchangeRates={async () => { const count = await refreshExchangeRates(); showNotice(`已在线更新 ${count} 个汇率缓存；未锁定汇率的费用已同步补齐`); return count; }} /></Suspense>}
    {userProfilesOpen && <UserProfilesDialog profiles={userProfiles} activeId={activeProfileId} onClose={() => setUserProfilesOpen(false)} onCreate={createProfile} onEdit={editProfile} />}
    {editingProfile && <UserProfileDialog profileId={editingProfile.id} profile={editingProfile.profile} onClose={() => setEditingProfileId("")} onSave={(profile, schoolSsoPassword, signature) => saveProfile(editingProfile.id, profile, schoolSsoPassword, signature)} onNotice={showNotice} />}
    {newProfile && <UserProfileDialog profileId={newProfile.id} profile={newProfile.profile} onClose={() => setNewProfile(null)} onSave={async (profile, schoolSsoPassword, signature) => { await saveProfile(newProfile.id, profile, schoolSsoPassword, signature); setNewProfile(null); }} onNotice={showNotice} />}
    {trafficNoteTarget && (trafficNoteTarget.requirement.templateId === "rebooking-explanation"
      ? <RebookingNoteDialog line={trafficNoteTarget.line} records={records} settings={aiSettings} profileId={activeProfileId} signatureAvailable={Boolean(userProfiles.find((profile) => profile.id === activeProfileId)?.profile.signatureUpdated)} onClose={() => setTrafficNoteTarget(null)} onQueued={(jobId) => { const next = { ...trafficNoteJobs, [trafficNoteTarget.line.id]: jobId }; updateTrafficNoteJobs(next); showNotice("改签说明正在后台生成 PDF；完成后点击本卡片刷新图标"); }} />
      : <TrafficNoteDialog line={trafficNoteTarget.line} records={records} settings={aiSettings} profileId={activeProfileId} signatureAvailable={Boolean(userProfiles.find((profile) => profile.id === activeProfileId)?.profile.signatureUpdated)} onClose={() => setTrafficNoteTarget(null)} onQueued={(jobId) => { const next = { ...trafficNoteJobs, [trafficNoteTarget.line.id]: jobId }; updateTrafficNoteJobs(next); showNotice("交通情况说明正在后台生成 PDF；完成后点击本卡片刷新图标"); }} />)}
      {askAiTarget && <AskAiDialog line={askAiTarget} settings={aiSettings} onClose={() => setAskAiTarget(null)} />}
      {evidenceSearchTarget && <EvidenceSearchDialog line={evidenceSearchTarget.line} requirement={evidenceSearchTarget.requirement} settings={aiSettings} onClose={() => setEvidenceSearchTarget(null)} onLinked={(path, metadata, name) => { updateMeta(path, metadata); void refresh(); showNotice(`已指定费用清单 ${name}`); }} />}
    {materialSearchOpen && <MaterialSearchDialog records={records} lines={state.lines} views={VIEWS} onClose={() => setMaterialSearchOpen(false)} />}
    <button type="button" className="app-version" title="应用版本" aria-haspopup="dialog" onClick={() => setReleaseNotesOpen(true)}>v{appVersion}</button>
    {systemSettingsOpen && <Suspense fallback={null}><DiagnosticsDialog systemSettings onClose={() => setSystemSettingsOpen(false)} /></Suspense>}
    {releaseNotesOpen && <ReleaseNotesDialog version={appVersion} onClose={() => setReleaseNotesOpen(false)} />}
    {notice && <div className="toast"><CheckCircle2 size={17} />{notice}</div>}
    {/* 调试终端暂不显示，反馈入口在系统设置。
    <TerminalConsole />
    */}
  </main>;
}

export default App;
