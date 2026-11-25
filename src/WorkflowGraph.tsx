import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { FileCheck2, FileClock, FolderArchive, Landmark, Link2, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ResolvedWorkflow, ResolvedWorkflowNode, WorkflowRelation } from "./types";

type GraphNodeData = { workflowNode: ResolvedWorkflowNode };
type CollectionNodeData = { label: string; scope: ResolvedWorkflowNode["scope"]; summary: string };

const relationLabel: Record<WorkflowRelation, string> = {
  input: "前置输入",
  produces: "产出",
  "paired-with": "成对",
  activates: "触发",
  "archives-with": "归档",
};

const nodeIcon = (node: ResolvedWorkflowNode) => {
  if (node.kind === "external-action") return <Landmark size={14} />;
  if (node.kind === "submission") return <Send size={14} />;
  if (node.scope === "archive") return <FolderArchive size={14} />;
  return node.status === "complete" || node.status === "manually-confirmed" ? <FileCheck2 size={14} /> : <FileClock size={14} />;
};

function WorkflowGraphNode({ data }: NodeProps<Node<GraphNodeData>>) {
  const node = data.workflowNode;
  const scope = node.scope === "finance" ? "报销" : node.scope === "process" ? "流程" : "附件";
  const status = node.status === "complete" ? "已完成" : node.status === "manually-confirmed" ? "已提供" : node.status === "ready" ? "可办理" : node.status === "blocked" ? "受阻" : node.status === "missing" ? "待补充" : "未触发";
  return <div className={`workflow-node workflow-node--${node.status} workflow-node--${node.scope}`}>
    <Handle type="target" position={Position.Left} />
    <div className="workflow-node-top"><span>{nodeIcon(node)}</span><i>{scope}</i></div>
    <strong>{node.label}</strong>
    <small>{status}</small>
    <Handle type="source" position={Position.Right} />
  </div>;
}

function WorkflowCollectionNode({ data }: NodeProps<Node<CollectionNodeData>>) {
  const scope = data.scope === "finance" ? "报销材料" : data.scope === "process" ? "流程" : "项目附件";
  return <div className={`workflow-collection workflow-collection--${data.scope}`}>
    <header><span>{scope}</span><strong>{data.label}</strong><b>{data.summary}</b></header>
  </div>;
}

export function layout(workflow: ResolvedWorkflow) {
  // 日常的三类费用彼此没有先后依赖，固定纵向并列，避免被误读为串行步骤。
  const dailyLayout = workflow.definition.kind === "日常";
  // 会议材料组较多；四列会迫使画布缩放，令节点和连线标签无法阅读。
  const meetingLayout = workflow.definition.kind === "国内会议" || workflow.definition.kind === "国际会议";
  const columns = dailyLayout ? 1 : meetingLayout ? 3 : 4;
  const collectionWidth = dailyLayout ? 430 : meetingLayout ? 350 : 316;
  // 跨框正交连线没有避障路由；加宽框间走廊让边从框之间穿过，而不是压在节点上。
  const collectionGap = 56;
  const headerHeight = 43;
  const childHeight = 67;
  const childGap = 9;
  const rows = workflow.definition.collections.map((collection) => {
    const count = collection.nodeIds.filter((id) => Boolean(workflow.nodes[id])).length;
    return { collection, count, height: headerHeight + Math.ceil(count / 2) * (childHeight + childGap) + 12 };
  });
  const rowHeights = new Map<number, number>();
  rows.forEach((item, index) => rowHeights.set(Math.floor(index / columns), Math.max(rowHeights.get(Math.floor(index / columns)) ?? 0, item.height)));
  const rowY = new Map<number, number>();
  let nextY = 22;
  [...rowHeights.entries()].sort(([first], [second]) => first - second).forEach(([row, height]) => { rowY.set(row, nextY); nextY += height + collectionGap; });
  const parents: Node<CollectionNodeData>[] = [];
  const nodes: Node<GraphNodeData>[] = [];
  rows.forEach(({ collection, count, height }, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const collectionNodes = collection.nodeIds.map((id) => workflow.nodes[id]).filter((node): node is ResolvedWorkflowNode => Boolean(node));
    const relevant = collection.scope === "finance"
      ? collectionNodes.filter((node) => node.requiredForSubmission)
      : collection.scope === "process"
        ? collectionNodes.filter((node) => node.kind === "external-action")
        : collectionNodes;
    const complete = relevant.filter((node) => node.status === "complete" || node.status === "manually-confirmed").length;
    const summary = collection.scope === "finance" && relevant.length === 0
      ? "按实际"
      : collection.scope === "archive"
        ? `附件 ${complete}/${relevant.length}`
        : `${complete}/${relevant.length}`;
    const parentId = `collection:${collection.id}`;
    parents.push({
      id: parentId,
      type: "collection",
      position: { x: 22 + col * (collectionWidth + collectionGap), y: rowY.get(row) ?? 22 },
      data: { label: collection.label, scope: collection.scope, summary },
      draggable: false,
      selectable: false,
      style: { width: collectionWidth, height },
    });
  });
  // 框内成对边按“源在左列、目标在右列、同对同行”排序，把长跨行交叉压成短横线。
  const pairTarget = new Map<string, string[]>();
  for (const edge of workflow.definition.edges) {
    if (edge.relation !== "paired-with") continue;
    if (!pairTarget.has(edge.source)) pairTarget.set(edge.source, []);
    pairTarget.get(edge.source)!.push(edge.target);
  }
  const orderedChildren = new Map<string, (ResolvedWorkflowNode | null)[]>();
  for (const { collection } of rows) {
    const children = collection.nodeIds.map((id) => workflow.nodes[id]).filter((node): node is ResolvedWorkflowNode => Boolean(node));
    const seen = new Set<string>();
    // 每条配对链独立占偶数格：一源双目标（如账单→支付、账单→费用清单）占 3 格会传染后续链的行列，
    // 奇数链末尾补 null 占位（位置照算、不渲染节点），保证下一链的源始终落回左列。
    const ordered: Array<ResolvedWorkflowNode | null> = [];
    const emitPair = (node: ResolvedWorkflowNode) => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      ordered.push(node);
      for (const targetId of pairTarget.get(node.id) ?? []) {
        const target = workflow.nodes[targetId];
        if (target && !seen.has(target.id)) { seen.add(target.id); ordered.push(target); }
      }
      if (ordered.length % 2) ordered.push(null);
    };
    // 先排有配对关系的链（源左列、目标右列、同对同行），孤立节点垫后，不切断配对行。
    children.filter((node) => pairTarget.has(node.id)).forEach(emitPair);
    children.forEach((node) => {
      if (!seen.has(node.id)) { seen.add(node.id); ordered.push(node); }
    });
    orderedChildren.set(collection.id, ordered);
  }
  for (const { collection } of rows) {
    const parentId = `collection:${collection.id}`;
    orderedChildren.get(collection.id)?.forEach((workflowNode, childIndex) => {
      if (!workflowNode) return;
      nodes.push({
        id: workflowNode.id,
        type: "workflow",
        parentId,
        extent: "parent",
        position: { x: 12 + (childIndex % 2) * (dailyLayout ? 206 : meetingLayout ? 166 : 148), y: headerHeight + Math.floor(childIndex / 2) * (childHeight + childGap) },
        data: { workflowNode },
        draggable: false,
      });
    });
  }
  const compactRelations = meetingLayout;
  const edges: Edge[] = workflow.definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    // 会议图中关系密集，颜色图例比在线上反复写“成对/触发”更易读。
    label: compactRelations ? undefined : relationLabel[edge.relation],
    type: "smoothstep",
    // 出弯更远，正交边先走出节点区再拐弯，减少压过相邻节点。
    pathOptions: { offset: 26, borderRadius: 14 },
    animated: edge.relation === "activates" && workflow.nodes[edge.target]?.active,
    className: `workflow-edge workflow-edge--${edge.relation}`,
    labelStyle: { fontSize: 10, fill: "#716f79", fontFamily: "DM Mono" },
    labelBgPadding: [4, 2],
    labelBgStyle: { fill: "#f7f4ef", fillOpacity: 0.96 },
  }));
  return { nodes: [...parents, ...nodes], edges };
}

