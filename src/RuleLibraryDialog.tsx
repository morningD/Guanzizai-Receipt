import { ArrowDown, ArrowLeft, ArrowRight, Download, GitBranch, X } from "lucide-react";
import { useState } from "react";
import { EVIDENCE_TAXONOMY, EXCHANGE_RATE_TAXONOMY, EXPENSE_TAXONOMY } from "./expense-taxonomy";
import { DOMAIN_ENTITIES } from "./domain-entities";
import { AMOUNT_MATCH_LIMITS } from "./amount-matching";
import type { ExchangeRateCache } from "./formal-model";
import { formalRules, ruleSnapshot } from "./rule-registry";
import { WORKFLOW_DEFINITIONS } from "./workflows";
import { resolveWorkflow } from "./workflow";
import { WorkflowGraphCanvas, WorkflowGraphLegend } from "./WorkflowGraph";
import type { ExpenseLine, ReceiptRecord } from "./types";

const modelTabs = [
  ["rules", "规则"], ["entities", "实体"], ["workflows", "流程"], ["matching", "配对流程"], ["taxonomy", "分类体系"],
] as const;
type ModelTab = typeof modelTabs[number][0];

function MatchingFlow() {
  const { precisionMinorUnits, nearbyCnyCents, merchantDiscountPercent, merchantDiscountCnyCents, itemizedPercent } = AMOUNT_MATCH_LIMITS;
  const tiers = [
    ["精准", `先找同额，再允许差 ${precisionMinorUnits} 个最小货币单位。人民币 1 分、美元 1 美分、日元 1 日元。`],
    ["近额", `人民币差额不超过 ¥${nearbyCnyCents / 100}，可用费用类别消歧。`],
    ["有交易旁证", `同商户等线索支持时，人民币差额不超过 ${merchantDiscountPercent}%，且最多 ¥${merchantDiscountCnyCents / 100}。`],
    ["发票单列明细", `同币种、候选唯一时，按对应费用明细允许 ±${itemizedPercent}%。`],
  ];
  return <div className="matching-flow" role="tabpanel" id="model-panel-matching" aria-labelledby="model-tab-matching" tabIndex={0}>
    <div className="matching-flow-start">
      <strong>在同一票据集内找候选</strong>
      <p>金额优先比同币种原币。航空行程单先比航班号和出行日。</p>
    </div>
    <ArrowDown className="matching-flow-arrow" size={15} aria-hidden="true" />
    <div className="matching-flow-columns">
      <section aria-labelledby="matching-amount-title">
        <h3 id="matching-amount-title">按金额找候选</h3>
        <ol className="matching-tiers">
          {tiers.map(([label, detail], index) => <li key={label}>
            {index > 0 && <div className="matching-tier-edge"><ArrowDown size={12} aria-hidden="true" />{index === 3 ? "有可对应的费用明细" : "上一档无候选"}</div>}
            <div><strong>{label}</strong><p>{detail}</p></div>
          </li>)}
        </ol>
      </section>
      <ArrowRight className="matching-flow-next" size={18} aria-hidden="true" />
      <section aria-labelledby="matching-evidence-title">
        <h3 id="matching-evidence-title">用交易线索筛候选</h3>
        <dl className="matching-evidence">
          <div><dt>云服务</dt><dd>支付记录优先比付款年月，开票日期可辅助区分同额订阅。费用清单优先采用用户指定的材料，其次按项目名关联，同集多期可共用。</dd></div>
          <div><dt>网约车</dt><dd>比承运平台。两票两单同额时，可从已确认的一对推得剩下的一对。</dd></div>
          <div><dt>通用线索</dt><dd>先看商户。近额档仍有多个候选时，再看费用类别。</dd></div>
        </dl>
      </section>
    </div>
    <ArrowDown className="matching-flow-arrow" size={15} aria-hidden="true" />
    <div className="matching-flow-results">
      <div><span>只剩一个候选</span><strong>自动关联</strong></div>
      <div><span>无候选或仍有冲突</span><strong>保留材料，导入新证据时重算</strong></div>
    </div>
    <p className="matching-flow-note">航空行程单的航班号和出行日都吻合且候选唯一时，优先关联。只有路线信息时，方向唯一且没有航班或日期冲突也可以关联。</p>
    <p className="matching-flow-note">人民币扣款可经已关联的外币付款补配。系统核对商户、用途、日期和折算额。</p>
    <p className="matching-flow-note">改签优先比发票的含税改签费明细。路线按城市比较，可更换机场或出行日。缺少费用明细时，已明确识别为改签的付款可用合计金额复核。</p>
  </div>;
}

