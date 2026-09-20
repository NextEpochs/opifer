import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps, type NodeTypes, type XYPosition } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type AgentView } from "../api";
import { fill } from "../i18n";
import { ActivityChip, Avatar, money } from "../ui";
import type { Workspace } from "../App";

export interface RoleTemplate {
  key: string;
  name: string;
  blurb: string;
  role: string;
}

export interface HireRequest {
  role: string;
  reportsToAgentId: string | null;
}

type AgentNodeData = { agent: AgentView | null; ws: Workspace; selected: boolean; label: string };

const NODE_W = 236;
const NODE_H = 96;
const GAP_X = 28;
const GAP_Y = 90;

/** Tree layout: subtrees side by side, each parent centred over its children. */
function layout(agents: AgentView[]): Map<string, XYPosition> {
  const children = new Map<string | null, AgentView[]>();
  for (const a of agents) {
    const key = a.reportsToAgentId && agents.some((x) => x.id === a.reportsToAgentId) ? a.reportsToAgentId : null;
    children.set(key, [...(children.get(key) ?? []), a]);
  }
  const width = (id: string | null): number => {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return NODE_W;
    return kids.reduce((n, k) => n + width(k.id), 0) + GAP_X * (kids.length - 1);
  };
  const positions = new Map<string, XYPosition>();
  const place = (id: string | null, left: number, depth: number) => {
    const kids = children.get(id) ?? [];
    let x = left;
    for (const k of kids) {
      const w = width(k.id);
      positions.set(k.id, { x: x + w / 2 - NODE_W / 2, y: depth * (NODE_H + GAP_Y) });
      place(k.id, x, depth + 1);
      x += w + GAP_X;
    }
  };
  const total = width(null);
  positions.set("you", { x: total / 2 - NODE_W / 2, y: 0 });
  place(null, 0, 1);
  return positions;
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { agent, ws, selected, label } = data;
  const { t } = ws;
  const handles = (
    <>
      <Handle type="target" position={Position.Top} className="!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} className="!h-0 !w-0 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
    </>
  );
  if (!agent) {
    return (
      <div className="flex items-center gap-3 rounded-[16px] border border-line bg-card px-4 py-3 shadow-card" style={{ width: NODE_W, height: NODE_H }}>
        {handles}
        <Avatar name={label} size={36} colour="#06B6D4" />
        <div>
          <div className="font-bold">{label}</div>
          <div className="text-[12px] text-mute">{t.owner}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`flex cursor-grab flex-col gap-2 rounded-[16px] border bg-card px-3.5 py-3 shadow-card transition active:cursor-grabbing ${selected ? "border-accent" : "border-line hover:border-accent"}`} style={{ width: NODE_W, height: NODE_H }}>
      {handles}
      <div className="flex items-center gap-2.5">
        <Avatar name={agent.name} size={34} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{agent.name}</div>
          <div className="truncate text-[12px] text-mute">{agent.role.split(/[.\n]/)[0] || "—"}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ActivityChip activity={agent.activity} t={t} />
        <span className="ml-auto text-[12px] text-mute">{money(agent.spend.eur, agent.spend.currency)}</span>
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { agent: AgentNode };

function Chart({ ws, selectedId, templates, onHire }: { ws: Workspace; selectedId: string | null; templates: RoleTemplate[]; onHire: (r: HireRequest) => void }) {
  const { t, overview } = ws;
  const agents = useMemo(() => (overview?.agents ?? []).filter((a) => a.status !== "archived"), [overview]);
  const flow = useReactFlow();
  const [notice, setNotice] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const positions = layout(agents);
    const nodes: Node<AgentNodeData>[] = [
      { id: "you", type: "agent", position: positions.get("you")!, data: { agent: null, ws, selected: false, label: t.you }, draggable: false },
      ...agents.map((a) => ({ id: a.id, type: "agent" as const, position: positions.get(a.id)!, data: { agent: a, ws, selected: a.id === selectedId, label: a.name } })),
    ];
    const edges: Edge[] = agents.map((a) => ({ id: `e-${a.id}`, source: a.reportsToAgentId && agents.some((x) => x.id === a.reportsToAgentId) ? a.reportsToAgentId : "you", target: a.id, type: "smoothstep", style: { stroke: "var(--o-line-strong)", strokeWidth: 2 } }));
    return { nodes, edges };
  }, [agents, selectedId, ws, t.you]);

  useEffect(() => {
    const timer = setTimeout(() => void flow.fitView({ padding: 0.2, duration: 300 }), 50);
    return () => clearTimeout(timer);
  }, [agents.length, flow]);

  const say = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 3500);
  };

  /** The node under a flow-space point, other than the given ids. */
  const nodeAt = useCallback(
    (point: XYPosition, except: string[]) => {
      return flow.getNodes().find((n) => !except.includes(n.id) && point.x >= n.position.x && point.x <= n.position.x + NODE_W && point.y >= n.position.y && point.y <= n.position.y + NODE_H) ?? null;
    },
    [flow],
  );

  const onNodeDragStop = async (event: MouseEvent | TouchEvent, node: Node) => {
    if (node.id === "you") return;
    const touch = "touches" in event ? (event.changedTouches[0] ?? null) : null;
    const clientX = touch ? touch.clientX : (event as MouseEvent).clientX;
    const clientY = touch ? touch.clientY : (event as MouseEvent).clientY;
    const point = flow.screenToFlowPosition({ x: clientX, y: clientY });
    const target = nodeAt(point, [node.id]);
    const agent = agents.find((a) => a.id === node.id);
    if (!target || !agent) {
      // Snap back into the tree.
      flow.setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, position: layout(agents).get(node.id)! } : n)));
      return;
    }
    const managerId = target.id === "you" ? null : target.id;
    if (managerId === agent.reportsToAgentId) {
      flow.setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, position: layout(agents).get(node.id)! } : n)));
      return;
    }
    try {
      await api.updateAgent(agent.id, { reportsToAgentId: managerId, note: "moved on the org chart" });
      await ws.refresh();
      say(fill(t.reportsToChanged, { agent: agent.name, manager: managerId ? ws.agentName(managerId) : t.you }));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
      flow.setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, position: layout(agents).get(node.id)! } : n)));
    }
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData("application/opifer-role");
    const template = templates.find((r) => r.key === key);
    if (!template) return;
    const point = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const target = nodeAt(point, []);
    onHire({ role: template.role, reportsToAgentId: target && target.id !== "you" ? target.id : null });
  };

  return (
    <div className="relative h-full min-h-[560px]" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => node.id !== "you" && ws.go("team", node.id)}
        onNodeDragStop={(e, node) => void onNodeDragStop(e, node)}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
        fitView
        style={{ background: "transparent" }}
      >
        <Background gap={22} size={1} color="var(--o-line)" />
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>
      {notice && <p className="absolute bottom-3 left-1/2 m-0 -translate-x-1/2 rounded-control border border-line bg-card px-3 py-2 text-[13px] shadow-card">{notice}</p>}
    </div>
  );
}

