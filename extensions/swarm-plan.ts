import { latestReport } from "./swarm-run.ts";
import type { ReportEvent } from "./swarm-run.ts";

export type Template = "small-change" | "feature" | "bug" | "ci-fix" | "custom";
export interface Step { id: string; type: string; brief: string; files?: string[] }
export interface Stage { id: string; loop?: boolean; steps: Step[] }
export interface Plan {
  goal: string;
  template: Template;
  stages: Stage[];
  require?: ("reviewer" | "tester")[];
  /** Advisory text only; never a scheduling or enforcement limit. */
  max_rounds?: number;
  publish?: boolean;
  suggestions?: string[];
}
export interface TypeInfo { type: string; caps: string[]; verdict: boolean }
export interface PlanLint { text: string; apply?: (p: Plan) => Plan }
export type DialogAction =
  | { kind: "run" | "change" | "wrong" }
  | { kind: "lint"; lint: PlanLint }
  | { kind: "suggestion"; suggestion: string };
export type DialogActionMap = Record<string, DialogAction>;
export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed";
export type StepStatuses = Record<string, StepStatus>;
export interface SpawnEvent { t: "spawn"; ts: number; worker: string; type: string; step?: string; epoch: number }

const info = (step: Step, types: readonly TypeInfo[]) => types.find(t => t.type === step.type);
const maker = (step: Step, types: readonly TypeInfo[]) => info(step, types)?.caps.includes("edit") ?? false;
const checker = (step: Step, types: readonly TypeInfo[]) => info(step, types)?.verdict ?? false;
const steps = (p: Plan) => p.stages.flatMap(stage => stage.steps);

