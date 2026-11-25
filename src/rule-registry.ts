import { EVIDENCE_TAXONOMY, EXCHANGE_RATE_TAXONOMY, EXPENSE_TAXONOMY } from "./expense-taxonomy";
import { RULE_DEFINITIONS } from "./rule-definitions";
import { WORKFLOW_DEFINITIONS } from "./workflows";
import type { WorkflowCondition, WorkflowRelation } from "./types";

export type FormalRule = {
  id: string;
  workflow: string;
  category: "金额政策" | "材料闭环" | "流程提示" | "前置流程" | "成对闭环" | "条件触发" | "归档关联";
  statement: string;
  expression: string;
  source: string;
};

const relationCategory: Record<WorkflowRelation, FormalRule["category"]> = {
  input: "前置流程",
  produces: "前置流程",
  "paired-with": "成对闭环",
  activates: "条件触发",
  "archives-with": "归档关联",
};

function conditionText(condition?: WorkflowCondition) {
  if (!condition || condition.kind === "always") return "始终";
  if (condition.kind === "source-complete") return `${condition.mode === "all" ? "全部" : "任一"}来源材料已完成`;
  return `金额折合 > CNY ${condition.thresholdCny.toLocaleString("zh-CN")}`;
}

function relationText(relation: WorkflowRelation) {
  return ({ input: "是办理前置输入", produces: "产出", "paired-with": "必须成对提供", activates: "满足条件后启用", "archives-with": "随项目归档关联" } as const)[relation];
}

export function formalRules(): FormalRule[] {
  const rules: FormalRule[] = [
    ...RULE_DEFINITIONS.map((rule) => ({ id: rule.id, workflow: "全部票据集", category: rule.category, statement: rule.statement, expression: rule.expression, source: rule.source })),
  ];
  for (const definition of Object.values(WORKFLOW_DEFINITIONS)) {
    const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
    for (const edge of definition.edges) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) continue;
      // 金额触发关系已汇总到统一金额政策，避免同一规则在每种费用事项下重复显示。
      if (edge.relation === "activates" && edge.condition?.kind === "source-at-least-threshold") continue;
      // 已由全局规则定义的流程连线，仅用于可视化，不在规则库重复生成。
      if (edge.ruleId) continue;
      const condition = conditionText(edge.condition);
      rules.push({
        id: `${definition.id}:${edge.id}`,
        workflow: definition.kind,
        category: relationCategory[edge.relation],
        statement: `${source.label}${relationText(edge.relation)}${target.label}${edge.relation === "activates" ? `（${condition}）` : ""}。`,
        expression: `${edge.relation.toUpperCase()}(${source.id}, ${target.id})${edge.condition ? ` WHEN ${condition}` : ""}`,
        source: `${definition.id}@v${definition.version}`,
      });
    }
  }
  return rules;
}

export function ruleSnapshot() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    taxonomy: { expenses: EXPENSE_TAXONOMY, evidence: EVIDENCE_TAXONOMY, exchangeRates: EXCHANGE_RATE_TAXONOMY },
    policies: RULE_DEFINITIONS,
    workflows: Object.values(WORKFLOW_DEFINITIONS),
    rules: formalRules(),
  };
}
