import { resolve } from "node:path";
import { latestReport, publishStatus } from "./swarm-run.ts";
import type { ReportEvent } from "./swarm-run.ts";

export interface ReportHeader {
  kind: "DONE" | "QUESTION" | "HANDOFF";
  worker: string;
  id?: string;
  verdict?: "pass" | "fail";
}

export function parseReportHeader(text: string): ReportHeader | undefined {
  const match = /^(DONE|QUESTION|HANDOFF) (\S+)(?: \[r:([^\s\]]+)(?: verdict:(pass|fail))?\])?:/.exec(text);
  if (!match) return undefined;
  const header: ReportHeader = { kind: match[1] as ReportHeader["kind"], worker: match[2] };
  if (match[3]) header.id = match[3];
  if (match[4]) header.verdict = match[4] as ReportHeader["verdict"];
  return header;
}

export function reportIdsIn(output: string): string[] {
  const ids: string[] = [];
  let headerNext = false; // Pane text and artifact bodies are not report headers.
  let worker: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const block = /^=== (\S+): (?:done|idle|blocked)$/.exec(line);
    if (block) { worker = block[1]; headerNext = true; continue; }
    if (!headerNext) continue;
    if (worker && line === "(blocked: it is showing a question/approval UI — read it and tell the user)") continue;
    headerNext = false;
    const header = parseReportHeader(line);
    if (header?.id && (!worker || header.worker === worker)) ids.push(header.id);
  }
  return ids;
}

export function formatReport(ev: { kind: string; worker: string; id?: string; verdict?: string | null }, message: string): string {
  const metadata = [ev.id ? `r:${ev.id}` : "", ev.verdict ? `verdict:${ev.verdict}` : ""].filter(Boolean);
  return `${ev.kind} ${ev.worker}${metadata.length ? ` [${metadata.join(" ")}]` : ""}: ${message}`;
}

export function artifactPath(runDir: string, ref: string): string {
  const id = ref.startsWith("r:") ? ref.slice(2) : ref;
  if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid report id: ${ref}`);
  // Append the extension before resolving: even ids '.' and '..' remain filenames.
  return resolve(runDir, "artifacts", `${id}.md`);
}

function record(event: unknown): Record<string, unknown> | undefined {
  return typeof event === "object" && event !== null ? event as Record<string, unknown> : undefined;
}

function isReport(event: unknown): event is ReportEvent {
  const value = record(event);
  return value?.t === "report" && typeof value.id === "string" && typeof value.worker === "string"
    && typeof value.role === "string" && typeof value.kind === "string" && typeof value.ts === "number";
}

export function contextSection(events: readonly unknown[], ref: string, read: (path: string) => string, runDir: string, inlineMax = 6000): string {
  let report: ReportEvent | undefined;
  if (ref.startsWith("r:")) {
    artifactPath(runDir, ref); // Reject unsafe refs even when no matching event exists.
    report = events.filter(isReport).findLast(event => event.id === ref.slice(2));
  } else {
    report = latestReport(events, ref, -Infinity);
  }
  if (!report) throw new Error(`no report for ${ref}`);
  // Do not trust artifact paths in an append-only log to stay inside the run directory.
  const path = artifactPath(runDir, report.id);
  const text = read(path);
  const body = text.length > inlineMax ? `Full report (${text.length} chars): ${path} — read it with the read tool.` : text;
  return `## Context from ${report.worker} (r:${report.id})\n${body}`;
}

/** Queue order is the order of the first undelivered marker, not report timestamps. */
export function pendingUndelivered(events: readonly unknown[], delivered: Set<string>): ReportEvent[] {
  const reports = new Map<string, ReportEvent>();
  for (const event of events) if (isReport(event)) reports.set(event.id, event);
  const seen = new Set<string>();
  const pending: ReportEvent[] = [];
  for (const event of events) {
    const value = record(event);
    if (value?.t !== "undelivered" || typeof value.id !== "string" || delivered.has(value.id) || seen.has(value.id)) continue;
    seen.add(value.id);
    const report = reports.get(value.id);
    if (report) pending.push(report);
  }
  return pending;
}

export interface Epoch { n: number; ts: number; goal: string }
export interface SpawnEvent { t: "spawn"; ts: number; worker: string; type: string; step?: string; epoch: number }

export function replayRunState(events: readonly unknown[]): { delivered: Set<string>; epoch: Epoch; spawns: SpawnEvent[] } {
  const delivered = new Set<string>();
  let epoch: Epoch = { n: 0, ts: 0, goal: "" };
  const spawns: SpawnEvent[] = [];
  for (const event of events) {
    const value = record(event);
    if (!value) continue;
    if (value.t === "delivered" && typeof value.id === "string") delivered.add(value.id);
    if (value.t === "epoch" && typeof value.n === "number" && typeof value.ts === "number" && typeof value.goal === "string") {
      epoch = { n: value.n, ts: value.ts, goal: value.goal };
    }
    if (value.t === "spawn" && typeof value.ts === "number" && typeof value.worker === "string"
      && typeof value.type === "string" && typeof value.epoch === "number"
      && (value.step === undefined || typeof value.step === "string")) spawns.push(value as unknown as SpawnEvent);
  }
  return { delivered, epoch, spawns };
}

