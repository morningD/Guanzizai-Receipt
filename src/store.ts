import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DAILY_WORKFLOW_VERSION, DAILY_REQUIREMENT_GROUPS, DAILY_REQUIREMENTS, DOMESTIC_CONFERENCE_GROUPS, DOMESTIC_CONFERENCE_REQUIREMENTS, DOMESTIC_TRIP_GROUPS, DOMESTIC_TRIP_REQUIREMENTS, ICME_REQUIREMENT_GROUPS, INTERNATIONAL_ATTACHMENTS, INTERNATIONAL_REQUIREMENTS } from "./data";
import { DEFAULT_BATCHES, DEFAULT_LINES, INITIAL_METADATA, TRAVEL_CASES } from "./legacy-data";
import type {
  ClassificationAssignment,
  MaterialFile,
  PersistedState,
  ReceiptCategory,
  ExpenseLine,
  ReceiptMeta,
  ReceiptRecord,
  ReceiptStatus,
  SubmissionBatch,
  TravelCase,
} from "./types";
import { workflowForLine } from "./workflows";
import { classifiedFileAlsoMatches, classifiedReceiptMetadata } from "./classification-rules";
import { inferExpenseClassification } from "./expense-taxonomy";
import { upgradeLineRequirements } from "./node-registry";
import { lineBillNos, mergeTreasurySnapshot, restoreArchiveDestination } from "./treasury-sync";
import { emptyFormalModel, migrateLegacyState, reconcileFormalModel, stripPreapprovalArtifacts, type ExchangeRateCache, type FormalModelState } from "./formal-model";

const portable = import.meta.env.MODE === "portable";
const STORAGE_KEY = portable ? "ecnu-receipt-desk:portable:v1" : "ecnu-receipt-desk:v1";
const initialLines = portable ? [] : DEFAULT_LINES;
const initialMetadata = portable ? {} : INITIAL_METADATA;
const initialBatches = portable ? [] : DEFAULT_BATCHES;

const emptyState: PersistedState = {
  metadata: initialMetadata,
  requirementOverrides: {},
  batches: initialBatches,
  lines: initialLines.map((line) => ({ ...line, workflowId: workflowForLine(line).id, workflowVersion: 1 })),
};

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      metadata: { ...initialMetadata, ...(parsed.metadata ?? {}) },
      requirementOverrides: parsed.requirementOverrides ?? {},
      batches: parsed.batches?.length ? parsed.batches : initialBatches,
      lines: (() => {
        const storedLines = parsed.lines?.length ? parsed.lines : initialLines;
        const migratedLines = storedLines.map((line) => {
          const currentDefinition = initialLines.find((item) => item.id === line.id);
          if ((line.id === "ccf-open-source-2026" || line.id === "daily-2026-07") && currentDefinition) {
            const workflow = workflowForLine(currentDefinition);
            return {
              ...line,
              kind: line.id === "ccf-open-source-2026" ? "国内会议" as const : currentDefinition.kind,
              requirements: currentDefinition.requirements,
              groups: currentDefinition.groups,
              attachments: currentDefinition.attachments,
              workflowId: line.workflowId ?? workflow.id,
              workflowVersion: line.workflowVersion ?? workflow.version,
            };
          }
          if (line.id === "icme-2026" && currentDefinition) {
            const workflow = workflowForLine(currentDefinition);
            return { ...line, kind: "国际会议" as const, requirements: currentDefinition.requirements, groups: currentDefinition.groups, attachments: currentDefinition.attachments, workflowId: line.workflowId ?? workflow.id, workflowVersion: line.workflowVersion ?? workflow.version };
          }
          const workflow = workflowForLine(line);
          return { ...line, workflowId: line.workflowId ?? workflow.id, workflowVersion: line.workflowVersion ?? workflow.version };
        });
        const missingArchivedLines = initialLines.filter(
          (line) => line.status === "archived" && !migratedLines.some((stored) => stored.id === line.id),
        );
        return [...migratedLines, ...missingArchivedLines];
      })(),
      removedPaths: parsed.removedPaths ?? {},
    };
  } catch {
    return emptyState;
  }
}

function inferCategory(material: MaterialFile): ReceiptCategory {
  const value = `${material.path} ${material.name}`.toLowerCase();
  if (
    TRAVEL_CASES.some(
      (item) =>
        (item.folder && material.path.startsWith(`${item.folder}/`)) ||
        item.match?.test(value),
    )
  ) {
    return "差旅";
  }
  if (/openai|chatgpt|claude|anthropic|receipt-\d/.test(value)) return "AI 订阅";
  if (/随身wifi|移动wifi|5g随身|转接头|充电器|扩展坞|移动硬盘|台灯|u盘|数据线|读卡器|鼠标垫|插线板/i.test(value)) return "低值易耗品";
  if (/六六云|云服务|cloud|vpn|wifi/.test(value)) return "云服务";
  if (/打车|出租|滴滴|交通/.test(value)) return "市内交通";
  if (/专利|实审费|初审|代理协议/.test(value)) return "知识产权";
  if (/书|图书/.test(value)) return "图书资料";
  if (/办公|文具|纸张|饮用水|咖啡|订书机|文件夹|墨盒|硒鼓/.test(value)) return "办公用品";
  return "其他";
}

