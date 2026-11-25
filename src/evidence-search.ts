/**
 * 费用清单「AI 搜索引用」共用逻辑：从历史材料中检索可复用的订阅费用清单。
 *
 * 背景（2026-11 用户需求）：订阅类费用（ChatGPT Pro、云服务等）逐月发生，费用清单
 * （套餐价格截图/费用清单 PNG）通常每月完全相同——续费标准不变时无需重复存储，
 * 从历史材料中选一份以符号链接（symlink）方式挂到当前票据集即可。
 * 粗筛与 AI 回复解析在此实现为纯函数：vite middleware 与单元测试共用同一份口径。
 */

/** 模型 evidence 的最小投影（formal-model Evidence 的子集，服务端传入）。 */
export type EvidenceIndexItem = {
  path: string;
  typeId?: string | null;
  workflowNodeId?: string | null;
  extracted?: { issuer?: string; documentDate?: string; amount?: number; currency?: string } | null;
};

export type EvidenceCandidate = {
  path: string;
  name: string;
  /** 所属票据集标题（按 path 前缀匹配 sets.folder 反查；匹配不到为空）。 */
  setTitle: string;
  setFolder: string;
  workflowNodeId: string;
  issuer: string;
  documentDate: string;
  amount: number | null;
  currency: string;
  /** 本地排序得分，综合关键词、费用清单类型和归类节点。 */
  score: number;
  /** AI 判断理由（degraded 时为空，由前端展示兜底文案）。 */
  reason: string;
};

/** 费用清单类材料的判定：证据类型为 fee-schedule，或文件名含清单类关键词（兜底）。 */
const FEE_SCHEDULE_KEYWORDS = /费用清单|套餐价格|价格截图|价目|收费标准|产品页面/;

export function isFeeScheduleLike(item: EvidenceIndexItem): boolean {
  return item.typeId === "fee-schedule" || FEE_SCHEDULE_KEYWORDS.test(item.path.split("/").pop() ?? "");
}

/**
 * 候选粗筛：历史材料中挑费用清单类，当前票据集内材料排除（目标是"引用别处的"），
 * 同归类节点亲和优先、日期新者优先。AI 拿到的是排序列表的前 max 条。
 */
export function feeScheduleCandidates(
  evidence: EvidenceIndexItem[],
  context: { nodeId: string; lineFolder: string; sets: Array<{ folder: string; title: string }>; query?: string; max?: number },
): EvidenceCandidate[] {
  const max = context.max ?? 40;
  const terms = context.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const candidates = evidence
    .filter((item) => isFeeScheduleLike(item))
    .filter((item) => !context.lineFolder || !item.path.startsWith(`${context.lineFolder}/`))
    .map((item) => {
      const name = item.path.split("/").pop() ?? item.path;
      const host = context.sets.find((set) => set.folder && item.path.startsWith(`${set.folder}/`));
      const searchable = [name, item.extracted?.issuer, item.workflowNodeId, host?.title].filter(Boolean).join(" ").toLowerCase();
      const matchedTerms = terms.filter((term) => searchable.includes(term)).length;
      const score =
        matchedTerms * 4 +
        (item.typeId === "fee-schedule" ? 3 : 0) +
        (item.workflowNodeId === context.nodeId ? 2 : 0) +
        (FEE_SCHEDULE_KEYWORDS.test(name) ? 1 : 0);
      return {
        path: item.path,
        name,
        setTitle: host?.title ?? "",
        setFolder: host?.folder ?? "",
        workflowNodeId: item.workflowNodeId ?? "",
        issuer: item.extracted?.issuer ?? "",
        documentDate: item.extracted?.documentDate ?? "",
        amount: item.extracted?.amount ?? null,
        currency: item.extracted?.currency ?? "",
        score,
        reason: "",
      } satisfies EvidenceCandidate;
    })
    .sort((a, b) => b.score - a.score || b.documentDate.localeCompare(a.documentDate) || a.path.localeCompare(b.path));
  return candidates.slice(0, max);
}

export type EvidenceSearchReplyItem = { path: string; match: boolean; reason: string };

/**
 * 解析 AI 回复：期望仅输出 JSON 数组 [{"path": "...", "match": true, "reason": "..."}]。
 * 容错：截取首个 `[` 到末个 `]` 再 parse；path 只保留候选集中出现的（防 AI 编造路径）。
 */
export function parseEvidenceSearchReply(text: string): EvidenceSearchReplyItem[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry): EvidenceSearchReplyItem | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as { path?: unknown; match?: unknown; reason?: unknown };
      if (typeof record.path !== "string" || !record.path) return null;
      return { path: record.path, match: record.match !== false, reason: typeof record.reason === "string" ? record.reason.slice(0, 80) : "" };
    })
    .filter((item): item is EvidenceSearchReplyItem => item !== null);
}

/**
 * 合并 AI 判断到候选列表：match 的按 AI 输出顺序排前（AI 已按适配度排序），其余按粗筛得分殿后；
 * reason 仅对 match 项回填。degraded（AI 不可用）时保持粗筛顺序。
 */
export function applySearchReply(candidates: EvidenceCandidate[], reply: EvidenceSearchReplyItem[]): EvidenceCandidate[] {
  const byPath = new Map(reply.map((item) => [item.path, item]));
  const matched: EvidenceCandidate[] = [];
  const rest: EvidenceCandidate[] = [];
  for (const replyItem of reply) {
    const candidate = candidates.find((item) => item.path === replyItem.path);
    if (candidate && replyItem.match) matched.push({ ...candidate, reason: replyItem.reason || candidate.reason });
  }
  for (const candidate of candidates) {
    const replyItem = byPath.get(candidate.path);
    if (!replyItem || !replyItem.match) rest.push(candidate);
  }
  return [...matched, ...rest];
}