export function shouldStartEpoch({ isReport, source, spawnsInEpoch, planDone }: { isReport: boolean; source?: string; spawnsInEpoch: number; planDone: boolean }): boolean {
  return !isReport && source !== "extension" && (spawnsInEpoch === 0 || planDone);
}

export function hasResearch(events: readonly unknown[], sinceTs: number): boolean {
  return events.some(event => isReport(event) && event.kind === "DONE"
    && (event.role === "planner" || event.role === "researcher") && event.ts >= sinceTs);
}

/** Preserve herdr's agent fields; agent_status is the canonical live status. */
export interface LiveWorker {
  name: string;
  agent_status?: string;
  tab_id?: string;
  pane_id?: string;
  [key: string]: unknown;
}

export function parseLiveWorkers(json: string, tabId?: string, orch?: string): LiveWorker[] {
  let agents: unknown;
  try { agents = record(record(JSON.parse(json))?.result)?.agents; }
  catch { return []; }
  if (!Array.isArray(agents)) return [];
  return agents.filter((agent): agent is LiveWorker => {
    const value = record(agent);
    return typeof value?.name === "string" && value.name !== orch && (!tabId || value.tab_id === tabId);
  });
}

export type GateState = "fresh" | "stale" | "fail" | "missing" | "unknown";
export function gateStates(events: readonly unknown[], roles: readonly string[], tree?: string): Record<string, GateState> {
  return Object.fromEntries(roles.map(role => {
    const status = publishStatus(events, [role], tree);
    const state: GateState = status.ok ? "fresh" : /^Missing/.test(status.why) ? "missing"
      : /^Stale/.test(status.why) ? "stale" : / failed \(/.test(status.why) ? "fail" : "unknown";
    return [role, state];
  }));
}

export interface StateStep { id: string; status: string; type?: string; task?: string }
export interface StateView {
  goal: string;
  plan?: { status: string; steps?: readonly StateStep[] };
  steps?: readonly StateStep[];
  workers: readonly LiveWorker[];
  gates: Readonly<Record<string, GateState>>;
  undelivered: readonly (ReportEvent | string)[];
}

export function nextHint(view: StateView): string {
  if (view.plan?.status === "proposed" || view.plan?.status === "revise") return "revise and call swarm_plan propose";
  const blocked = view.workers.find(worker => worker.agent_status === "blocked");
  if (blocked) return `tell the user about ${blocked.name}'s dialog`;
  const working = view.workers.filter(worker => worker.agent_status === "working");
  if (working.length) return `swarm_wait ${working.map(worker => worker.name).join(", ")}`;
  const pending = (view.steps ?? view.plan?.steps ?? []).find(step => step.status === "pending");
  if (pending) return `spawn plan step ${pending.id}${pending.type ? ` (${pending.type})` : ""}`;
  if (Object.values(view.gates).some(state => state === "stale" || state === "missing")) return "spawn reviewer on the current tree";
  const settled = view.workers.filter(worker => worker.agent_status === "idle" || worker.agent_status === "done");
  if (settled.length) return `swarm_close ${settled.map(worker => worker.name).join(", ")}`;
  return "report to the user";
}

export function renderState(view: StateView): string {
  const steps = view.steps ?? view.plan?.steps;
  const lines = ["[swarm state — hidden, refreshed each prompt]", `goal: ${view.goal}`];
  if (view.plan) lines.push(`plan: ${view.plan.status}`);
  if (steps?.length) lines.push(`steps: ${steps.map(step => `${step.id}=${step.status}`).join(", ")}`);
  lines.push(`live: ${view.workers.map(worker => `${worker.name}=${worker.agent_status ?? "unknown"}`).join(", ") || "none"}`);
  lines.push(`gates: ${Object.entries(view.gates).map(([role, state]) => `${role}=${state}`).join(", ") || "none"}`);
  lines.push(`undelivered: ${view.undelivered.map(report => `r:${typeof report === "string" ? report.replace(/^r:/, "") : report.id}`).join(", ") || "none"}`);
  lines.push(`next: ${nextHint(view)}`);
  return lines.map(line => {
    const singleLine = line.replace(/[\r\n\u2028\u2029]+/g, " ");
    return singleLine.length > 200 ? singleLine.slice(0, 199) + "…" : singleLine;
  }).join("\n");
}

export function keepLatestState<T extends { role: string; customType?: string }>(messages: readonly T[], customType = "swarm-state"): T[] {
  const last = messages.findLastIndex(message => message.role === "custom" && message.customType === customType);
  return messages.filter((message, index) => index === last || message.role !== "custom" || message.customType !== customType);
}