/** The org chart with a palette of roles to drag in. */
export function OrgChart({ ws, selectedId, onHire }: { ws: Workspace; selectedId: string | null; onHire: (r: HireRequest) => void }) {
  const { t } = ws;
  const templates: RoleTemplate[] = (["researcher", "developer", "writer", "support", "blank"] as const).map((key) => ({ key, ...t.roles[key] }));
  return (
    <div className="flex h-full min-h-[560px]">
      <aside className="flex w-[210px] shrink-0 flex-col gap-2.5 border-r border-line bg-panel px-4 py-5">
        <h2 className="m-0 text-[15px] font-bold">{t.hireAgent}</h2>
        <p className="m-0 mb-1 text-[12px] text-mute">{t.dragRoleHint}</p>
        {templates.map((r) => (
          <div
            key={r.key}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/opifer-role", r.key);
              e.dataTransfer.effectAllowed = "move";
            }}
            role="button"
            tabIndex={0}
            onClick={() => onHire({ role: r.role, reportsToAgentId: null })}
            onKeyDown={(e) => e.key === "Enter" && onHire({ role: r.role, reportsToAgentId: null })}
            className="flex cursor-grab items-center gap-2.5 rounded-[14px] border border-line bg-card p-2.5 shadow-card hover:border-accent active:cursor-grabbing"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-[13px] font-extrabold text-accent-text">{r.name.charAt(0)}</span>
            <div className="min-w-0">
              <div className="text-[13px] font-bold">{r.name}</div>
              <div className="truncate text-[11px] text-mute">{r.blurb}</div>
            </div>
          </div>
        ))}
      </aside>
      <div className="min-w-0 flex-1">
        <ReactFlowProvider>
          <Chart ws={ws} selectedId={selectedId} templates={templates} onHire={onHire} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