function inferStatus(material: MaterialFile, category: ReceiptCategory): ReceiptStatus {
  if (material.path.startsWith("01_报销材料/90_已归档/")) return "已归档";
  if (category === "差旅") return "待补件";
  if (/screenshot|截图/i.test(material.name)) return "待识别";
  return "待识别";
}

/** 文件名是本地可验证的兜底来源；AI 识别或人工元数据会在其后覆盖。 */
export function inferFilenameMeta(material: MaterialFile): Required<
  Pick<ReceiptMeta, "category" | "status" | "currency" | "expenseClassification">
> & Pick<ReceiptMeta, "amount" | "issuer" | "invoiceDate"> {
  const category = inferCategory(material);
  const expense = inferExpenseClassification(`${material.path} ${material.name}`);
  const date = material.name.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const amountMatch = material.name.match(/(?:CNY|USD|SGD|AED|THB|EUR|JPY|HKD|GBP)(\d+(?:\.\d+)?)/i);
  const currencyMatch = material.name.match(/(?:CNY|USD|SGD|AED|THB|EUR|JPY|HKD|GBP)/i)?.[0]?.toUpperCase();
  const issuer = material.name.match(/\d{4}-\d{2}-\d{2}_([^_]+)/)?.[1];
  return {
    category,
    status: inferStatus(material, category),
    currency: (["CNY", "USD", "SGD", "AED", "THB", "EUR", "JPY", "HKD", "GBP"].includes(currencyMatch ?? "") ? currencyMatch : "CNY") as NonNullable<ReceiptMeta["currency"]>,
    expenseClassification: expense.label,
    ...(amountMatch ? { amount: Number(amountMatch[1]) } : {}),
    ...(date ? { invoiceDate: date } : {}),
    ...(issuer ? { issuer } : {}),
  };
}

export function filesForTravelCase(records: ReceiptRecord[], travelCase: TravelCase) {
  return records.filter((record) => {
    if (travelCase.folder) return record.path.startsWith(`${travelCase.folder}/`);
    return travelCase.match?.test(`${record.path} ${record.name}`) ?? false;
  });
}

export function requirementKey(caseId: string, requirementId: string) {
  return `${caseId}:${requirementId}`;
}

export function clearNegativeOverridesForLine(overrides: Record<string, boolean>, lineId: string) {
  const prefix = `${lineId}:`;
  return Object.fromEntries(
    Object.entries(overrides).filter(([key, value]) => !key.startsWith(prefix) || value),
  );
}

/**
 * 模型归类回写 metadata：模型按内容哈希追踪文件（改名不丢归类），metadata 按 path 存。
 * 因此除更新已有条目，还要为磁盘上仍存在、但缺归类的新 path 补条目；返回原引用表示无变化。
 */
export function backfillClassifiedMetadata(
  metadata: Record<string, ReceiptMeta>,
  nodeByPath: Map<string, string>,
  livePaths: Set<string>,
): Record<string, ReceiptMeta> {
  let changed = false;
  const next = { ...metadata };
  for (const [path, nodeId] of nodeByPath) {
    if (!nodeId || !livePaths.has(path)) continue;
    const meta = next[path];
    if (meta?.classifiedRequirementId === nodeId) continue;
    next[path] = { ...meta, classifiedRequirementId: nodeId, classifiedWorkflowNodeId: nodeId };
    changed = true;
  }
  return changed ? next : metadata;
}

/** 快照版本化对齐（转发注册表；保留导出名供既有调用与测试）。 */
export function upgradeLegacyLineRequirements(line: ExpenseLine): ExpenseLine {
  // 日常工作流不在 node-registry 的 WORKFLOWS 内（差旅/会议专用），按 DAILY_WORKFLOW_VERSION 独立对齐。
  if (line.kind === "日常" && (line.workflowVersion ?? 0) < DAILY_WORKFLOW_VERSION) {
    return { ...line, requirements: DAILY_REQUIREMENTS, groups: DAILY_REQUIREMENT_GROUPS, workflowVersion: DAILY_WORKFLOW_VERSION };
  }
  return upgradeLineRequirements(line);
}

/** 状态终态自愈：物理目录已在归档区（90_已归档）的票据集强制 archived——历史归档只搬目录未改状态、或状态被错误重置时，加载即对齐。 */
export function healLineStatus(line: ExpenseLine): ExpenseLine {
  // 带 treasury 标记的行 status 由财务对齐脚本权威管理（已递交在途单即使 folder 在归档目录也保持 submitted）——
  // heal 覆盖会与服务器 PUT 的权威回写形成 submitted↔archived 循环写盘（2026-09-23 实证）。
  if (line.treasuryBillNo || line.treasuryStatus) return line;
  return line.folder?.startsWith("01_报销材料/90_已归档/") && line.status !== "archived" ? { ...line, status: "archived" } : line;
}

/** 会议通知材料的误归类清理：文件名表明是通知/日程，却带 registration-fee 归类（旧候选集时代的残留），删元数据让规则重新推断。 */
export function purgeMisclassifiedNoticeMeta(metadata: Record<string, ReceiptMeta>): Record<string, ReceiptMeta> {
  let changed = false;
  const next: Record<string, ReceiptMeta> = {};
  for (const [p, m] of Object.entries(metadata)) {
    if (/会议通知(第四轮|-日程)|第四轮_日程|会议通知第四轮/.test(p) && m.classifiedRequirementId === "registration-fee") {
      changed = true;
      continue;
    }
    next[p] = m;
  }
  return changed ? next : metadata;
}

