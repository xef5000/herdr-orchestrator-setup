import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseEvents, publishRoles, treeFingerprint } from "./swarm-run.ts";
import { artifactPath, contextSection, formatReport, gateStates, keepLatestState, parseLiveWorkers, parseReportHeader, pendingUndelivered, renderState, replayRunState, reportIdsIn, shouldStartEpoch, hasResearch } from "./swarm-state.ts";
import type { StateView } from "./swarm-state.ts";
import { assignStep, classifyAmend, classifyTier, publishes, dialogOptions, interpretChoice, lintPlan, mergeRequire, planDone, renderPlan, stepStatuses, validatePlan } from "./swarm-plan.ts";
import type { Plan, Step, TypeInfo } from "./swarm-plan.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_TIMEOUT_MS = 1_500_000;
const MAX_OUTPUT_CHARS = 20_000;
let spawnQueue: Promise<void> = Promise.resolve();

// Only creation is serialized: waiting must not prevent other workers spawning.
function serializeSpawn<T>(operation: () => Promise<T>): Promise<T> {
  const result = spawnQueue.then(operation);
  spawnQueue = result.then(() => undefined, () => undefined);
  return result;
}

function truncate(output: string): string {
  return output.length > MAX_OUTPUT_CHARS
    ? "[truncated — use swarm_read]\n" + output.slice(-MAX_OUTPUT_CHARS)
    : output;
}

function toolResult(output: string) {
  return {
    content: [{ type: "text" as const, text: truncate(output) }],
    details: undefined,
  };
}

function run(
  executable: "swarm" | "herdr",
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  allowNonzero = false,
  timeoutMs?: number,
): Promise<{ stdout: string; output: string }> {
  const home = process.env.SWARM_HOME;
  if (!home) return Promise.reject(new Error("SWARM_HOME is not set"));
  return new Promise((resolve, reject) => {
    execFile(`${home}/${executable}`, args, {
      cwd,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      signal,
      timeout: timeoutMs,
    }, (error, stdout, stderr) => {
      const output = stdout + stderr;
      // Timeout/nonzero wait statuses are useful reports, not tool failures.
      // Launch errors, buffer overflow and aborts still fail the tool.
      if (error && !(allowNonzero && typeof error.code === "number")) {
        reject(new Error(truncate(output || error.message)));
      } else {
        resolve({ stdout, output });
      }
    });
  });
}

const timeout = Type.Optional(Type.Integer({
  minimum: 1,
  description: "Wait timeout in milliseconds (default 1500000).",
}));
const name = Type.String({ minLength: 1, description: "Worker name." });

const stepSchema = Type.Object({
  id: Type.String({ minLength: 1 }), type: Type.String({ minLength: 1 }), brief: Type.String(),
  files: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
const planSchema = Type.Object({
  goal: Type.String(),
  template: Type.Union(["small-change", "feature", "bug", "ci-fix", "custom"].map(value => Type.Literal(value))),
  stages: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), loop: Type.Optional(Type.Boolean()), steps: Type.Array(stepSchema) })),
  require: Type.Optional(Type.Array(Type.Union([Type.Literal("reviewer"), Type.Literal("tester")]))),
  max_rounds: Type.Optional(Type.Number({ description: "Advisory only; never a scheduling limit." })),
  publish: Type.Optional(Type.Boolean()), suggestions: Type.Optional(Type.Array(Type.String())),
});

// Editors bypass tool-schema validation, so check the shape before the pure validator.
function checkedPlan(value: unknown, types: readonly TypeInfo[]): Plan {
  const p = value as Plan | undefined;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === "string");
  if (!p || typeof p !== "object" || typeof p.goal !== "string" ||
    !["small-change", "feature", "bug", "ci-fix", "custom"].includes(p.template) ||
    !Array.isArray(p.stages) || !p.stages.every(stage => stage && typeof stage.id === "string" && stage.id.length > 0 &&
      (stage.loop === undefined || typeof stage.loop === "boolean") && Array.isArray(stage.steps) &&
      stage.steps.every(step => step && typeof step.id === "string" && step.id.length > 0 && typeof step.type === "string" &&
        step.type.length > 0 && typeof step.brief === "string" && (step.files === undefined || (strings(step.files) && step.files.every(Boolean))))) ||
    (p.require !== undefined && !strings(p.require)) || (p.suggestions !== undefined && !strings(p.suggestions)) ||
    (p.publish !== undefined && typeof p.publish !== "boolean") ||
    (p.max_rounds !== undefined && (typeof p.max_rounds !== "number" || !Number.isFinite(p.max_rounds)))) throw new Error("Invalid Plan JSON");
  const errors = validatePlan(p, types);
  if (errors.length) throw new Error(errors.join("\n"));
  return p;
}