function downloadSnapshot() {
  const blob = new Blob([JSON.stringify(ruleSnapshot(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "guanzizai-rule-snapshot.json";
  link.click();
  URL.revokeObjectURL(url);
}

type RateUpdate = { currency: ExchangeRateCache["currency"]; cnyRate: number };

/** 定义态图谱：用空票据集解析流程定义，节点均为未触发/待补充的基线状态。 */
function definitionWorkflow(kind: ExpenseLine["kind"]) {
  const definition = WORKFLOW_DEFINITIONS[kind];
  const previewLine: ExpenseLine = { id: "rule-preview", title: `${kind}定义`, kind, createdAt: "", status: "active", folder: "", requirements: [] };
  return resolveWorkflow(definition, previewLine, [] as ReceiptRecord[], {});
}

export function RuleLibraryDialog({ onClose, exchangeRates = [], onUpdateExchangeRates, onRefreshExchangeRates }: {
  onClose: () => void;
  exchangeRates?: ExchangeRateCache[];
  onUpdateExchangeRates?: (rates: RateUpdate[]) => void;
  onRefreshExchangeRates?: () => Promise<number>;
}) {
  const [tab, setTab] = useState<ModelTab>("rules");
  const [graphKind, setGraphKind] = useState<ExpenseLine["kind"] | null>(null);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [updatingRates, setUpdatingRates] = useState(false);
  const [rateUpdateError, setRateUpdateError] = useState("");
  const rules = formalRules();
  const saveManualRates = () => {
    const rates = Object.entries(rateDrafts).map(([currency, value]) => ({ currency: currency as RateUpdate["currency"], cnyRate: Number(value) })).filter((item) => Number.isFinite(item.cnyRate) && item.cnyRate > 0);
    if (!rates.length) return;
    onUpdateExchangeRates?.(rates);
    setRateDrafts({});
  };
  const refreshRates = async () => {
    setUpdatingRates(true);
    setRateUpdateError("");
    try {
      await onRefreshExchangeRates?.();
    } catch (error) {
      setRateUpdateError(error instanceof Error ? error.message : "在线汇率更新失败");
    } finally {
      setUpdatingRates(false);
    }
  };
  return <div className="dialog-backdrop rule-library-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="rule-library-dialog" role="dialog" aria-modal="true" aria-labelledby="rule-library-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>SYSTEM MODEL</span><h2 id="rule-library-title">规则库</h2></div><div><button type="button" className="icon-button" title="导出规则快照" onClick={downloadSnapshot}><Download size={17} /></button><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></div></header>
      <div className="model-tabs model-tabs--five" role="tablist" aria-label="系统模型分类" onKeyDown={(event) => {
        const index = modelTabs.findIndex(([id]) => id === tab);
        const count = modelTabs.length;
        const next = event.key === "ArrowRight" ? (index + 1) % count
          : event.key === "ArrowLeft" ? (index + count - 1) % count
          : event.key === "Home" ? 0
          : event.key === "End" ? count - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault();
        setTab(modelTabs[next][0]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {modelTabs.map(([id, label]) => <button type="button" role="tab" key={id} id={`model-tab-${id}`}
          aria-controls={id === "matching" && tab === id ? "model-panel-matching" : undefined}
          aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} className={tab === id ? "selected" : ""}
          onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "matching" && <MatchingFlow />}
      {tab === "rules" && <><p className="rule-library-intro">每张规则卡只表达一条约束：说明适用范围、触发条件和系统结果。流程节点与连线请在“流程”中查看。</p><div className="rule-library-list">
        {rules.map((rule, index) => <article className="rule-item" key={rule.id}>
          <header><span>规则 {String(index + 1).padStart(2, "0")}</span><i>{rule.category}</i><small>{rule.workflow}</small></header>
          <strong>{rule.statement}</strong>
          <code>{rule.expression}</code>
        </article>)}
      </div></>}
      {tab === "entities" && <><p className="rule-library-intro">实体是系统记录和规则求值的对象；费用分类与证据类型属于 taxonomy，不替代实体定义。</p><div className="entity-catalog">
        {DOMAIN_ENTITIES.map((entity) => <article key={entity.id}><header><div><span>{entity.formalName}</span><strong>{entity.label}</strong></div><code>{entity.id}</code></header><p>{entity.definition}</p><section><h3>关键属性</h3>{entity.attributes.map((attribute) => <div key={attribute.name}><code>{attribute.name}</code><span>{attribute.meaning}</span></div>)}</section><section><h3>关系</h3>{entity.relations.map((relation) => <p key={relation}>{relation}</p>)}</section></article>)}
      </div></>}
      {tab === "workflows" && <>
        {graphKind ? <div className="rule-library-graph">
          <header><button type="button" className="quiet-button" onClick={() => setGraphKind(null)}><ArrowLeft size={14} /> 返回流程目录</button><strong>{graphKind} · 约束图谱</strong><span>定义态视图：不绑定具体票据集，展示节点、连线与条件触发关系</span></header>
          <WorkflowGraphLegend />
          <WorkflowGraphCanvas workflow={definitionWorkflow(graphKind)} className="workflow-canvas rule-library-graph-canvas" />
        </div> : <>
        <p className="rule-library-intro">流程定义票据集类型、材料节点和依赖边；具体项目的完成状态由同一图谱计算。操作指引见各票据集的“流程关系”。</p><div className="model-catalog workflow-catalog">
          {Object.values(WORKFLOW_DEFINITIONS).map((workflow) => <article key={workflow.id}><div className="rule-library-meta"><span>{workflow.id}@v{workflow.version}</span><i>{workflow.kind}</i></div><strong>{workflow.kind}流程</strong><p>{workflow.collections.map((collection) => collection.label).join(" · ")}</p><code>{workflow.nodes.length} NODES · {workflow.edges.length} EDGES</code><button type="button" className="quiet-button" onClick={() => setGraphKind(workflow.kind)}><GitBranch size={13} /> 查看图谱</button></article>)}
        </div></>}
      </>}
      {tab === "taxonomy" && <><p className="rule-library-intro">分类体系定义费用事项、证据类型和换算口径。文件先成为 Evidence，再关联到 Expense 并匹配 workflow；规则标签让新费用类型继承通用规则。</p><div className="taxonomy-content"><section><header><span>EXPENSE TAXONOMY</span><strong>费用事项</strong></header><div className="taxonomy-list">{EXPENSE_TAXONOMY.map((item) => <article key={item.id}><div className="rule-library-meta"><span>{item.id}</span><i>{item.scope}</i><small>{item.category}</small></div><strong>{item.label}</strong><p>{item.evidence}</p>{item.ruleTags?.length ? <p className="taxonomy-rule-tags">规则标签：{item.ruleTags.join(" · ")}</p> : null}</article>)}</div><header className="evidence-taxonomy-heading"><span>EVIDENCE TAXONOMY</span><strong>证据类型</strong></header><div className="taxonomy-list">{EVIDENCE_TAXONOMY.map((item) => <article key={item.id}><div className="rule-library-meta"><span>{item.id}</span></div><strong>{item.label}</strong><p>{item.description}</p></article>)}</div></section><section className="exchange-taxonomy"><header><span>EXCHANGE TAXONOMY</span><strong>汇率口径</strong></header>{EXCHANGE_RATE_TAXONOMY.map((rate) => { const cached = exchangeRates.find((item) => item.currency === rate.currency); const value = rateDrafts[rate.currency] ?? (cached?.cnyRate ?? rate.cnyRate)?.toString() ?? ""; const source = cached?.source === "online" ? "在线缓存" : cached?.source === "manual" ? "手动缓存" : cached ? "参考缓存" : rate.note; const date = cached?.effectiveDate ?? cached?.updatedAt; return <article key={rate.currency}><strong>{rate.currency}</strong><span>{value ? `1 ${rate.currency} = CNY ${Number(value).toFixed(4)}` : "待人工确认"}</span><small>{cached ? `${date} · ${source}` : rate.note}</small>{rate.currency !== "CNY" && <label className="rate-editor"><input type="number" min="0.0001" step="0.0001" value={value} onChange={(event) => { setRateUpdateError(""); setRateDrafts((current) => ({ ...current, [rate.currency]: event.target.value })); }} aria-label={`${rate.currency} 兑 CNY 汇率`} /></label>}</article>; })}{rateUpdateError && <p className="rate-update-error">{rateUpdateError}</p>}<button type="button" className="update-rates-button" disabled={updatingRates} onClick={() => { if (Object.keys(rateDrafts).length) saveManualRates(); else void refreshRates(); }}>{updatingRates ? "正在在线更新…" : Object.keys(rateDrafts).length ? "保存手动汇率" : "在线更新汇率"}</button></section></div></>}
    </section>
  </div>;
}