export function isRequirementComplete(
  travelCase: TravelCase,
  requirementId: string,
  files: ReceiptRecord[],
  overrides: Record<string, boolean>,
) {
  const key = requirementKey(travelCase.id, requirementId);
  if (key in overrides) return overrides[key];
  const target = travelCase.requirements.find((item) => item.id === requirementId);
  if (!target) return false;
  return files.some((file) => {
    if (target.templateId && file.name.includes("模板")) return false;
    const classified = file.classifiedRequirementId ?? file.classifiedWorkflowNodeId;
    if (classified || file.classifiedRequirementId) {
      if (classified === requirementId || (requirementId === "return" && file.classifiedRequirementId === "return-confirmation")) return true;
      // 铁路电子客票发票一张顶两张（交通发票+乘車凭证），与 workflow.ts / App.tsx 例外一致。
      if (classifiedFileAlsoMatches(classified ?? "", requirementId, file.name)) return true;
      return false;
    }
    // 关键词只匹配文件名：路径中的子目录名（如“02_会议通知与准备”）会把整目录文件误配给同名材料项。
    const normalized = file.name.toLowerCase();
    return target.keywords.some((keyword) => keyword.toLowerCase().split("&").map((part) => part.trim()).filter(Boolean).every((part) => normalized.includes(part)));
  });
}