// Keep dialog blocking/recovery reusable by the plan wiring without global Pi state.
export function createDialogHelper(pi: ExtensionAPI, replay: () => void) {
  return async function withDialog<T>(label: string, fn: () => Promise<T>): Promise<T> {
    pi.events.emit("herdr:blocked", { active: true, label });
    try { return await fn(); }
    finally {
      pi.events.emit("herdr:blocked", { active: false });
      // Workers retry blocked delivery for 60 seconds before recording a marker.
      const safeReplay = () => { try { replay(); } catch { /* Retry on the next prompt. */ } };
      setTimeout(safeReplay, 65_000).unref();
      safeReplay();
    }
  };
}

export default function (pi: ExtensionAPI) {
  if (process.env.SWARM_ROLE !== "orchestrator") return;

  const runDir = process.env.SWARM_RUN_DIR;
  function readEvents(): unknown[] {
    if (!runDir) return [];
    try { return parseEvents(readFileSync(join(runDir, "events.jsonl"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  function appendEvent(event: object): void {
    if (runDir) appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
  }
  const state = replayRunState(readEvents());
  const waiting = new Map<string, number>();
  const held = new Map<string, { worker: string; text: string }>();
  const releasing = new Set<string>();
  function delivered(id: string, via: string): void {
    if (state.delivered.has(id)) return;
    appendEvent({ t: "delivered", id, via });
    state.delivered.add(id);
  }
  function release(id: string, text: string): void {
    releasing.add(id);
    try { pi.sendUserMessage(text, { deliverAs: "followUp" }); }
    catch (error) { releasing.delete(id); throw error; }
  }
  function replayUndelivered(): void {
    if (!runDir) return;
    for (const report of pendingUndelivered(readEvents(), state.delivered)) {
      if (releasing.has(report.id)) continue;
      const text = formatReport(report, readFileSync(artifactPath(runDir, report.id), "utf8"));
      if (waiting.has(report.worker)) held.set(report.id, { worker: report.worker, text });
      else release(report.id, text);
    }
  }
  const withDialog = createDialogHelper(pi, replayUndelivered);
  type PlanRecord = { epoch: number; status: "proposed" | "approved" | "revise" | "rejected"; tier: 0 | 1 | 2; plan: Plan; via: string; ts: number };
  let savedPlan: PlanRecord | undefined;
  if (runDir) {
    try { savedPlan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let typesPromise: Promise<TypeInfo[]> | undefined;
  let knownTypes: TypeInfo[] = [];
  function getTypes(ctx: ExtensionContext, _signal?: AbortSignal, refresh = false): Promise<TypeInfo[]> {
    if (refresh) typesPromise = undefined;
    return typesPromise ??= run("swarm", ["types", "--json"], ctx.cwd, undefined).then(result => {
      const types: TypeInfo[] = JSON.parse(result.stdout);
      if (!Array.isArray(types) || types.some(type => typeof type.type !== "string" || !Array.isArray(type.caps))) throw new Error("Invalid swarm types --json response");
      knownTypes = types;
      return types;
    }).catch(error => { typesPromise = undefined; throw error; });
  }
  let lastContext: ExtensionContext | undefined;
  function currentPlan(): PlanRecord | undefined { return savedPlan?.epoch === state.epoch.n ? savedPlan : undefined; }
  function statuses(events = readEvents()) {
    const record = currentPlan();
    return record ? stepStatuses(record.plan, events, state.spawns.filter(spawn => spawn.epoch === state.epoch.n), knownTypes) : {};
  }
  function policyRequire(): ("reviewer" | "tester")[] {
    if (!runDir) return [];
    try { return JSON.parse(readFileSync(join(runDir, "policy.json"), "utf8")).require ?? []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  function refreshPlan(ctx = lastContext): void {
    if (!ctx) return;
    lastContext = ctx;
    const record = currentPlan();
    ctx.ui.setWidget("swarm-plan", record ? [renderPlan(record.plan, policyRequire(), knownTypes),
      `T${record.tier} ${record.status} — ${Object.entries(statuses()).map(([id, status]) => `${id}=${status}`).join(", ")}`] : undefined);
    ctx.ui.setStatus("swarm-plan", record ? `T${record.tier} ${record.status}` : undefined);
  }
  function atomicJson(file: string, value: unknown): void {
    if (!runDir) return;
    const path = join(runDir, file), tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(value) + "\n", "utf8");
    renameSync(tmp, path);
  }
  function savePlan(plan: Plan, status: PlanRecord["status"], tier: PlanRecord["tier"], action: string, via: string, ctx: ExtensionContext, loosen = false): void {
    const record: PlanRecord = { epoch: state.epoch.n, status, tier, plan, via, ts: Date.now() };
    if (status === "approved") {
      const removed = loosen ? (currentPlan()?.plan.require ?? []).filter(role => !plan.require?.includes(role)) : [];
      let policy: Record<string, unknown> = {};
      if (runDir) {
        try { policy = JSON.parse(readFileSync(join(runDir, "policy.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      atomicJson("policy.json", { ...policy, require: mergeRequire(policyRequire().filter(role => !removed.includes(role)), plan.require) });
    }
    // A re-ask is only a pending proposal: running workers retain the last
    // approved amendment until a replacement is actually approved, even on UI errors.
    if (action === "amend" && status !== "approved" && currentPlan()?.status === "approved") {
      appendEvent({ t: "plan", action, status, tier });
      return;
    }
    atomicJson("plan.json", record);
    savedPlan = record;
    appendEvent({ t: "plan", action, status, tier });
    refreshPlan(ctx);
  }
  function needUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) throw new Error("swarm_plan approval requires a UI");
  }
  async function propose(plan: Plan, action: string, ctx: ExtensionContext, types: TypeInfo[], requireDecision = false): Promise<string> {
    const epoch = state.epoch.n;
    const tier = requireDecision ? 2 : classifyTier(plan, types);
    if (tier < 2) {
      savePlan(plan, "approved", tier, action, "automatic", ctx);
      if (tier === 1) ctx.ui.notify(`Plan approved: ${renderPlan(plan, plan.require ?? [], types)}`, "info");
      return "APPROVED. " + renderPlan(plan, policyRequire(), types);
    }
    if (runDir && !hasResearch(readEvents(), state.epoch.ts)) throw new Error("Tier-2 plan needs a planner or researcher report in this goal first (spawn one, then propose again)");
    needUI(ctx);
    savePlan(plan, "proposed", tier, action, "dialog", ctx);
    return withDialog("swarm plan approval", async () => {
      const { options, map } = dialogOptions(plan, lintPlan(plan, types));
      const publish = publishes(plan, types);
      const title = `${plan.goal}\nTier ${tier}\n${renderPlan(plan, plan.require ?? [], types)}\n${publish ? "needs your decision" : "auto-runs in 90s"}`;
      const controller = new AbortController();
      let timedOut = false;
      const timer = publish ? undefined : setTimeout(() => { timedOut = true; controller.abort(); }, 90_000);
      let choice: string | undefined;
      try { choice = await ctx.ui.select(title, options, publish ? {} : { signal: controller.signal }); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      if (state.epoch.n !== epoch) throw new Error("Goal changed during approval; propose a plan for the current goal");
      const selected = interpretChoice(choice, timedOut, map);
      let approved = plan;
      if (selected.kind === "suggestion") {
        savePlan(plan, "revise", tier, action, "suggestion", ctx);
        return `NOT APPROVED. User feedback: ${selected.suggestion}; revise and propose again.`;
      }
      if (selected.kind === "dismissed") {
        savePlan(plan, "revise", tier, action, "dismissed", ctx);
        return "NOT APPROVED. ask the user in one line; do not spawn makers";
      }
      if (selected.kind === "change" || selected.kind === "wrong") {
        const text = await ctx.ui.editor(selected.kind === "change" ? "Edit plan JSON" : "Describe the workflow", selected.kind === "change" ? JSON.stringify(plan, null, 2) : "");
        if (state.epoch.n !== epoch) throw new Error("Goal changed during approval; propose a plan for the current goal");
        if (selected.kind === "wrong") {
          savePlan(plan, "rejected", tier, action, "wrong", ctx);
          return `NOT APPROVED. User workflow: ${text ?? "dismissed"}`;
        }
        try { approved = checkedPlan(JSON.parse(text ?? ""), types); }
        catch {
          savePlan(plan, "revise", tier, action, "user-text", ctx);
          return `NOT APPROVED. User feedback: ${text ?? "dismissed"}; revise and propose again.`;
        }
      } else if (selected.kind === "lint" && selected.lint.apply) approved = selected.lint.apply(plan);
      savePlan(approved, "approved", classifyTier(approved, types), action, selected.kind === "change" ? "user-edited" : selected.kind, ctx);
      return "APPROVED. " + renderPlan(approved, policyRequire(), types);
    });
  }
  let planQueue: Promise<unknown> = Promise.resolve();
  pi.registerTool({
    name: "swarm_plan", label: "Swarm plan", description: "Propose or amend a plan before spawning makers, or inspect plan steps and publish gates. Small changes are approved without a dialog. max_rounds is advisory, not a limit.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("propose"), Type.Literal("amend"), Type.Literal("status")]), plan: Type.Optional(planSchema) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const requestedEpoch = state.epoch.n;
      const operation = async () => {
        let types = await getTypes(ctx, signal);
        if (params.plan?.stages?.some(stage => stage.steps?.some(step => !types.some(info => info.type === step.type)))) types = await getTypes(ctx, undefined, true);
        if (state.epoch.n !== requestedEpoch) throw new Error("Goal changed; propose a plan for the current goal");
        refreshPlan(ctx);
        const old = currentPlan();
        if (params.action === "status") return toolResult(old ? `${renderPlan(old.plan, policyRequire(), types)}\nT${old.tier} ${old.status}\nsteps: ${JSON.stringify(statuses())}\ngates: ${JSON.stringify(gateStates(readEvents(), publishRoles(process.env.SWARM_PUBLISH_REQUIRE, JSON.stringify({ require: policyRequire() })), treeFingerprint(ctx.cwd)))}` : "No plan in this goal. Call swarm_plan propose.");
        const plan = checkedPlan(params.plan, types);
        const amendment = params.action === "amend" || (old?.status === "approved" && !planDone(statuses()));
        if (!amendment || !old || old.status !== "approved") return toolResult(await propose(plan, params.action, ctx, types));
        const changes = classifyAmend(old.plan, plan, types);
        // Escalation must pass the same research and Tier-2 approval flow.
        if (changes.reapprove) return toolResult(await propose(plan, "amend", ctx, types, old.tier === 2));
        let loosen = false;
        if (changes.loosen.length) {
          needUI(ctx);
          loosen = await withDialog("swarm plan amendment", () => ctx.ui.confirm("Loosen plan safeguards?", changes.loosen.join("\n")));
          if (state.epoch.n !== requestedEpoch) throw new Error("Goal changed during approval; propose a plan for the current goal");
          if (!loosen) return toolResult("NOT APPROVED. Amendment declined; keeping the old plan.");
        }
        savePlan(plan, "approved", classifyTier(plan, types), "amend", loosen ? "confirmed-loosen" : "tighten", ctx, loosen);
        if (changes.tighten.length) ctx.ui.notify(`Plan amended:\n${changes.tighten.join("\n")}`, "info");
        return toolResult("APPROVED. " + renderPlan(plan, policyRequire(), types));
      };
      const result = planQueue.then(operation);
      planQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  });

  async function withWait(workers: string[], operation: () => Promise<{ output: string }>): Promise<{ output: string }> {
    if (!runDir) return operation();
    const names = [...new Set(workers)];
    for (const worker of names) waiting.set(worker, (waiting.get(worker) ?? 0) + 1);
    let output = "";
    try {
      const result = await operation();
      output = result.output;
      return result;
    } finally {
      for (const id of reportIdsIn(output)) delivered(id, "wait");
      for (const worker of names) {
        const count = (waiting.get(worker) ?? 1) - 1;
        if (count > 0) { waiting.set(worker, count); continue; }
        waiting.delete(worker);
        for (const [id, report] of held) {
          if (report.worker !== worker) continue;
          held.delete(id);
          if (!state.delivered.has(id)) release(id, report.text);
        }
      }
      refreshPlan();
    }
  }
  function addContext(text: string, refs?: string[]): string {
    if (!refs?.length) return text;
    if (!runDir) throw new Error("context_from requires SWARM_RUN_DIR");
    const events = readEvents();
    return text + refs.map(ref => "\n\n" + contextSection(events, ref, path => readFileSync(path, "utf8"), runDir)).join("");
  }
  function startEpoch(goal: string): void {
    const epoch = { n: state.epoch.n + 1, ts: Date.now(), goal: goal.slice(0, 200) };
    appendEvent({ t: "epoch", ...epoch });
    state.epoch = epoch;
    refreshPlan();
  }
  pi.on("input", (event, ctx) => {
    if (ctx) lastContext = ctx;
    refreshPlan();
    if (!runDir) return { action: "continue" };
    const header = parseReportHeader(event.text);
    if (header?.id) {
      if (releasing.delete(header.id)) { delivered(header.id, "inbox"); return { action: "continue" }; }
      if (state.delivered.has(header.id)) return { action: "handled" };
      if (waiting.has(header.worker)) {
        held.set(header.id, { worker: header.worker, text: event.text });
        return { action: "handled" };
      }
      delivered(header.id, "inbox");
    } else if (shouldStartEpoch({ isReport: !!header, source: event.source,
      spawnsInEpoch: state.spawns.filter(spawn => spawn.epoch === state.epoch.n).length, planDone: currentPlan()?.status === "approved" && planDone(statuses()) })) {
      startEpoch(event.text);
    }
    return { action: "continue" };
  });
  pi.registerCommand("swarm-goal", {
    description: "Start a new swarm goal epoch explicitly.",
    handler: async args => { if (runDir) startEpoch(args); },
  });
  pi.on("agent_end", () => {
    // A queued follow-up can be dropped on abort. Unacknowledged reports must
    // become eligible for replay again rather than stay in-flight forever.
    releasing.clear();
  });
  // Pi accepts one message per handler, and runner.emitBeforeAgentStart collects
  // messages from every handler. Keep durable reports separate from replaceable state.
  pi.on("before_agent_start", () => {
    if (!runDir) return;
    const reports: { id: string; text: string }[] = [];
    let remaining = MAX_OUTPUT_CHARS;
    for (const report of pendingUndelivered(readEvents(), state.delivered)) {
      if (waiting.has(report.worker) || releasing.has(report.id)) continue;
      let text: string;
      try {
        const body = readFileSync(artifactPath(runDir, report.id), "utf8");
        text = formatReport(report, body.slice(0, MAX_OUTPUT_CHARS) + (body.length > MAX_OUTPUT_CHARS ? "\n[truncated — use swarm_read]" : ""));
      } catch {
        text = `report r:${report.id} (artifact unavailable)`;
      }
      if (reports.length && text.length > remaining) break;
      reports.push({ id: report.id, text });
      remaining -= text.length;
      if (remaining <= 0) break;
    }
    if (!reports.length) return;
    for (const report of reports) { held.delete(report.id); delivered(report.id, "report"); }
    return { message: { customType: "swarm-report", content: reports.map(report => report.text).join("\n\n"), display: true } };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!runDir) return;
    let content: string;
    try {
      const events = readEvents();
      if (currentPlan()) await getTypes(ctx);
      refreshPlan(ctx);
      const record = currentPlan();
      const steps = record?.plan.stages.flatMap(stage => stage.steps).map(step => ({ id: step.id, type: step.type, task: step.brief, status: statuses(events)[step.id] }));
      let policyJson: string | undefined;
      try { policyJson = readFileSync(join(runDir, "policy.json"), "utf8"); } catch { /* Optional policy. */ }
      const live = await run("herdr", ["agent", "list"], ctx.cwd, undefined, false, 10_000);
      const view: StateView = {
        goal: state.epoch.goal,
        plan: record ? { status: record.status, steps } : undefined,
        workers: parseLiveWorkers(live.stdout, process.env.HERDR_TAB_ID, process.env.SWARM_NAME),
        gates: gateStates(events, publishRoles(process.env.SWARM_PUBLISH_REQUIRE, policyJson), treeFingerprint(ctx.cwd)),
        undelivered: pendingUndelivered(events, state.delivered),
      };
      content = renderState(view);
    } catch (error) { content = "state unavailable: " + String(error).replace(/[\r\n\u2028\u2029]+/g, " "); }
    return { message: { customType: "swarm-state", content, display: false } };
  });
  pi.on("context", event => ({ messages: keepLatestState(event.messages) }));

  pi.registerTool({
    name: "swarm_spawn",
    label: "Spawn worker",
    description: "Delegate work: open a worker of <type> (see the agent table) and send it a SELF-CONTAINED task. wait:true blocks until it settles and returns its output. Multiple calls in one message run in parallel.",
    parameters: Type.Object({
      type: Type.String({ minLength: 1, description: "Agent type from the agent table or swarm_types." }),
      task: Type.String({ minLength: 1, description: "Self-contained task, including context, files, acceptance and verification." }),
      name: Type.Optional(name),
      step: Type.Optional(Type.String({ minLength: 1, description: "Plan step id; otherwise assigned automatically." })),
      context_from: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Worker names or r:<id> reports to attach as context." })),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Write scope paths/dirs for the worker; default project+tmp." })),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: timeout,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      let types = await getTypes(ctx, signal);
      if (!types.some(info => info.type === params.type)) types = await getTypes(ctx, undefined, true);
      const editCapable = (type: string) => types.find(info => info.type === type)?.caps.some(cap => cap === "edit" || cap === "edit-tests") ?? false;
      const maker = (type: string) => types.find(info => info.type === type)?.caps.includes("edit") ?? false;
      if (!types.some(info => info.type === params.type)) throw new Error(`Unknown type: ${params.type}`);
      const { spawned, workerName } = await serializeSpawn(async () => {
        const record = currentPlan();
        if (runDir && editCapable(params.type) && record?.status !== "approved") throw new Error("call swarm_plan first (small changes need no dialog)");
        let step: Step | undefined;
        if (params.step !== undefined) {
          step = record?.status === "approved" ? record.plan.stages.flatMap(stage => stage.steps).find(step => step.id === params.step) : undefined;
          if (!step || (step.type !== params.type && !(maker(step.type) && maker(params.type)))) throw new Error(`Invalid plan step ${params.step} for ${params.type}`);
        } else if (record?.status === "approved") step = assignStep(record.plan, statuses(), params.type, types);
        if (runDir && editCapable(params.type) && !step) throw new Error(`swarm_plan amend to add a ${params.type} step`);
        const args = ["spawn", params.type];
        if (params.name) args.push("--name", params.name);
        const files = params.files ?? step?.files;
        const roots = [ctx.cwd, tmpdir(), "/tmp", "/private/tmp", process.env.TMPDIR].filter((root): root is string => !!root).map(root => resolve(root));
        // Validate both the explicit override and the plan's original scope.
        for (const file of [...(params.files ?? []), ...(step?.files ?? [])]) {
          const target = resolve(ctx.cwd, file);
          if (!roots.some(root => target === root || target.startsWith(root.endsWith("/") ? root : root + "/"))) {
            throw new Error(`files scope must stay inside the project or tmp: ${file}`);
          }
        }
        if (step?.files && params.files && (!params.files.length || !params.files.every(file => step!.files!.some(scope => {
          const base = resolve(ctx.cwd, scope), target = resolve(ctx.cwd, file);
          return target === base || ((scope.endsWith("/") || statSync(base, { throwIfNoEntry: false })?.isDirectory()) && target.startsWith(base.endsWith("/") ? base : base + "/"));
        })))) throw new Error("files must stay within the plan step files; call swarm_plan amend first");
        if (files?.length) args.push("--scope", files.join(","));
        args.push("--task", addContext(params.task, params.context_from));
        const epoch = state.epoch.n;
        const spawned = await run("swarm", args, ctx.cwd, signal);
        const workerName = /^spawned (\S+) \(/m.exec(spawned.stdout)?.[1];
        if (!workerName) throw new Error(truncate("Could not parse spawned worker name:\n" + spawned.output));
        const spawn = { t: "spawn" as const, ts: Date.now(), worker: workerName, type: params.type, step: step?.id, epoch };
        appendEvent(spawn);
        state.spawns.push(spawn);
        refreshPlan(ctx);
        return { spawned, workerName };
      });
      let output = spawned.output;
      if (params.wait) {
        const waited = await withWait([workerName], () => run("swarm", ["wait", workerName, "--timeout", String(params.timeout_ms ?? DEFAULT_TIMEOUT_MS)], ctx.cwd, signal, true));
        output += "\n" + waited.output;
      }
      refreshPlan(ctx);
      return toolResult(output);
    },
  });

  pi.registerTool({
    name: "swarm_prompt",
    label: "Prompt worker",
    description: "Send a self-contained follow-up to an existing worker. wait:true returns its output when it settles; timeout reports can be followed with swarm_wait.",
    parameters: Type.Object({
      name,
      text: Type.String({ minLength: 1, description: "Follow-up task or answer to the worker's question." }),
      context_from: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Worker names or r:<id> reports to attach as context." })),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: timeout,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const spawn = state.spawns.findLast(spawn => spawn.worker === params.name);
      // Unknown names (including aliases) cannot prove read-only capability.
      // Fail closed without an approved current-epoch plan rather than bypass the gate.
      if (runDir && !spawn && currentPlan()?.status !== "approved") throw new Error("call swarm_plan first for unknown targets");
      if (runDir && spawn) {
        const types = await getTypes(ctx);
        if (types.find(info => info.type === spawn.type)?.caps.some(cap => cap === "edit" || cap === "edit-tests")) {
          if (currentPlan()?.status !== "approved") throw new Error("call swarm_plan first");
          if (spawn.epoch !== state.epoch.n) throw new Error("re-spawn in the current goal");
        }
      }
      const args = ["prompt", params.name, addContext(params.text, params.context_from)];
      if (params.wait) args.push("--wait", "--timeout", String(params.timeout_ms ?? DEFAULT_TIMEOUT_MS));
      const operation = () => run("swarm", args, ctx.cwd, signal, params.wait === true);
      const result = await (params.wait ? withWait([params.name], operation) : operation());
      refreshPlan(ctx);
      return toolResult(result.output);
    },
  });

  pi.registerTool({
    name: "swarm_wait",
    label: "Wait for workers",
    description: "Wait for named workers to settle and return their outputs, including blocked approval dialogs. On timeout, wait again rather than spawning duplicates.",
    parameters: Type.Object({ names: Type.Array(name, { minItems: 1 }), timeout_ms: timeout }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await withWait(params.names, () => run("swarm", ["wait", ...params.names, "--timeout", String(params.timeout_ms ?? DEFAULT_TIMEOUT_MS)], ctx.cwd, signal, true));
      refreshPlan(ctx);
      return toolResult(result.output);
    },
  });

  pi.registerTool({
    name: "swarm_read",
    label: "Read worker",
    description: "Read a report artifact by report (r:<id>, first 20000 chars), or recent unwrapped output by worker name (default 150 lines). Provide exactly one of name or report. Use pane output to inspect a blocked worker's dialog.",
    parameters: Type.Object({ name: Type.Optional(name), report: Type.Optional(Type.String({ minLength: 1 })), lines: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if ((params.name !== undefined) === (params.report !== undefined)) throw new Error("Provide exactly one of name or report");
      if (params.report !== undefined) {
        if (!runDir) throw new Error("report requires SWARM_RUN_DIR");
        const text = readFileSync(artifactPath(runDir, params.report), "utf8");
        return toolResult(text.slice(0, MAX_OUTPUT_CHARS));
      }
      const result = await run("herdr", ["agent", "read", params.name!, "--source", "recent-unwrapped", "--lines", String(params.lines ?? 150)], ctx.cwd, signal);
      return toolResult(result.output);
    },
  });

  pi.registerTool({
    name: "swarm_ls",
    label: "List workers",
    description: "List live swarm workers and their statuses.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      return toolResult((await run("swarm", ["ls"], ctx.cwd, signal)).output);
    },
  });

  pi.registerTool({
    name: "swarm_types",
    label: "List agent types",
    description: "List available worker types, models and routing descriptions before delegating.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      return toolResult((await run("swarm", ["types"], ctx.cwd, signal)).output);
    },
  });

  pi.registerTool({
    name: "swarm_close",
    label: "Close worker",
    description: "Close a finished worker after accepting its work. Never close a worker that is still needed or awaiting user approval.",
    parameters: Type.Object({ name }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return toolResult((await run("swarm", ["close", params.name], ctx.cwd, signal)).output);
    },
  });
}