function details(node: ResolvedWorkflowNode, workflow: ResolvedWorkflow) {
  if (node.status === "blocked" && node.blockers.length) return `等待：${node.blockers.map((id) => workflow.nodes[id]?.label ?? id).join("、")}`;
  if (node.status === "ready") return "前置材料已齐，可在对应系统继续办理。";
  if (node.status === "missing") return "此材料已纳入本次报销，尚未找到正式文件。";
  if (node.status === "inactive") return node.scope === "archive" ? "项目附件，尚未归档。" : "按实际发生；识别到相关材料后自动启用。";
  if (node.status === "manually-confirmed") return "已人工确认提供，当前目录没有对应本机文件。";
  return node.file ? `已对齐：${node.file.name}` : "状态已完成。";
}

/** 可内嵌的图谱画布：全屏弹窗与规则库“流程”分区共用同一渲染。 */
export function WorkflowGraphCanvas({ workflow, className }: { workflow: ResolvedWorkflow; className?: string }) {
  const { nodes, edges } = useMemo(() => layout(workflow), [workflow]);
  return <div className={className ?? "workflow-canvas"}>
    <ReactFlowProvider>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ workflow: WorkflowGraphNode, collection: WorkflowCollectionNode }} fitView fitViewOptions={{ padding: 0.07 }} minZoom={0.45} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
        <Background color="#ddd8d0" gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  </div>;
}

export function WorkflowGraphLegend() {
  return <div className="workflow-legend"><span><i className="is-finance" />报销材料</span><span><i className="is-process" />外部流程</span><span><i className="is-archive" />项目附件</span><span><b className="edge-key edge-key--pair" />成对闭环</span><span><b className="edge-key edge-key--activate" />条件触发</span><span><b className="edge-key edge-key--input" />前置或产出</span><span><Link2 size={12} />连线表示关系，不等于全部阻塞递交</span></div>;
}

export function WorkflowGraphDialog({ title, workflow, onClose }: { title: string; workflow: ResolvedWorkflow; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => layout(workflow), [workflow]);
  const selected = selectedId ? workflow.nodes[selectedId] : undefined;
  return <div className="dialog-backdrop workflow-graph-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="workflow-graph-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-graph-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>RELATION GRAPH</span><h2 id="workflow-graph-title">{title} · 流程关系</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button></header>
      <WorkflowGraphLegend />
      <div className="workflow-canvas">
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ workflow: WorkflowGraphNode, collection: WorkflowCollectionNode }} fitView fitViewOptions={{ padding: 0.07 }} minZoom={0.45} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => { if (!node.id.startsWith("collection:")) setSelectedId(node.id); }} proOptions={{ hideAttribution: true }}>
            <Background color="#ddd8d0" gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <aside className="workflow-inspector">
        {selected ? <><div><span>{selected.scope === "finance" ? "报销节点" : selected.scope === "process" ? "流程节点" : "项目附件"}</span><strong>{selected.label}</strong></div><p>{details(selected, workflow)}</p></> : <p>选择一个节点，查看它的状态与关系。</p>}
      </aside>
    </section>
  </div>;
}