export function materialUrl(filePath: string) {
  return `/materials/${filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function useReceiptStore() {
  const [materials, setMaterials] = useState<MaterialFile[]>([]);
  // pullModelState 吸收 model.sets.folder 前用它校验该目录下确有材料，防止旧快照把 folder 回滚成失效路径。
  const materialsRef = useRef<MaterialFile[]>([]);
  materialsRef.current = materials;
  // 服务器 merge 完成前禁止持久化 effect 写回 server：防止新环境首帧把 DEFAULT_LINES 常量快照当真实状态覆盖服务器副本（folder 回滚事故的写入端）。
  const serverMergeDoneRef = useRef(false);
  const refreshRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<PersistedState>(loadState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formalModel, setFormalModel] = useState<FormalModelState | null>(null);
  const [libraryHydrated, setLibraryHydrated] = useState(!portable);
  // 服务器权威行清单：reconcile model.sets 时过滤本地静态默认集（acm/chongqing 等归档样例只存 localStorage，
  // 服务器 PUT 会再过滤——不过滤则 16↔18 每轮摆动循环写盘）
  const serverLineIdsRef = useRef<Set<string>>(new Set());
  /** 最近一次模型吸收中财务状态发生变化的行 id；UI 用脉冲动画突出，数秒后清除。 */
  const [treasuryPulse, setTreasuryPulse] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/materials");
      if (!response.ok) throw new Error("无法读取本地材料目录");
      setMaterials((await response.json()) as MaterialFile[]);
      setError("");
      // 同时拉取形式化模型：吸收财务对齐脚本写入的报销单状态（递交进度）。
      // 不阻塞材料扫描：模型拉取在后台完成，loading 只覆盖目录扫描。
      void pullModelState();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "材料读取失败");
    } finally {
      setLoading(false);
    }
  }, []);
  refreshRef.current = refresh;

  /** 拉取服务器形式化模型并吸收脚本侧变更（treasury 状态/行迁移/墓碑）。启动与手动刷新共用。 */
  const pullModelState = useCallback(async () => {
    const modelResponse = await fetch("/api/model-state").catch(() => null);
    if (!modelResponse?.ok) return false;
    const payload = await modelResponse.json().catch(() => null) as { model?: FormalModelState | null } | null;
    if (!payload?.model) return false;
    // 服务器文件可能残留拦截修复前误建的前置单费用（reconcile 只增不删时代）——吸收前先净化
    const sanitized = stripPreapprovalArtifacts(payload.model);
    setFormalModel(sanitized);
    const aligned = new Map((sanitized.sets ?? [])
      .filter((entry) => lineBillNos(entry).length > 0 || Boolean(entry.treasuryBills?.length) || typeof entry.treasuryStatus === "string" || Boolean(entry.archivedAt || entry.lastArchiveRestore))
      .map((entry) => [entry.id, entry]));
    const alignedByFolder = new Map([...aligned.values()].filter((entry) => typeof entry.folder === "string").map((entry) => [entry.folder, entry]));
    const tombstones = payload.model.removedSetIds ?? [];
    if (!aligned.size && !tombstones.length) return true;
    // 吸收 folder 前校验该目录下确有材料：model.sets.folder 是快照，可能落后于实际文件布局；
    // 无校验会把 line.folder 回滚成失效路径，导致行内文件按 folder 前缀过滤后全部落空（渲染全灭事故）。
    const folderHasFiles = (folder: string) => materialsRef.current.some((material) => material.path.startsWith(`${folder}/`));
    const absorbedFolder = (source: { folder?: string }, fallback: string) =>
      typeof source.folder === "string" && folderHasFiles(source.folder) ? source.folder : fallback;
    setState((current) => {
      let changed = false;
      let lines = current.lines;
      if (tombstones.length) {
        const next = lines.filter((line) => !tombstones.includes(line.id));
        if (next.length !== lines.length) { lines = next; changed = true; }
      }
      const pulsed: string[] = [];
      lines = lines.map((line) => {
        const source = aligned.get(line.id) ?? (line.folder ? alignedByFolder.get(line.folder) : undefined);
        if (!source) return line;
        const next = mergeTreasurySnapshot(line, source, absorbedFolder(source, line.folder));
        if (next === line) return line;
        changed = true;
        pulsed.push(line.id);
        return next;
      });
      if (pulsed.length) window.setTimeout(() => setTreasuryPulse((current) => current.filter((id) => !pulsed.includes(id))), 6_000);
      if (changed) setTreasuryPulse((current) => [...new Set([...current, ...pulsed])]);
      let healed = false;
      lines = lines.map((line) => {
        const next = healLineStatus(line);
        if (next !== line) healed = true;
        return next;
      });
      if (healed) changed = true;
      return changed ? { ...current, lines } : current;
    });
    return true;
  }, []);

  // 票据集服务器化：服务器有副本则以服务器为准（跨浏览器一致）；服务器为空且本地有数据则自动迁移一次
  useEffect(() => {
    void (async () => {
      try {
        const [linesRes, metaRes, modelRes] = await Promise.all([
          fetch('/api/receipt-lines'),
          fetch('/api/receipt-meta'),
          portable ? fetch('/api/model-state') : Promise.resolve(null),
        ]);
        if (portable) {
          if (!modelRes?.ok || (!linesRes.ok && linesRes.status !== 404) || (!metaRes.ok && metaRes.status !== 404)) return;
          const models = await modelRes.json() as { model?: FormalModelState | null };
          const linesBody = linesRes.ok ? await linesRes.json() as { lines?: ExpenseLine[]; removedIds?: string[] } : {};
          const metaBody = metaRes.ok ? await metaRes.json() as { metadata?: Record<string, ReceiptMeta> } : {};
          const model = models.model ? stripPreapprovalArtifacts(models.model) : null;
          const removed = new Set([...(linesBody.removedIds ?? []), ...(model?.removedSetIds ?? [])]);
          const lines = (linesBody.lines?.length ? linesBody.lines : model?.sets ?? [])
            .filter((line) => !removed.has(line.id)).map((line) => healLineStatus(upgradeLegacyLineRequirements(line)));
          serverLineIdsRef.current = new Set(lines.map((line) => line.id));
          setFormalModel(model);
          setState((current) => ({
            ...current,
            lines,
            metadata: purgeMisclassifiedNoticeMeta({ ...current.metadata, ...metaBody.metadata }),
            batches: model?.batches ?? current.batches,
            requirementOverrides: model?.requirementOverrides ?? current.requirementOverrides,
          }));
          serverMergeDoneRef.current = true;
          setLibraryHydrated(true);
          return;
        }
        if (linesRes.ok) {
          const body = await linesRes.json() as { lines?: ExpenseLine[]; removedIds?: string[] };
          const serverLines = body.lines ?? [];
          const removedIds = new Set(body.removedIds ?? []);
          const metaBody = metaRes.ok ? await metaRes.json() as { metadata?: Record<string, ReceiptMeta> } : {};
          const serverMeta = metaBody.metadata ?? {};
          if (Array.isArray(serverLines) && serverLines.length) {
            serverLineIdsRef.current = new Set(serverLines.map((line) => line.id));
            setState((current) => {
              const serverIds = new Set(serverLines.map((line) => line.id));
              const localOnly = current.lines.filter((line) => !serverIds.has(line.id) && !removedIds.has(line.id));
              const merged = [...serverLines, ...localOnly].map((line) => healLineStatus(upgradeLegacyLineRequirements(line)));
              const metadata = purgeMisclassifiedNoticeMeta({ ...current.metadata, ...serverMeta });
              return { ...current, lines: merged, metadata };
            });
          }
          serverMergeDoneRef.current = true;
          return;
        }
        const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as { lines?: ExpenseLine[]; metadata?: Record<string, ReceiptMeta> };
        if (Array.isArray(local.lines) && local.lines.length) {
          await Promise.all([
            fetch('/api/receipt-lines', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lines: local.lines }) }),
            fetch('/api/receipt-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ metadata: local.metadata ?? {} }) }),
          ]);
        }
        serverMergeDoneRef.current = true;
      } catch { if (!portable) serverMergeDoneRef.current = true; /* 读取失败时保留服务器快照。 */ }
    })();
    // 定期对齐（2026-09-19）：登记字段（elabBills/treasuryBillNo/status/folder）以服务器为准——
    // 拆分迁移/registry 剥离/别的窗口的修改，30s 内自动同步到所有打开的窗口（旧快照洗数据问题的最终解）。
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/receipt-lines');
        if (!res.ok) return;
        const body = await res.json() as { lines?: ExpenseLine[]; removedIds?: string[] };
        if (!Array.isArray(body.lines) || !body.lines.length) return;
        const removedIds = new Set(body.removedIds ?? []);
        serverLineIdsRef.current = new Set(body.lines!.map((l) => l.id));
        setState((current) => {
          const serverIds = new Set(body.lines!.map((l) => l.id));
          const localOnly = current.lines.filter((line) => !serverIds.has(line.id) && !removedIds.has(line.id));
          const merged = [...body.lines!, ...localOnly].map((line) => healLineStatus(upgradeLegacyLineRequirements(line)));
          // 内容比较（引用永真会循环触发 PUT：heal/upgrade 对部分行每次返回新对象）。
          // 全量 JSON 比较覆盖 status/folder/elabBills/treasuryBillNo/groups/requirements 全部关键字段。
          const changed = JSON.stringify(merged) !== JSON.stringify(current.lines);
          return changed ? { ...current, lines: merged } : current;
        });
        // 归属变化会连带材料清单（records 来自 receipt-meta）——检测到变化时刷新一次 records
        if (refreshRef.current) refreshRef.current();
        // model 缓存同步对齐：服务端拆分/迁移会改 expenses.setId——浏览器旧缓存经 reconcile 回写会洗掉
        // 服务端改动（2026-09-19 低耗拆分实证），必须同周期拉 model-state 刷新本地 formalModel。
        try {
          const modelRes = await fetch('/api/model-state');
          if (modelRes.ok) {
            const modelBody = await modelRes.json() as { model?: FormalModelState | null };
            if (modelBody.model) setFormalModel(stripPreapprovalArtifacts(modelBody.model));
          }
        } catch { /* model 对齐失败跳过 */ }
      } catch { /* 服务器不可达：跳过本轮 */ }
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => { void pullModelState(); }, [pullModelState]);

  // 让已打开页面也能补入后来登记的本机历史归档目录。
  useEffect(() => {
    setState((current) => {
      const missingArchivedLines = initialLines.filter(
        (line) => line.status === "archived" && !current.lines.some((stored) => stored.id === line.id),
      );
      return missingArchivedLines.length
        ? { ...current, lines: [...current.lines, ...missingArchivedLines] }
        : current;
    });
  }, []);

  useEffect(() => {
    if (!serverMergeDoneRef.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // 票据集双写服务器（跨浏览器/无头自动化一致视图）；服务器对过期快照自动合并缺失行（stale-snapshot 防护）
    void Promise.all([
      fetch('/api/receipt-lines', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: state.lines }) }).then(async (res) => {
          const body = await res.json() as { ok?: boolean; lines?: ExpenseLine[]; removedIds?: string[] };
          const removedIds = new Set(body.removedIds ?? []);
          // 服务端合并（stale-snapshot 防护）后返回权威全集：本地 lines 过旧时对齐（UI 立即反映正确归属）
          if (body.ok && Array.isArray(body.lines) && body.lines.length) {
            serverLineIdsRef.current = new Set(body.lines!.map((l) => l.id));
            setState((current) => {
              const serverIds = new Set(body.lines!.map((l) => l.id));
              const localOnly = current.lines.filter((line) => !serverIds.has(line.id) && !removedIds.has(line.id));
              const merged = [...body.lines!, ...localOnly].map((line) => healLineStatus(upgradeLegacyLineRequirements(line)));
              // 内容比较（引用永真会导致 PUT→setState→PUT 无限循环：heal/upgrade 对部分行每次返回新对象）
              const changed = JSON.stringify(merged) !== JSON.stringify(current.lines);
              return changed ? { ...current, lines: merged } : current;
            });
          }
          return res;
        }),
      fetch('/api/receipt-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: state.metadata }) }),
    ]).catch(() => undefined);
  }, [state]);

  const records = useMemo<ReceiptRecord[]>(
    () =>
      materials
        .filter((material) => !state.removedPaths?.[material.path])
        .map((material) => {
        const inferred = inferFilenameMeta(material);
        const metadata = state.metadata[material.path] ?? {};
        const batch = state.batches.find((item) =>
          item.receiptPaths.includes(material.path),
        );
        const batchStatus: ReceiptStatus | undefined = batch
          ? batch.status === "submitted"
            ? "已归档"
            : "已入批次"
          : undefined;
        return {
          ...material,
          ...inferred,
          ...metadata,
          status: batchStatus ?? metadata.status ?? inferred.status,
        };
      }),
    [materials, state.batches, state.metadata, state.removedPaths],
  );

  useEffect(() => {
    if (!libraryHydrated || !formalModel || !records.length) return;
    const linesSource = serverLineIdsRef.current.size
      ? { ...state, lines: state.lines.filter((line) => serverLineIdsRef.current.has(line.id)) }
      : state;
    const next = formalModel.migrated
      ? reconcileFormalModel(formalModel, linesSource, records)
      : migrateLegacyState(linesSource, records);
    if (JSON.stringify(next) === JSON.stringify(formalModel)) return;
    setFormalModel(next);
    void fetch("/api/model-state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    // 形式化模型中的归类（含手工修正）回写 metadata，保证 UI 匹配与模型一致（见 backfillClassifiedMetadata）。
    const nodeByPath = new Map(next.evidence.flatMap((item) => (item.workflowNodeId ? [[item.path, item.workflowNodeId] as const] : [])));
    const livePaths = new Set(records.map((record) => record.path));
    setState((current) => {
      const metadata = backfillClassifiedMetadata(current.metadata, nodeByPath, livePaths);
      return metadata === current.metadata ? current : { ...current, metadata };
    });
  }, [formalModel, records, state, libraryHydrated]);

  const updateMeta = useCallback((path: string, patch: ReceiptMeta) => {
    setState((current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        [path]: { ...(current.metadata[path] ?? {}), ...patch },
      },
    }));
  }, []);

  const applyExchangeRates = useCallback((updates: Array<{ currency: ReceiptRecord["currency"]; cnyRate: number; effectiveDate?: string }>, source: ExchangeRateCache["source"]) => {
    const valid = updates.filter((item) => Number.isFinite(item.cnyRate) && item.cnyRate > 0 && item.currency !== "CNY");
    if (!valid.length) return;
    setFormalModel((current) => {
      const base = current ?? emptyFormalModel();
      const updatedAt = new Date().toISOString().slice(0, 10);
      const currencies = new Set(valid.map((item) => item.currency));
      const exchangeRates = [...base.exchangeRates.filter((item) => !currencies.has(item.currency)), ...valid.map((item) => ({ ...item, updatedAt, effectiveDate: item.effectiveDate ?? updatedAt, source }))];
      const rateByCurrency = new Map(exchangeRates.map((item) => [item.currency, item]));
      const expenses = base.expenses.map((expense) => {
        if (expense.status !== "needs-rate") return expense;
        const rate = rateByCurrency.get(expense.currency);
        if (!rate || expense.amount == null) return expense;
        return { ...expense, amountCny: expense.amount * rate.cnyRate, exchangeRate: { cnyRate: rate.cnyRate, cachedAt: rate.updatedAt, source: rate.source }, status: "identified" as const };
      });
      const next = { ...base, exchangeRates, expenses };
      void fetch("/api/model-state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      return next;
    });
  }, []);

  const updateExchangeRates = useCallback((updates: Array<{ currency: ReceiptRecord["currency"]; cnyRate: number }>) => {
    applyExchangeRates(updates, "manual");
  }, [applyExchangeRates]);

  const refreshExchangeRates = useCallback(async () => {
    const response = await fetch("/api/exchange-rates/refresh", { method: "POST" });
    const body = await response.json() as { error?: string; rates?: Array<{ currency: ReceiptRecord["currency"]; cnyRate: number; effectiveDate: string }> };
    if (!response.ok || !body.rates?.length) throw new Error(body.error ?? "在线汇率更新失败");
    applyExchangeRates(body.rates, "online");
    return body.rates.length;
  }, [applyExchangeRates]);

  const toggleRequirement = useCallback(
    (caseId: string, requirementId: string, completed: boolean) => {
      setState((current) => ({
        ...current,
        requirementOverrides: {
          ...current.requirementOverrides,
          [requirementKey(caseId, requirementId)]: completed,
        },
      }));
    },
    [],
  );

  const reconcileLine = useCallback((lineId: string) => {
    setState((current) => ({
      ...current,
      requirementOverrides: clearNegativeOverridesForLine(current.requirementOverrides, lineId),
    }));
  }, []);

  /** 从系统视图移除材料：保留磁盘文件，票据集归档时才清理；可撤销。 */
  const removeMaterial = useCallback((filePath: string) => {
    setState((current) => {
      const { [filePath]: _removed, ...metadata } = current.metadata;
      const { [filePath]: _override, ...restRemoved } = current.removedPaths ?? {};
      return {
        ...current,
        metadata,
        removedPaths: { ...restRemoved, [filePath]: true as const },
      };
    });
  }, []);

  const restoreMaterial = useCallback((filePath: string) => {
    setState((current) => {
      const { [filePath]: _restored, ...removedPaths } = current.removedPaths ?? {};
      return { ...current, removedPaths };
    });
  }, []);

  const applyClassifications = useCallback((assignments: ClassificationAssignment[]) => {
    if (!assignments.length) return;
    setState((current) => ({
      ...current,
      metadata: assignments.reduce<Record<string, ReceiptMeta>>((metadata, assignment) => ({
        ...metadata,
        [assignment.path]: classifiedReceiptMetadata(metadata[assignment.path], assignment),
      }), current.metadata),
    }));
  }, []);

  const addBatch = useCallback((title: string) => {
    const batch: SubmissionBatch = {
      id: `batch-${Date.now()}`,
      title,
      createdAt: new Date().toISOString().slice(0, 10),
      status: "draft",
      receiptPaths: [],
    };
    setState((current) => ({
      ...current,
      batches: [batch, ...current.batches],
    }));
    return batch.id;
  }, []);

  const addToBatch = useCallback((batchId: string, paths: string[]) => {
    setState((current) => ({
      ...current,
      batches: current.batches.map((batch) =>
        batch.id === batchId
          ? {
              ...batch,
              receiptPaths: [...new Set([...batch.receiptPaths, ...paths])],
            }
          : {
              ...batch,
              receiptPaths: batch.receiptPaths.filter(
                (path) => !paths.includes(path),
              ),
            },
      ),
    }));
  }, []);

  const submitBatch = useCallback((batchId: string) => {
    setState((current) => ({
      ...current,
      batches: current.batches.map((batch) =>
        batch.id === batchId
          ? {
              ...batch,
              status: "submitted",
              submittedAt: new Date().toISOString().slice(0, 10),
            }
          : batch,
      ),
    }));
  }, []);

  const addLine = useCallback((title: string, kind: ExpenseLine["kind"]) => {
    const createdAt = new Date().toISOString().slice(0, 10);
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-").trim();
    const requirements =
      kind === "国内会议"
        ? DOMESTIC_CONFERENCE_REQUIREMENTS
        : kind === "国内差旅"
          ? DOMESTIC_TRIP_REQUIREMENTS
          : kind === "国际会议"
            ? INTERNATIONAL_REQUIREMENTS
        : DAILY_REQUIREMENTS;
    const groups =
      kind === "国内会议"
        ? DOMESTIC_CONFERENCE_GROUPS
        : kind === "国内差旅"
          ? DOMESTIC_TRIP_GROUPS
          : kind === "国际会议"
            ? ICME_REQUIREMENT_GROUPS
            : DAILY_REQUIREMENT_GROUPS;
    const id = `line-${Date.now()}`;
    const root = kind === "日常" ? "20_待提交" : "10_办理中";
    const line: ExpenseLine = {
      id,
      title: safeTitle || "未命名票据集",
      kind,
      createdAt,
      status: "active",
      folder: `01_报销材料/${root}/${createdAt}_${safeTitle || "未命名票据集"}`,
      requirements,
      groups,
      attachments: kind === "国际会议" ? INTERNATIONAL_ATTACHMENTS : undefined,
      workflowId: workflowForLine({ kind } as ExpenseLine).id,
      workflowVersion: workflowForLine({ kind } as ExpenseLine).version,
    };
    setState((current) => ({ ...current, lines: [line, ...current.lines] }));
  }, []);

  const updateLineStatus = useCallback((lineId: string, status: ExpenseLine["status"]) => {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === lineId
          ? { ...line, status, submittedAt: status === "submitted" ? new Date().toISOString().slice(0, 10) : line.submittedAt }
          : line,
      ),
    }));
  }, []);

  /** 登记报销单号（递交后，由财务对齐或人工填写）。 */
  const updateLineTreasuryBill = useCallback((lineId: string, bill: Partial<Pick<ExpenseLine, "treasuryBillNo" | "treasuryStatus" | "treasuryStatusAt" | "treasuryVoucherNo" | "treasuryPostedAt">>) => {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, ...bill } : line)),
    }));
  }, []);

  /** 切换票据集类型：换用目标类型的标准材料项与分组，并同步 workflowId；已归类的材料文件不动，重新对齐即可。 */
  const updateLineKind = useCallback((lineId: string, kind: ExpenseLine["kind"]) => {
    setState((current) => {
      const target = current.lines.find((line) => line.id === lineId);
      if (!target || target.kind === kind) return current;
      const requirements =
        kind === "国内会议" ? DOMESTIC_CONFERENCE_REQUIREMENTS
          : kind === "国内差旅" ? DOMESTIC_TRIP_REQUIREMENTS
            : kind === "国际会议" ? INTERNATIONAL_REQUIREMENTS
              : DAILY_REQUIREMENTS;
      const groups =
        kind === "国内会议" ? DOMESTIC_CONFERENCE_GROUPS
          : kind === "国内差旅" ? DOMESTIC_TRIP_GROUPS
            : kind === "国际会议" ? ICME_REQUIREMENT_GROUPS
              : DAILY_REQUIREMENT_GROUPS;
      const next: ExpenseLine = { ...target, kind, requirements, groups, attachments: kind === "国际会议" ? INTERNATIONAL_ATTACHMENTS : undefined, workflowId: workflowForLine({ kind } as ExpenseLine).id, workflowVersion: 1 };
      return { ...current, lines: current.lines.map((line) => line.id === lineId ? next : line) };
    });
  }, []);

  /** 保存票据集投递参数（递交对话框内编辑，随递交绑定）。 */
  const saveLineDelivery = useCallback((lineId: string, delivery: ExpenseLine["delivery"]) => {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, delivery } : line)),
    }));
  }, []);

  /** 保存票据集线上递交使用的预算项目。 */
  const saveLineProject = useCallback((lineId: string, projectId: string) => {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, projectId: projectId || undefined } : line)),
    }));
  }, []);

  /** 保存票据集的 elab/wxzc 前置报账单登记（空列表移除字段）。 */
  const saveLineElabBills = useCallback((lineId: string, elabBills: ExpenseLine["elabBills"]) => {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.id === lineId ? { ...line, elabBills: elabBills?.length ? elabBills : undefined } : line)),
    }));
  }, []);

  const moveLine = useCallback(async (line: ExpenseLine, destination: "submitted" | "archived" | "restore", options?: { postedOnly?: boolean; deferRefresh?: boolean }) => {
    const params = new URLSearchParams({ folder: line.folder, destination });
    if (options?.postedOnly) {
      params.set("postedOnly", "true");
      params.set("lineId", line.id);
    }
    if (destination === "restore" && line.status === "archived") {
      params.set("restoreTo", restoreArchiveDestination(line));
    }
    const response = await fetch(
      `/api/move-line?${params}`,
      { method: "POST" },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? "移动票据集失败");
    }
    const body = (await response.json()) as { folder: string; status?: string; archivedAt?: string; restoredAt?: string };
    // 归档确认成功后，清理用户先前移除过的材料。
    if (destination === "archived") {
      const removedInLine = Object.keys(state.removedPaths ?? {}).filter((filePath) => filePath.startsWith(`${line.folder}/`));
      await Promise.all(removedInLine.map((filePath) =>
        fetch(`/api/delete-material?path=${encodeURIComponent(body.folder + filePath.slice(line.folder.length))}`, { method: "POST" }).catch(() => undefined),
      ));
    }
    setState((current) => ({
      ...current,
      lines: current.lines.map((item) =>
        item.id === line.id
          ? {
              ...item,
              folder: body.folder,
              status: (destination === "restore" ? (body.status as ExpenseLine["status"]) : destination === "submitted" ? "submitted" : "archived"),
              archivedAt: destination === "archived" ? body.archivedAt ?? item.archivedAt : undefined,
              lastArchiveRestore: body.restoredAt
                ? { archivedAt: line.archivedAt, restoredAt: body.restoredAt }
                : item.lastArchiveRestore,
              submittedAt:
                destination === "submitted"
                  ? new Date().toISOString().slice(0, 10)
                  : item.submittedAt,
            }
          : item,
      ),
    }));
    if (!options?.deferRefresh) await refresh();
  }, [refresh, state.removedPaths]);

  /** 拆分归档：按费用分类把选中 expenses（含关联材料文件）拆成独立票据集；archive=true 时拆出即归档（如云服务走别人经费）。 */
  const splitLine = useCallback(async (line: ExpenseLine, expenseIds: string[], archive: boolean, finalize?: { billNo: string; group?: string }) => {
    const response = await fetch("/api/split-line", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceLineId: line.id, expenseIds, archive, finalize }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? "拆分票据集失败");
    }
    const body = await response.json() as { lineId: string; folder: string; moved: number; expenses: number; line?: ExpenseLine };
    if (!body.line) throw new Error("拆分响应缺少新票据集");
    // 新集并入本地状态（split-line 只写 model/文件，不写 receipt-lines——双写依赖此步；否则列表/悬浮卡片都看不到新集）
    setState((current) => ({
      ...current,
      lines: [...current.lines.filter((item) => item.id !== body.lineId), body.line!],
    }));
    await refresh();
    return body;
  }, [refresh]);

  /** 分组递交收尾：新集（拆出）进已递交继承单号，原集回进行中。 */
  const applyGroupSplit = useCallback((splitLineId: string, sourceLineId: string, folder: string, billNo: string) => {
    setState((current) => ({
      ...current,
      lines: current.lines.map((item) => {
        if (item.id === splitLineId) return { ...item, folder, status: "submitted" as const, submittedAt: new Date().toISOString().slice(0, 10), treasuryBillNo: billNo };
        if (item.id === sourceLineId) return { ...item, status: "active" as const, treasuryBillNo: undefined };
        return item;
      }),
    }));
  }, []);

  /** 拆分递交：把选中费用（含关联材料）拆成独立票据集并直接置为已递交；其余费用/材料留在原集继续进行中。 */
  const splitSubmitLine = useCallback(async (line: ExpenseLine, expenseIds: string[]) => {
    const response = await fetch("/api/split-line", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceLineId: line.id, expenseIds, archive: false }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? "拆分票据集失败");
    }
    const body = (await response.json()) as { lineId: string; folder: string; moved: number; expenses: number; line?: ExpenseLine };
    if (!body.line) throw new Error("拆分响应缺少新票据集");
    // 拆出的新集先并入本地状态（服务器 receipt-lines 以此为权威源），再移入已递交目录。
    const moveResponse = await fetch(`/api/move-line?folder=${encodeURIComponent(body.folder)}&destination=submitted`, { method: "POST" });
    if (!moveResponse.ok) {
      const moveBody = (await moveResponse.json()) as { error?: string };
      throw new Error(moveBody.error ?? "移动票据集失败");
    }
    const moveBody = (await moveResponse.json()) as { folder: string };
    const submittedAt = new Date().toISOString().slice(0, 10);
    setState((current) => ({
      ...current,
      lines: [
        ...current.lines.filter((item) => item.id !== body.lineId),
        { ...body.line!, folder: moveBody.folder, status: "submitted" as const, submittedAt },
      ],
    }));
    await refresh();
    return body;
  }, [refresh]);

  const importFiles = useCallback(
    async (files: FileList | File[], folder?: string, onDuplicate?: (names: string[]) => void) => {
      const importedPaths: string[] = [];
      const duplicates: string[] = [];
      for (const file of Array.from(files)) {
        const response = await fetch(
          `/api/import?filename=${encodeURIComponent(file.name)}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          },
        );
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? `无法导入 ${file.name}`);
        }
        const body = (await response.json()) as { path?: string; duplicate?: boolean };
        // 服务端内容去重：同票据集已有相同文件（SHA-256 一致）时不再收录，仅提示已存在的路径。
        if (body.duplicate) {
          duplicates.push(file.name);
          continue;
        }
        if (body.path) importedPaths.push(body.path);
      }
      await refresh();
      if (duplicates.length) {
        onDuplicate?.(duplicates);
      }
      return importedPaths;
    },
    [refresh],
  );

  const exportBackup = useCallback(() => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "receipt-data.backup.json";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }, [state]);

  return {
    records,
    treasuryPulse,
    state,
    formalModel,
    loading,
    error,
    refresh,
    pullModelState,
    updateMeta,
    updateExchangeRates,
    refreshExchangeRates,
    toggleRequirement,
    reconcileLine,
    removeMaterial,
    restoreMaterial,
    applyClassifications,
    addBatch,
    addToBatch,
    submitBatch,
    addLine,
    splitLine,
    splitSubmitLine,
    applyGroupSplit,
    updateLineStatus,
    updateLineTreasuryBill,
    updateLineKind,
    saveLineDelivery,
    saveLineProject,
    saveLineElabBills,
    moveLine,
    importFiles,
    exportBackup,
  };
}