export function validatePlan(p: Plan, types: readonly TypeInfo[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const checkId = (id: string) => {
    if (ids.has(id)) errors.push(`Duplicate id: ${id}`);
    ids.add(id);
  };
  if (!p.stages.length) errors.push("Plan has no stages");
  for (const stage of p.stages) {
    checkId(stage.id);
    if (!stage.steps.length) errors.push(`Stage ${stage.id} has no steps`);
    for (const step of stage.steps) {
      checkId(step.id);
      if (!info(step, types)) errors.push(`Unknown type: ${step.type}`);
      if (step.files !== undefined && !step.files.length) errors.push(`Empty files for step ${step.id}`);
    }
  }
  for (const role of p.require ?? []) {
    if (role !== "reviewer" && role !== "tester") errors.push(`Invalid required role: ${role}`);
  }
  return errors;
}

export function publishes(p: Plan, types: readonly TypeInfo[]): boolean {
  return !!p.publish || steps(p).some(step => info(step, types)?.caps.includes("github"));
}

export function classifyTier(p: Plan, types: readonly TypeInfo[]): 0 | 1 | 2 {
  const all = steps(p);
  const count = all.filter(step => maker(step, types)).length;
  if (count >= 3 || publishes(p, types) || p.stages.some(stage => stage.steps.filter(step => maker(step, types)).length >= 2)) return 2;
  if (!all.some(step => info(step, types)?.caps.some(cap => cap === "edit" || cap === "edit-tests"))) return 0;
  return 1;
}

function uniqueId(p: Plan, base: string): string {
  const used = new Set([...p.stages.map(stage => stage.id), ...steps(p).map(step => step.id)]);
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

function insertCheckStage(p: Plan, index: number, id: string, type: string, brief: string): Plan {
  const stageId = uniqueId(p, id);
  const withStage = { ...p, stages: [...p.stages, { id: stageId, steps: [] }] };
  const stage: Stage = { id: stageId, steps: [{ id: uniqueId(withStage, type), type, brief }] };
  return { ...p, stages: [...p.stages.slice(0, index), stage, ...p.stages.slice(index)] };
}

// Directory scopes overlap their descendants. Wildcards are conservatively linted,
// not enforced: this is advice, not a file access guard.
function overlapping(a: string, b: string): boolean {
  const prefix = (value: string) => value.split(/[?*\[]/, 1)[0].replace(/\/$/, "");
  const left = prefix(a), right = prefix(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`) ||
    ((a !== left || b !== right) && (left.startsWith(right) || right.startsWith(left)));
}

export function lintPlan(p: Plan, types: readonly TypeInfo[]): PlanLint[] {
  const lints: PlanLint[] = [];
  p.stages.forEach((stage, index) => {
    const makers = stage.steps.filter(step => maker(step, types));
    // Checkers in a stage execute after its non-checkers, regardless of array order.
    const laterChecker = p.stages.slice(index).some(s => s.steps.some(step => checker(step, types)));
    if (makers.length && !laterChecker) {
      lints.push({ text: `Apply: add reviewer stage after ${stage.id}`, apply: current => {
        const at = current.stages.findIndex(s => s.id === stage.id);
        return at < 0 ? current : insertCheckStage(current, at + 1, "review", "reviewer", "Review the preceding changes");
      } });
    }
    if (makers.length >= 2) {
      if (makers.some(step => !step.files?.length)) lints.push({ text: `Parallel makers in ${stage.id} lack file scopes` });
      if (makers.some((step, i) => makers.slice(i + 1).some(other => step.files?.some(a => other.files?.some(b => overlapping(a, b)))))) {
        lints.push({ text: `Parallel makers in ${stage.id} have overlapping files` });
      }
    }
    if (stage.loop && !stage.steps.some(step => checker(step, types))) {
      lints.push({ text: `Apply: add reviewer step to loop ${stage.id}`, apply: current => ({
        ...current,
        stages: current.stages.map(s => s.id !== stage.id ? s : {
          ...s, steps: [...s.steps, { id: uniqueId(current, "review"), type: "reviewer", brief: "Review this round" }],
        }),
      }) });
    }
  });
  if (p.template === "bug" && !steps(p).some(step => step.type === "tester")) {
    lints.push({ text: "Apply: add repro tester stage before implementation", apply: current => {
      const first = current.stages.findIndex(stage => stage.steps.some(step => maker(step, types)));
      return insertCheckStage(current, first < 0 ? 0 : first, "repro", "tester", "Reproduce the bug and verify the fix");
    } });
  }
  return lints;
}

export function dialogOptions(p: Plan, lints: readonly PlanLint[]): { options: string[]; map: DialogActionMap } {
  const options = ["Run this plan"];
  const map: DialogActionMap = Object.create(null);
  map[options[0]] = { kind: "run" };
  const add = (label: string, action: DialogAction) => {
    if (options.includes(label)) return;
    options.push(label);
    map[label] = action;
  };
  let count = 0;
  for (const lint of lints) {
    if (!lint.apply || count >= 3) continue;
    const label = lint.text.startsWith("Apply: ") ? lint.text : `Apply: ${lint.text}`;
    const before = options.length;
    add(label, { kind: "lint", lint });
    if (options.length > before) count++;
  }
  for (const suggestion of p.suggestions ?? []) {
    if (count >= 3) break;
    const before = options.length;
    add(`Suggestion: ${suggestion}`, { kind: "suggestion", suggestion });
    if (options.length > before) count++;
  }
  add("Change…", { kind: "change" });
  add("Wrong — I'll describe the workflow", { kind: "wrong" });
  return { options, map };
}

export function interpretChoice(choice: string | undefined, timedOut: boolean, map: DialogActionMap): DialogAction | { kind: "auto" | "dismissed" } {
  if (choice === undefined) return { kind: timedOut ? "auto" : "dismissed" };
  return Object.hasOwn(map, choice) ? map[choice] : { kind: "dismissed" };
}

export function classifyAmend(old: Plan, next: Plan, types: readonly TypeInfo[]): { loosen: string[]; tighten: string[]; reapprove: boolean } {
  const loosen: string[] = [], tighten: string[] = [];
  for (const role of old.require ?? []) if (!next.require?.includes(role)) loosen.push(`Removed required role ${role}`);
  for (const role of next.require ?? []) if (!old.require?.includes(role)) tighten.push(`Added required role ${role}`);
  for (const stage of old.stages) {
    const replacement = next.stages.find(s => s.id === stage.id);
    if (stage.loop && !replacement?.loop) loosen.push(`Stage ${stage.id} lost loop`);
    if (!replacement) tighten.push(`Removed stage ${stage.id}`);
    else if (!stage.loop && replacement.loop) tighten.push(`Added loop to stage ${stage.id}`);
  }
  for (const stage of next.stages) if (!old.stages.some(s => s.id === stage.id)) tighten.push(`Added stage ${stage.id}`);
  const oldSteps = steps(old), newSteps = steps(next);
  for (const step of oldSteps) {
    const replacement = newSteps.find(s => s.id === step.id);
    if (!replacement) {
      (checker(step, types) ? loosen : tighten).push(`Removed ${checker(step, types) ? "checker " : ""}step ${step.id}`);
      continue;
    }
    if (checker(step, types) && !checker(replacement, types)) loosen.push(`Removed checker from step ${step.id}`);
    if (step.type !== replacement.type) tighten.push(`Changed type of step ${step.id} to ${replacement.type}`);
    if (step.brief !== replacement.brief) tighten.push(`Changed brief of step ${step.id}`);
    const widened = step.files !== undefined && (replacement.files === undefined || replacement.files.length === 0 || replacement.files.some(file => !step.files!.includes(file)));
    if (widened) loosen.push(`Widened files for step ${step.id}`);
    else if (JSON.stringify(step.files) !== JSON.stringify(replacement.files)) tighten.push(`Changed files for step ${step.id}`);
    const stageOf = (p: Plan) => p.stages.find(s => s.steps.some(other => other.id === step.id))?.id;
    if (stageOf(old) !== stageOf(next)) tighten.push(`Moved step ${step.id}`);
  }
  for (const step of newSteps) if (!oldSteps.some(s => s.id === step.id)) tighten.push(`Added step ${step.id}`);
  if (!publishes(old, types) && publishes(next, types)) loosen.push("Enabled publish");
  else if (publishes(old, types) && !publishes(next, types)) tighten.push("Disabled publish");
  if (old.goal !== next.goal) tighten.push("Changed goal");
  if (old.template !== next.template) tighten.push("Changed template");
  if (old.max_rounds !== next.max_rounds) tighten.push("Changed advisory max_rounds (not a limit)");
  if (JSON.stringify(old.suggestions) !== JSON.stringify(next.suggestions)) tighten.push("Changed suggestions");
  const order = (p: Plan) => JSON.stringify(p.stages.map(s => [s.id, s.steps.map(step => step.id)]));
  if (order(old) !== order(next)) tighten.push("Changed stage or step order");
  const makerWork = (p: Plan) => steps(p).filter(step => maker(step, types)).map(({ id, type, brief }) => ({ id, type, brief }));
  const oldTier = classifyTier(old, types);
  const changedWork = old.goal !== next.goal || JSON.stringify(makerWork(old)) !== JSON.stringify(makerWork(next));
  return { loosen, tighten, reapprove: (oldTier < 2 && classifyTier(next, types) === 2) || (oldTier === 2 && changedWork) };
}

export function renderPlan(p: Plan, requiredRoles: readonly string[], types: readonly TypeInfo[]): string {
  const label = (step: Step) => step.id.startsWith(step.type) || step.type.startsWith(step.id) ? step.id : `${step.id}(${step.type})`;
  const rendered = p.stages.map(stage => {
    const makers = stage.steps.filter(step => !checker(step, types)).map(label).join(" ∥ ");
    const checks = stage.steps.filter(step => checker(step, types)).map(label).join(" ∥ ");
    const text = [makers, checks].filter(Boolean).join(" → ");
    return stage.loop ? `⟳[${text}]` : text;
  }).join(" → ");
  return rendered + (requiredRoles.length ? ` 🔒${requiredRoles.join(",")}` : "");
}

export function stepStatuses(p: Plan, events: readonly unknown[], spawns: readonly SpawnEvent[], types: readonly TypeInfo[]): StepStatuses {
  // A worker's latest spawn supersedes assignments from earlier epochs.
  const assignments = new Map<string, SpawnEvent>();
  for (const spawn of spawns) assignments.set(spawn.worker, spawn);
  const statuses: StepStatuses = Object.create(null);
  for (const step of steps(p)) {
    const workers = [...assignments.values()].filter(spawn => spawn.step === step.id);
    if (!workers.length) { statuses[step.id] = "pending"; continue; }
    let report: ReportEvent | undefined;
    let reportIndex = -1;
    for (const spawn of workers) {
      const candidate = latestReport(events, spawn.worker, spawn.ts);
      if (candidate) {
        const index = events.lastIndexOf(candidate);
        if (index > reportIndex) { report = candidate; reportIndex = index; }
      }
    }
    if (!report) { statuses[step.id] = "running"; continue; }
    const isChecker = info(step, types)?.verdict ?? (step.type === "reviewer" || step.type === "tester");
    if (report.verdict === "fail") statuses[step.id] = "failed";
    else if (report.kind === "DONE") statuses[step.id] = !isChecker || report.verdict === "pass" ? "done" : "waiting";
    else statuses[step.id] = "waiting";
  }
  return statuses;
}

export function assignStep(p: Plan, statuses: StepStatuses, type: string, types: readonly TypeInfo[]): Step | undefined {
  const pending = steps(p).find(step => step.type === type && statuses[step.id] === "pending");
  if (pending) return pending;
  if (!types.find(t => t.type === type)?.caps.includes("edit")) return undefined;
  for (const stage of p.stages) {
    if (stage.steps.every(step => statuses[step.id] === "done")) continue;
    const candidate = stage.steps.find(step => maker(step, types));
    if (candidate) return candidate;
  }
  return undefined;
}

export function planDone(statuses: StepStatuses): boolean {
  return Object.values(statuses).every(status => status === "done");
}

export function mergeRequire(old?: readonly ("reviewer" | "tester")[], next?: readonly ("reviewer" | "tester")[]): ("reviewer" | "tester")[] {
  return [...new Set([...(old ?? []), ...(next ?? [])])];
}
