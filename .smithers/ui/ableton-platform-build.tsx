/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayActions, useGatewayNodeOutput, useGatewayRunEvents, useGatewayRuns } from "smithers-orchestrator/gateway-react";
import { ApprovalPanel, ConnectionBadge, LaunchButton, NodeOutputView, RunEventLog, RunList, RunTree, StatusPill, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, KpiStat, SectionHeader, SmithersUiStyles } from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "ableton-platform-build";
const OUTPUT_NODES = [
  "preflight-inspect", "research-synthesis", "capability-matrix", "architecture-design", "test-strategy", "live-safety-plan",
  "implementation-plan", "implementation-review", "documentation-review", "validation-analysis", "checkpoint-state", "pr-poll",
  "pr-classify", "audit-moderation", "final-review", "iteration-disposition", "readiness-candidate", "final-report",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  try { return JSON.parse(text); } catch { return value; }
}
function normalizeRow(value: unknown): Record<string, unknown> {
  let row: Record<string, unknown> = isRecord(value) ? value : {};
  for (let i = 0; i < 4; i += 1) {
    if (isRecord(row.row)) row = row.row;
    else if (isRecord(row.data)) row = row.data;
    else break;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    const parsed = parseJson(item);
    normalized[key] = parsed;
    const camel = key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
    if (camel !== key) normalized[camel] = parsed;
  }
  return normalized;
}
function textOf(value: unknown, fallback = "") { return typeof value === "string" ? value : value == null ? fallback : String(value); }
function boolOf(value: unknown) { return value === true || value === 1 || value === "true"; }
function runIdFromUrl() { return typeof location === "undefined" ? undefined : new URLSearchParams(location.search).get("runId") ?? undefined; }
function runRows(value: unknown) {
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.runs) ? value.runs : [];
  return rows.filter(isRecord).map((row) => ({ runId: textOf(row.runId ?? row.id), status: textOf(row.status, "unknown") })).filter((row) => row.runId);
}

function OutputPanel({ runId, nodeId, onSelect }: { runId: string; nodeId: string; onSelect: (id: string) => void }) {
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
  const row = useMemo(() => normalizeRow(output.data), [output.data]);
  const summary = textOf(row.summary, "No durable output has been recorded yet.");
  return <Card><CardHeader><CardTitle>{nodeId}</CardTitle></CardHeader><CardContent><p>{summary}</p><NodeOutputView runId={runId} nodeId={nodeId} iteration={0} /><div>{OUTPUT_NODES.slice(0, 8).map((id) => <Button key={id} onClick={() => onSelect(id)}>{id}</Button>)}</div></CardContent></Card>;
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedNode, setSelectedNode] = useState("final-report");
  const runs = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 30 } });
  const rows = runRows(runs.data);
  const activeRunId = selectedRunId ?? rows[0]?.runId;
  const events = useGatewayRunEvents(activeRunId, { afterSeq: 0, maxEvents: 500 });
  const actions = useGatewayActions();
  const selectedOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: selectedNode, iteration: 0 });
  const selectedRow = normalizeRow(selectedOutput.data);
  const status = rows.find((row) => row.runId === activeRunId)?.status ?? "unknown";
  const coverage = isRecord(selectedRow.coverage) ? selectedRow.coverage : {};
  const pr = isRecord(selectedRow.pr) ? selectedRow.pr : {};
  const kpis = [
    ["Iteration", textOf(selectedRow.iteration, "—")],
    ["Passed", boolOf(selectedRow.passed) ? "yes" : "pending"],
    ["PR head", textOf(pr.headSha ?? selectedRow.headSha, "—")],
    ["Tests", boolOf(selectedRow.allRequiredPassed ?? selectedRow.passed) ? "passing" : "pending"],
    ["Coverage", boolOf(coverage.measured) ? "measured" : "pending"],
    ["Events", String(events.events?.length ?? 0)],
  ];
  return <><SmithersUiStyles withTheme /><WorkflowUiShell title="Ableton Platform Build" meta={<ConnectionBadge />} actions={<LaunchButton workflow={WORKFLOW_KEY} input={{ liveTest: false, iterationBudget: 8 }} onLaunched={setSelectedRunId}>Launch manual run</LaunchButton>}>
    <SectionHeader eyebrow="Manual-only durable orchestration" title="Research, delivery evidence, and readiness" />
    <Card><CardHeader><CardTitle>Runs</CardTitle></CardHeader><CardContent><RunList filter={{ workflow: WORKFLOW_KEY, limit: 30 }} activeRunId={activeRunId} onSelect={setSelectedRunId} /></CardContent></Card>
    {!activeRunId ? <EmptyState title="No run selected" description="Launch a manual run or select an existing durable run." /> : <>
      <Card><CardHeader><CardTitle>Phase tree and runtime events</CardTitle></CardHeader><CardContent><RunTree runId={activeRunId} activeNodeId={selectedNode} onSelectNode={(node) => setSelectedNode(node.id)} /><RunEventLog runId={activeRunId} selectedNodeId={selectedNode} onSelectNode={setSelectedNode} /></CardContent></Card>
      <Card><CardHeader><CardTitle>Readiness KPIs</CardTitle></CardHeader><CardContent><div>{kpis.map(([label, value]) => <KpiStat key={label} label={label} value={value} />)}</div><StatusPill status={status} label={status} /></CardContent></Card>
      <OutputPanel runId={activeRunId} nodeId={selectedNode} onSelect={setSelectedNode} />
      <Card><CardHeader><CardTitle>Approvals and safe cancellation</CardTitle></CardHeader><CardContent><ApprovalPanel filter={{ runId: activeRunId }} /><Button onClick={() => void actions.cancelRun({ runId: activeRunId })}>Cancel selected run</Button></CardContent></Card>
      <Card><CardHeader><CardTitle>Evidence outputs</CardTitle></CardHeader><CardContent><div>{OUTPUT_NODES.map((id) => <Button key={id} onClick={() => setSelectedNode(id)}>{id}</Button>)}</div></CardContent></Card>
    </>}
  </WorkflowUiShell></>;
}

createGatewayReactRoot(<App />);
