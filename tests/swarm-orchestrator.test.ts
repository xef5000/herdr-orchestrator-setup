import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import * as stateHelpers from "../extensions/swarm-state.ts";
import * as planHelpers from "../extensions/swarm-plan.ts";
import { parseEvents, publishRoles, reportEvent } from "../extensions/swarm-run.ts";

const types = [
  { type: "impl-pro", caps: ["edit"], verdict: false },
  { type: "impl", caps: ["edit"], verdict: false },
  { type: "tester", caps: ["edit-tests"], verdict: true },
  { type: "reviewer", caps: [], verdict: true },
  { type: "planner", caps: [], verdict: false },
  { type: "researcher", caps: [], verdict: false },
  { type: "github", caps: ["github"], verdict: false },
];
const smallPlan = () => ({ goal: "change", template: "small-change", stages: [{ id: "build", steps: [{ id: "impl", type: "impl-pro", brief: "Implement", files: ["src/a.ts"] }] }] });
const bigPlan = (publish = false) => ({ ...smallPlan(), publish, stages: [{ id: "build", steps: [...smallPlan().stages[0].steps, { id: "impl2", type: "impl", brief: "More", files: ["src/b.ts"] }] }] });
const research = () => reportEvent({ id: "research", ts: Date.now(), worker: "planner", role: "planner", kind: "DONE", artifact: "artifacts/research.md" });

const source = stripTypeScriptTypes(readFileSync(new URL("../extensions/swarm-orchestrator.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")
  .replace("export function createDialogHelper", "function createDialogHelper")
  .replace("export default function", "globalThis.install = function");

function harness(initial: unknown[] = [], extra: Record<string, string> = {}) {
  const env = { SWARM_ROLE: "orchestrator", SWARM_NAME: "orch", SWARM_HOME: "/swarm", SWARM_RUN_DIR: "/run", HERDR_TAB_ID: "tab", ...extra };
  const files = new Map<string, string>([["/run/events.jsonl", initial.map(event => JSON.stringify(event)).join("\n") + "\n"]]);
  const handlers: Record<string, Function> = {};
  const registered: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const sent: { text: string; options: any }[] = [];
  const calls: { args: string[]; cb: Function; opts: any }[] = [];
  const timers: { fn: Function; ms: number; unref: boolean }[] = [];
  const blocked: any[] = [];
  const uiCalls: { kind: string; args: any[] }[] = [];
  let now = Date.now();
  const choices: any = { select: "Run this plan", editor: undefined, confirm: true, types };
  const ui: any = Object.fromEntries(["select", "editor", "confirm", "notify", "setWidget", "setStatus"].map(kind => [kind, (...args: any[]) => {
    uiCalls.push({ kind, args });
    const value = choices[kind];
    return typeof value === "function" ? value(...args) : value;
  }]));
  const ctx = { cwd: "/repo", hasUI: true, ui };
  const context: any = {
    ...stateHelpers, ...planHelpers, parseEvents, publishRoles, treeFingerprint: () => "tree", join, resolve, tmpdir: () => "/tmp", AbortController,
    statSync: (path: string) => ({ isDirectory: () => path === "/repo/src" }),
    clearTimeout: () => {},
    Date: { now: () => now },
    process: { env },
    Type: new Proxy({}, { get: () => (...args: unknown[]) => args }),
    readFileSync: (path: string) => { if (!files.has(path)) throw Object.assign(new Error("missing " + path), { code: "ENOENT" }); return files.get(path); },
    appendFileSync: (path: string, text: string) => files.set(path, (files.get(path) ?? "") + text),
    writeFileSync: (path: string, text: string) => files.set(path, text),
    renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    execFile: (_path: string, args: string[], opts: unknown, cb: Function) => {
      if (args.join(" ") === "types --json") {
        uiCalls.push({ kind: "types", args: [opts] });
        if (choices.types instanceof Error) cb(choices.types, "", "");
        else cb(null, JSON.stringify(choices.types), "");
      }
      else calls.push({ args, cb, opts });
    },
    setTimeout: (fn: Function, ms: number) => {
      const timer = { fn, ms, unref: false }; timers.push(timer);
      return { unref: () => { timer.unref = true; } };
    },
  };
  runInNewContext(source, context);
  const pi = {
    on: (name: string, fn: Function) => {
      (registered[name] ??= []).push(fn);
      handlers[name] = name === "before_agent_start" ? async (event: any, context?: any) => {
        const messages: any[] = [];
        for (const handler of registered[name]) {
          const result = await handler(event, { ...ctx, ...context });
          if (result?.message) messages.push(result.message);
        }
        return messages.length ? { messages, message: messages.at(-1) } : undefined;
      } : (event: any, context?: any) => fn(event, { ...ctx, ...context });
    },
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: any) => { commands[name] = command; },
    sendUserMessage: (text: string, options: any) => {
      if (choices.sendError) throw choices.sendError;
      sent.push({ text, options });
    },
    events: { emit: (_name: string, payload: any) => blocked.push(payload) },
  };
  context.install(pi);
  return { files, handlers, tools, commands, sent, calls, timers, blocked, uiCalls, choices, ctx,
    advance: (ms: number) => { now += ms; },
    dialog: context.createDialogHelper(pi, () => handlers.before_agent_start({}, { cwd: "/repo" })),
    execute: (name: string, params: any, signal?: AbortSignal) => tools[name].execute("call", params, signal, undefined, ctx),
    input: (text: string, source = "rpc") => handlers.input({ text, source }),
    events: () => parseEvents(files.get("/run/events.jsonl") ?? "") as any[],
  };
}
const header = "DONE w1 [r:r1 verdict:pass]: reviewed";
const report = () => reportEvent({ id: "r1", ts: 1, worker: "w1", role: "reviewer", kind: "DONE", verdict: "pass", tree: "tree", artifact: "artifacts/r1.md" });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("wait delivery dedupes inbox reports including held copies", async () => {
  const h = harness();
  const pending = h.execute("swarm_wait", { names: ["w1"] });
  assert.equal(h.input(header).action, "handled");
  h.calls[0].cb(null, `=== w1: done\n${header}`, "");
  assert.equal((await pending).content[0].text, `=== w1: done\n${header}`);
  assert.equal(h.input(header).action, "handled");
  assert.equal(h.sent.length, 0);
  assert.equal(h.events().filter(event => event.t === "delivered").length, 1);
  assert.equal(h.events()[0].via, "wait");
});

test("held reports release once after all overlapping waits finish without the id", async () => {
  const h = harness();
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const a = h.execute("swarm_wait", { names: ["w1", "w1"] });
  const b = h.execute("swarm_prompt", { name: "w1", text: "go", wait: true });
  assert.equal(h.input(header).action, "handled");
  h.calls[0].cb(null, "timeout", ""); await a;
  assert.equal(h.sent.length, 0);
  h.calls[1].cb(null, "timeout", ""); await b;
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, header);
  assert.equal(h.sent[0].options.deliverAs, "followUp");
  assert.equal(h.input(header, "extension").action, "continue");
  assert.equal(h.input(header).action, "handled");
});

test("failed waits still release held reports", async () => {
  const h = harness();
  const pending = h.execute("swarm_wait", { names: ["w1"] });
  h.input(header);
  h.calls[0].cb(new Error("aborted"), "", "");
  await assert.rejects(pending, /aborted/);
  assert.equal(h.sent.length, 1);
});

test("undelivered replay is exactly once and includes persisted delivery history", async () => {
  const h = harness([report(), { t: "undelivered", id: "r1" }, { t: "undelivered", id: "r1" }]);
  h.files.set("/run/artifacts/r1.md", "reviewed");
  let messages: any[] = [];
  for (let i = 0; i < 2; i++) {
    const pending = h.handlers.before_agent_start({}, { cwd: "/repo" });
    await tick();
    h.calls[i].cb(null, '{"result":{"agents":[{"name":"w1","tab_id":"tab","agent_status":"done"}]}}', "");
    const result = await pending;
    assert.equal(result.message.display, false);
    assert.match(result.message.content, /reviewer=fresh/);
    assert.doesNotMatch(result.message.content, /DONE w1/);
    assert.match(result.message.content, /undelivered: none/);
    messages.push(...result.messages.map((message: any) => ({ role: "custom", ...message })));
    messages = h.handlers.context({ messages }).messages;
    const reports = messages.filter(message => message.customType === "swarm-report");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].display, true);
    assert.match(reports[0].content, /DONE w1 \[r:r1 verdict:pass\]: reviewed/);
    assert.equal(messages.filter(message => message.customType === "swarm-state").length, 1);
    assert.equal(h.calls[i].opts.timeout, 10000);
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.events().find(event => event.t === "delivered").via, "report");
  assert.equal(h.input(header).action, "handled");
  const restarted = harness(h.events());
  const pending = restarted.handlers.before_agent_start({}, { cwd: "/repo" });
  await tick();
  restarted.calls[0].cb(null, "{}", ""); await pending;
  assert.equal(restarted.sent.length, 0);
});

test("context_from attaches inline or artifact-path context and errors for missing refs", async () => {
  const h = harness([report()]);
  h.files.set("/run/artifacts/r1.md", "short report");
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const prompt = h.execute("swarm_prompt", { name: "w2", text: "task", context_from: ["w1"] });
  assert.equal(h.calls[0].args[2], "task\n\n## Context from w1 (r:r1)\nshort report");
  h.calls[0].cb(null, "sent", ""); await prompt;
  h.files.set("/run/artifacts/r1.md", "x".repeat(6001));
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const spawn = h.execute("swarm_spawn", { type: "impl-pro", task: "task", context_from: ["r:r1"], wait: true });
  await tick();
  assert.match(h.calls[1].args.at(-1)!, /Full report \(6001 chars\): \/run\/artifacts\/r1.md/);
  h.calls[1].cb(null, "spawned w2 (impl-pro)\n", ""); await tick();
  assert.equal(h.events().at(-1).t, "spawn");
  h.calls[2].cb(null, "=== w2: done\nDONE w2 [r:r2]: done", ""); await spawn;
  assert.equal(h.events().at(-1).via, "wait");
  await assert.rejects(h.execute("swarm_prompt", { name: "w2", text: "task", context_from: ["missing"] }), /no report/);
});

test("context keeps only the latest hidden state, without dropping other messages", () => {
  const h = harness();
  const messages = [{ role: "user", content: "hi" }, { role: "custom", customType: "swarm-state", content: "old" }, { role: "custom", customType: "other" }, { role: "custom", customType: "swarm-state", content: "new" }];
  const result = h.handlers.context({ messages }).messages;
  assert.equal(result.length, 3);
  assert.equal(result.at(-1).content, "new");
  assert.equal(result[1].customType, "other");
});

test("epoch starts ignore reports/extensions, preserve active work, and allow explicit new goals", async () => {
  const h = harness();
  h.input(header); h.input("injected", "extension");
  assert.equal(h.events().filter(event => event.t === "epoch").length, 0);
  h.input("first goal", "interactive");
  assert.equal(h.events().at(-1).n, 1);
  const spawn = h.execute("swarm_spawn", { type: "researcher", task: "research" });
  await tick(); h.calls[0].cb(null, "spawned w1 (researcher)", ""); await spawn;
  assert.equal(h.events().at(-1).epoch, 1);
  h.input("follow up", "interactive");
  assert.equal(h.events().filter(event => event.t === "epoch").length, 1);
  await h.commands["swarm-goal"].handler("new goal");
  assert.equal(h.events().at(-1).n, 2);
  assert.equal(h.events().at(-1).goal, "new goal");
});

test("report reading is head-truncated and requires exactly one selector", async () => {
  const h = harness();
  h.files.set("/run/artifacts/r1.md", "head" + "x".repeat(20000) + "tail");
  const result = await h.execute("swarm_read", { report: "r:r1" });
  assert.equal(result.content[0].text.length, 20000);
  assert.ok(result.content[0].text.startsWith("head"));
  for (const params of [{}, { name: "w1", report: "r1" }, { report: "../escape" }]) await assert.rejects(h.execute("swarm_read", params));
});

test("missing run directory preserves legacy wait and inbox behavior", async () => {
  const h = harness([], { SWARM_RUN_DIR: "" });
  const pending = h.execute("swarm_wait", { names: ["w1"] });
  assert.equal(h.input(header).action, "continue");
  h.calls[0].cb(null, header, ""); await pending;
  assert.equal(h.input(header).action, "continue");
  assert.equal(await h.handlers.before_agent_start({}, { cwd: "/repo" }), undefined);
  assert.equal(h.events().length, 0);
  const spawn = h.execute("swarm_spawn", { type: "impl-pro", task: "legacy edit" });
  await tick(); h.calls[1].cb(null, "spawned legacy (impl-pro)", ""); await spawn;
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  assert.match((await h.execute("swarm_plan", { action: "status" })).content[0].text, /T1 approved/);
  assert.equal(h.files.has("/run/plan.json"), false);
});

test("state failures produce a hidden one-line diagnostic", async () => {
  const h = harness();
  const pending = h.handlers.before_agent_start({}, { cwd: "/repo" });
  await tick();
  h.calls[0].cb(new Error("failed\nsecond line"), "", "");
  const result = await pending;
  assert.match(result.message.content, /^state unavailable: /);
  assert.doesNotMatch(result.message.content, /\n/);
});

test("dialog helper clears blocking on rejection and schedules unref recovery", async () => {
  const h = harness();
  let replays = 0;
  // Use the exported factory directly with an IO-free replay to inspect timing.
  const context: any = { setTimeout: (fn: Function, ms: number) => { h.timers.push({ fn, ms, unref: false }); return { unref: () => { h.timers.at(-1)!.unref = true; } }; } };
  runInNewContext(source.slice(source.indexOf("function createDialogHelper"), source.indexOf("globalThis.install")), context);
  const dialog = context.createDialogHelper({ events: { emit: (_name: string, payload: any) => h.blocked.push(payload) } }, () => { replays++; });
  await assert.rejects(dialog("approve", async () => { throw new Error("dismissed"); }), /dismissed/);
  assert.equal(h.blocked[0].active, true); assert.equal(h.blocked[1].active, false);
  assert.equal(replays, 1);
  assert.equal(h.timers[0].ms, 65000); assert.equal(h.timers[0].unref, true);
  h.timers[0].fn(); assert.equal(replays, 2);
});

test("plans validate, tier 0 is silent, tier 1 notifies, and types are cached", async () => {
  const h = harness();
  await assert.rejects(h.execute("swarm_plan", { action: "propose", plan: { ...smallPlan(), stages: [] } }), /no stages/);
  const readOnly = { ...smallPlan(), stages: [{ id: "research", steps: [{ id: "r", type: "researcher", brief: "Explore" }] }] };
  await h.execute("swarm_plan", { action: "propose", plan: readOnly });
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).tier, 0);
  assert.equal(h.uiCalls.filter(call => call.kind === "notify").length, 0);
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).status, "approved");
  assert.equal(h.uiCalls.filter(call => call.kind === "notify").length, 1);
  assert.equal(h.uiCalls.filter(call => call.kind === "select").length, 0);
  assert.equal(h.uiCalls.filter(call => call.kind === "types").length, 1);
  assert.equal([...h.files.keys()].some(path => path.endsWith(".tmp")), false);
  assert.ok(h.uiCalls.some(call => call.kind === "setStatus" && call.args[1] === "T1 approved"));
});

test("tier 2 requires current-goal research and UI", async () => {
  const h = harness();
  await assert.rejects(h.execute("swarm_plan", { action: "propose", plan: bigPlan() }), /Tier-2 plan needs a planner or researcher report/);
  assert.equal(h.uiCalls.some(call => call.kind === "select"), false);
  const stale = harness([research()]);
  stale.advance(1000); stale.input("new goal", "interactive");
  await assert.rejects(stale.execute("swarm_plan", { action: "propose", plan: bigPlan() }), /in this goal first/);
  const noUI = harness([research()]); noUI.ctx.hasUI = false;
  await assert.rejects(noUI.execute("swarm_plan", { action: "propose", plan: bigPlan() }), /requires a UI/);
});

test("tier 2 timeout auto-runs, but publish needs an explicit choice", async () => {
  const h = harness([research()]);
  h.choices.select = (_title: string, _options: string[], opts: any) => {
    assert.equal(opts.signal.aborted, false);
    h.timers.find(timer => timer.ms === 90000)!.fn();
    assert.equal(opts.signal.aborted, true);
    return undefined;
  };
  await h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  const record = JSON.parse(h.files.get("/run/plan.json")!);
  assert.equal(record.status, "approved"); assert.equal(record.via, "auto");
  const select = h.uiCalls.find(call => call.kind === "select")!;
  assert.ok(select.args[2].signal); assert.match(select.args[0], /auto-runs in 90s/);
  assert.deepEqual(h.blocked.map(event => event.active), [true, false]);
  const publish = harness([research()]);
  publish.choices.select = () => { publish.advance(90000); return undefined; };
  const result = await publish.execute("swarm_plan", { action: "propose", plan: bigPlan(true) });
  const call = publish.uiCalls.find(call => call.kind === "select")!;
  assert.equal(Object.keys(call.args[2]).length, 0); assert.match(call.args[0], /needs your decision/);
  assert.match(result.content[0].text, /NOT APPROVED/);
  assert.equal(JSON.parse(publish.files.get("/run/plan.json")!).status, "revise");
});

test("Esc gates spawning and lint choice applies its plan transformation", async () => {
  const h = harness([research()]); h.choices.select = undefined;
  const result = await h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  assert.match(result.content[0].text, /ask the user in one line; do not spawn makers/);
  await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "edit" }), /call swarm_plan first/);
  h.choices.select = (_title: string, options: string[]) => options.find(option => option.startsWith("Apply: add reviewer stage"));
  await h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  const saved = JSON.parse(h.files.get("/run/plan.json")!);
  assert.equal(saved.status, "approved"); assert.equal(saved.plan.stages[1].steps[0].type, "reviewer");
  assert.deepEqual(h.blocked.map(event => event.active), [true, false, true, false]);
});

test("suggestions and editor outcomes preserve explicit approval state", async () => {
  const h = harness([research()]);
  const plan = { ...bigPlan(), suggestions: ["Use a serial workflow"] };
  h.choices.select = "Suggestion: Use a serial workflow";
  const suggestion = await h.execute("swarm_plan", { action: "propose", plan });
  assert.match(suggestion.content[0].text, /NOT APPROVED. User feedback: Use a serial workflow; revise and propose again/);
  h.choices.select = "Change…"; h.choices.editor = JSON.stringify(smallPlan());
  await h.execute("swarm_plan", { action: "propose", plan });
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).via, "user-edited");
  const editor = h.uiCalls.find(call => call.kind === "editor")!;
  assert.equal(JSON.parse(editor.args[1]).goal, plan.goal);
  const invalid = harness([research()]); invalid.choices.select = "Change…"; invalid.choices.editor = "Make it sequential";
  assert.match((await invalid.execute("swarm_plan", { action: "propose", plan })).content[0].text, /User feedback: Make it sequential/);
  assert.equal(JSON.parse(invalid.files.get("/run/plan.json")!).status, "revise");
  invalid.choices.select = "Wrong — I'll describe the workflow"; invalid.choices.editor = "Only do research";
  assert.match((await invalid.execute("swarm_plan", { action: "propose", plan })).content[0].text, /Only do research/);
  assert.equal(JSON.parse(invalid.files.get("/run/plan.json")!).status, "rejected");
  assert.deepEqual(invalid.blocked.map(event => event.active), [true, false, true, false]);
});

test("amend loosen confirms without timeout, decline retains old, tighten only notifies", async () => {
  const h = harness();
  const original = { ...smallPlan(), require: ["reviewer"] };
  await h.execute("swarm_plan", { action: "propose", plan: original });
  const previous = h.files.get("/run/plan.json");
  h.choices.confirm = false;
  const declined = await h.execute("swarm_plan", { action: "amend", plan: smallPlan() });
  assert.match(declined.content[0].text, /keeping the old plan/);
  assert.equal(h.files.get("/run/plan.json"), previous);
  assert.equal(h.uiCalls.find(call => call.kind === "confirm")!.args.length, 2);
  h.choices.confirm = true;
  await h.execute("swarm_plan", { action: "amend", plan: smallPlan() });
  assert.deepEqual(JSON.parse(h.files.get("/run/policy.json")!).require, []);
  const dialogs = h.blocked.length;
  await h.execute("swarm_plan", { action: "amend", plan: { ...smallPlan(), require: ["tester"] } });
  assert.equal(h.blocked.length, dialogs);
  assert.match(h.uiCalls.filter(call => call.kind === "notify").at(-1)!.args[0], /Added required role tester/);
  assert.deepEqual(h.blocked.map(event => event.active), [true, false, true, false]);
});

test("policy require is additive and propose of unfinished plan is an amendment", async () => {
  const h = harness(); h.files.set("/run/policy.json", JSON.stringify({ require: ["reviewer"] }));
  await h.execute("swarm_plan", { action: "propose", plan: { ...smallPlan(), require: ["tester"] } });
  assert.deepEqual(JSON.parse(h.files.get("/run/policy.json")!).require, ["reviewer", "tester"]);
  h.choices.confirm = false;
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  assert.equal(h.uiCalls.filter(call => call.kind === "confirm").length, 1);
  assert.deepEqual(JSON.parse(h.files.get("/run/plan.json")!).plan.require, ["tester"]);
  const status = await h.execute("swarm_plan", { action: "status" });
  assert.match(status.content[0].text, /impl.*pending/); assert.match(status.content[0].text, /gates:/);
});

test("makers and edit-tests require a plan; read-only types do not", async () => {
  const h = harness();
  for (const type of ["impl-pro", "tester"]) await assert.rejects(h.execute("swarm_spawn", { type, task: "work" }), /call swarm_plan first/);
  for (const type of ["researcher", "planner", "reviewer"]) {
    const pending = h.execute("swarm_spawn", { type, task: "work" });
    await tick(); h.calls.at(-1)!.cb(null, `spawned ${type} (${type})`, ""); await pending;
  }
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const pending = h.execute("swarm_spawn", { type: "impl", task: "edit", step: "impl" });
  await tick();
  assert.equal(h.calls.at(-1)!.args[h.calls.at(-1)!.args.indexOf("--scope") + 1], "src/a.ts");
  h.calls.at(-1)!.cb(null, "spawned maker (impl)", ""); await pending;
  assert.equal(h.events().at(-1).step, "impl");
  await assert.rejects(h.execute("swarm_spawn", { type: "tester", task: "test" }), /swarm_plan amend to add a tester step/);
  await assert.rejects(h.execute("swarm_spawn", { type: "reviewer", task: "review", step: "impl" }), /Invalid plan step/);
});

test("report updates widget, hidden steps, and completed plan permits a new epoch", async () => {
  const h = harness(); h.input("goal", "interactive");
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const pending = h.execute("swarm_spawn", { type: "impl-pro", task: "edit" });
  await tick(); h.calls[0].cb(null, "spawned w1 (impl-pro)", ""); await pending;
  h.files.set("/run/events.jsonl", h.files.get("/run/events.jsonl")! + JSON.stringify(reportEvent({ id: "done", worker: "w1", role: "impl-pro", kind: "DONE", artifact: "artifacts/done.md", ts: Date.now() + 1 })) + "\n");
  h.input("DONE w1 [r:done]: finished");
  assert.match(h.uiCalls.filter(call => call.kind === "setWidget").at(-1)!.args[1][1], /impl=done/);
  const before = h.handlers.before_agent_start({}); await tick(); h.calls[1].cb(null, "{}", "");
  assert.match((await before).message.content, /plan: approved\nsteps: impl=done/);
  h.input("next goal", "interactive");
  assert.equal(h.events().at(-1).n, 2);
  await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "edit" }), /call swarm_plan first/);
});

test("amend escalation repeats Tier-2 gating and edits cannot bypass maker step compatibility", async () => {
  const h = harness();
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  await assert.rejects(h.execute("swarm_plan", { action: "amend", plan: bigPlan() }), /Tier-2 plan needs/);
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).tier, 1);
  h.files.set("/run/events.jsonl", h.files.get("/run/events.jsonl")! + JSON.stringify(research()) + "\n");
  await h.execute("swarm_plan", { action: "amend", plan: bigPlan() });
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).tier, 2);
  assert.deepEqual(h.blocked.map(event => event.active), [true, false]);
  await assert.rejects(h.execute("swarm_spawn", { type: "tester", step: "impl", task: "test" }), /Invalid plan step/);
});

test("approval for an old epoch never authorizes the new goal", async () => {
  const h = harness([research()]);
  let choose: Function;
  h.choices.select = () => new Promise(resolve => { choose = resolve; });
  const pending = h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  await tick();
  await h.commands["swarm-goal"].handler("different goal");
  choose!("Run this plan");
  await assert.rejects(pending, /Goal changed during approval/);
  await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "edit" }), /call swarm_plan first/);
  assert.deepEqual(h.blocked.map(event => event.active), [true, false]);
});

test("parallel spawns assign distinct pending steps and honor narrowed file scopes", async () => {
  const h = harness([research()]);
  const plan = { ...bigPlan(), stages: [{ id: "build", steps: bigPlan().stages[0].steps.map(step => ({ ...step, type: "impl-pro" })) }] };
  await h.execute("swarm_plan", { action: "propose", plan });
  const first = h.execute("swarm_spawn", { type: "impl-pro", task: "first" });
  const second = h.execute("swarm_spawn", { type: "impl-pro", task: "second", files: ["src/b.ts"] });
  await tick(); h.calls[0].cb(null, "spawned first (impl-pro)", ""); await first;
  await tick(); assert.ok(h.calls[1].args.includes("src/b.ts"));
  h.calls[1].cb(null, "spawned second (impl-pro)", ""); await second;
  assert.deepEqual(h.events().filter(event => event.t === "spawn").map(event => event.step), ["impl", "impl2"]);
});

test("type discovery retries failures, ignores caller aborts, and refreshes unknown types", async () => {
  const h = harness();
  h.choices.types = new Error("temporary types failure");
  await assert.rejects(h.execute("swarm_spawn", { type: "researcher", task: "research" }), /temporary types failure/);
  h.choices.types = types;
  const controller = new AbortController(); controller.abort();
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() }, controller.signal);
  assert.equal(h.uiCalls.filter(call => call.kind === "types").at(-1)!.args[0].signal, undefined);
  h.choices.types = [...types, { type: "new-reader", caps: [], verdict: false }];
  const pending = h.execute("swarm_spawn", { type: "new-reader", task: "read" });
  await tick(); h.calls[0].cb(null, "spawned new (new-reader)", ""); await pending;
  await assert.rejects(h.execute("swarm_spawn", { type: "absent", task: "read" }), /Unknown type: absent/);
  assert.equal(h.uiCalls.filter(call => call.kind === "types").length, 4);
});

test("maker follow-ups require approval and the latest spawn in the current epoch", async () => {
  const h = harness();
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const spawn = h.execute("swarm_spawn", { type: "impl-pro", task: "edit" });
  await tick(); h.calls[0].cb(null, "spawned maker (impl-pro)", ""); await spawn;
  const followup = h.execute("swarm_prompt", { name: "maker", text: "answer to QUESTION" });
  await tick(); h.calls[1].cb(null, "prompted", ""); await followup;
  await h.commands["swarm-goal"].handler("new goal");
  await assert.rejects(h.execute("swarm_prompt", { name: "maker", text: "edit again" }), /call swarm_plan first/);
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  await assert.rejects(h.execute("swarm_prompt", { name: "maker", text: "edit again" }), /re-spawn in the current goal/);
  const respawn = h.execute("swarm_spawn", { type: "impl-pro", task: "edit" });
  await tick(); h.calls[2].cb(null, "spawned maker (impl-pro)", ""); await respawn;
  const current = h.execute("swarm_prompt", { name: "maker", text: "continue" });
  await tick(); h.calls[3].cb(null, "prompted", ""); await current;
});

test("plan scopes reject widening and empty overrides but cover real directories without slashes", async () => {
  const h = harness();
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  for (const files of [["other.ts"], [], ["src/a.ts/child"], ["src/../other.ts"]]) {
    await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "edit", files }), /within the plan step files/);
  }
  await assert.rejects(h.execute("swarm_plan", { action: "amend", plan: { ...smallPlan(), stages: [{ id: "build", steps: [{ ...smallPlan().stages[0].steps[0], files: [] }] }] } }), /Empty files/);
  for (const scope of ["src", "src/"]) {
    await h.execute("swarm_plan", { action: "amend", plan: { ...smallPlan(), stages: [{ id: "build", steps: [{ ...smallPlan().stages[0].steps[0], files: [scope] }] }] } });
    const pending = h.execute("swarm_spawn", { type: "impl-pro", task: "edit", files: ["src/nested/a.ts"] });
    await tick(); h.calls.at(-1)!.cb(null, "spawned scoped (impl-pro)", ""); await pending;
    await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "edit", files: ["src-other/a.ts"] }), /within the plan step files/);
  }
});

test("Tier-2 maker changes require a new decision even when the replacement is Tier 1", async () => {
  const h = harness([research()]);
  await h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  h.choices.select = undefined;
  const result = await h.execute("swarm_plan", { action: "amend", plan: smallPlan() });
  assert.match(result.content[0].text, /NOT APPROVED/);
  assert.equal(h.uiCalls.filter(call => call.kind === "select").length, 2);
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).status, "approved");
  assert.equal(JSON.parse(h.files.get("/run/plan.json")!).tier, 2);
});

test("confirmed loosening preserves policy roles not removed from the old plan", async () => {
  const h = harness();
  h.files.set("/run/policy.json", JSON.stringify({ require: ["reviewer", "tester"], custom: "preserve" }));
  await h.execute("swarm_plan", { action: "propose", plan: { ...smallPlan(), require: ["reviewer"] } });
  await h.execute("swarm_plan", { action: "amend", plan: smallPlan() });
  assert.deepEqual(JSON.parse(h.files.get("/run/policy.json")!), { require: ["tester"], custom: "preserve" });
});

test("github-capability publishing cannot auto-approve even with publish false", async () => {
  const h = harness([research()]); h.choices.select = undefined;
  const plan = { ...smallPlan(), publish: false, stages: [{ id: "publish", steps: [{ id: "push", type: "github", brief: "Push" }] }] };
  assert.match((await h.execute("swarm_plan", { action: "propose", plan })).content[0].text, /NOT APPROVED/);
  assert.equal(h.timers.some(timer => timer.ms === 90000), false);
  assert.match(h.uiCalls.find(call => call.kind === "select")!.args[0], /needs your decision/);
});

test("elapsed time alone does not turn dismissal into approval", async () => {
  const h = harness([research()]);
  h.choices.select = () => { h.advance(90000); return undefined; };
  assert.match((await h.execute("swarm_plan", { action: "propose", plan: bigPlan() })).content[0].text, /NOT APPROVED/);
});

test("replay failures cannot replace approved results or escape the recovery timer", async () => {
  const h = harness([research(), report(), { t: "undelivered", id: "r1" }]);
  // Missing artifact makes both immediate and timer replay throw internally.
  assert.match((await h.execute("swarm_plan", { action: "propose", plan: bigPlan() })).content[0].text, /APPROVED/);
  assert.doesNotThrow(() => h.timers.find(timer => timer.ms === 65000)!.fn());
  assert.equal(h.events().some(event => event.t === "delivered"), false);
});

test("released reports are acknowledged only on input, and failed sends stay pending", async () => {
  const h = harness([research(), report(), { t: "undelivered", id: "r1" }]);
  h.files.set("/run/artifacts/r1.md", "reviewed"); h.choices.sendError = new Error("send failed");
  await h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  assert.equal(h.events().some(event => event.t === "delivered"), false);
  h.choices.sendError = undefined;
  const timer = h.timers.find(timer => timer.ms === 65000)!;
  timer.fn(); timer.fn();
  assert.equal(h.sent.length, 1);
  assert.equal(h.events().some(event => event.t === "delivered"), false);
  h.input(header, "extension");
  assert.equal(h.events().find(event => event.t === "delivered").via, "inbox");
});

test("prompt-start replay is bounded, never sends a nested prompt, and survives list failure", async () => {
  const h = harness([report(), { t: "undelivered", id: "r1" }]);
  h.files.set("/run/artifacts/r1.md", "head" + "x".repeat(40000) + "tail");
  const pending = h.handlers.before_agent_start({});
  await tick();
  h.calls[0].cb(new Error("list failed"), "", "");
  const result = await pending;
  const injected = result.messages.find((message: any) => message.customType === "swarm-report");
  assert.match(injected.content, /DONE w1 \[r:r1 verdict:pass\]: head/);
  assert.match(injected.content, /truncated — use swarm_read/);
  assert.doesNotMatch(injected.content, /tail/);
  assert.ok(injected.content.length < 21000);
  assert.match(result.message.content, /state unavailable/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.events().find(event => event.t === "delivered").via, "report");
});

test("missing report artifacts yield persistent pointers without preventing later reports", async () => {
  const second = reportEvent({ ...report(), id: "r2", worker: "w2", artifact: "artifacts/r2.md" });
  const h = harness([report(), second, { t: "undelivered", id: "r1" }, { t: "undelivered", id: "r2" }]);
  h.files.set("/run/artifacts/r2.md", "available");
  const pending = h.handlers.before_agent_start({});
  await tick(); h.calls[0].cb(null, "{}", "");
  const result = await pending;
  const injected = result.messages.find((message: any) => message.customType === "swarm-report");
  assert.match(injected.content, /report r:r1 \(artifact unavailable\)/);
  assert.match(injected.content, /DONE w2 \[r:r2 verdict:pass\]: available/);
  assert.doesNotMatch(result.message.content, /state unavailable/);
  assert.match(result.message.content, /undelivered: none/);
});

test("Tier-2 re-asks preserve the approved plan during and after every non-approval", async () => {
  for (const outcome of ["dismiss", "suggestion", "wrong", "invalid", "select-error", "editor-error"]) {
    const h = harness([research()]);
    await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
    const original = h.files.get("/run/plan.json");
    const originalPolicy = h.files.get("/run/policy.json");
    const spawn = h.execute("swarm_spawn", { type: "impl-pro", task: "edit" });
    await tick(); h.calls.at(-1)!.cb(null, "spawned maker (impl-pro)", ""); await spawn;
    let choose: Function;
    h.choices.select = () => new Promise(resolve => { choose = resolve; });
    const pending = h.execute("swarm_plan", { action: "amend", plan: { ...bigPlan(), suggestions: ["Serial"] } });
    await tick();
    assert.equal(h.files.get("/run/plan.json"), original);
    const answer = h.execute("swarm_prompt", { name: "maker", text: "Answer to QUESTION" });
    await tick(); h.calls.at(-1)!.cb(null, "prompted", ""); await answer;
    if (outcome === "select-error") {
      choose!(undefined);
      await pending;
      h.choices.select = () => { throw new Error("UI failed"); };
      await assert.rejects(h.execute("swarm_plan", { action: "amend", plan: bigPlan() }), /UI failed/);
    } else {
      h.choices.editor = outcome === "editor-error" ? () => { throw new Error("UI failed"); } : "not JSON";
      choose!(outcome === "suggestion" ? "Suggestion: Serial" : outcome === "wrong" ? "Wrong — I'll describe the workflow" : ["invalid", "editor-error"].includes(outcome) ? "Change…" : undefined);
      if (outcome === "editor-error") await assert.rejects(pending, /UI failed/);
      else assert.match((await pending).content[0].text, /NOT APPROVED/);
    }
    assert.equal(h.files.get("/run/plan.json"), original);
    assert.equal(h.files.get("/run/policy.json"), originalPolicy);
    const extra = h.execute("swarm_spawn", { type: "impl-pro", task: "Continue approved step", step: "impl" });
    await tick(); h.calls.at(-1)!.cb(null, "spawned extra (impl-pro)", ""); await extra;
  }
});

test("unknown prompt targets require an approved current-epoch plan", async () => {
  const h = harness();
  await assert.rejects(h.execute("swarm_prompt", { name: "alias", text: "edit" }), /call swarm_plan first for unknown targets/);
  assert.equal(h.calls.length, 0);
  const reader = h.execute("swarm_spawn", { type: "reviewer", task: "Review" });
  await tick(); h.calls[0].cb(null, "spawned reader (reviewer)", ""); await reader;
  const followup = h.execute("swarm_prompt", { name: "reader", text: "Read again" });
  await tick();
  h.calls[1].cb(null, "prompted", ""); await followup;
  await h.execute("swarm_plan", { action: "propose", plan: smallPlan() });
  const alias = h.execute("swarm_prompt", { name: "alias", text: "edit" });
  h.calls[2].cb(null, "prompted", ""); await alias;
  await h.commands["swarm-goal"].handler("new");
  await assert.rejects(h.execute("swarm_prompt", { name: "alias", text: "edit" }), /call swarm_plan first/);
});

test("agent_end makes dropped queued reports eligible for prompt-start replay", async () => {
  const h = harness([research(), report(), { t: "undelivered", id: "r1" }]);
  h.files.set("/run/artifacts/r1.md", "reviewed");
  await h.execute("swarm_plan", { action: "propose", plan: bigPlan() });
  assert.equal(h.sent.length, 1);
  h.handlers.agent_end({ messages: [] });
  const pending = h.handlers.before_agent_start({});
  await tick(); h.calls[0].cb(null, "{}", "");
  const result = await pending;
  assert.match(result.messages[0].content, /DONE w1 \[r:r1 verdict:pass\]: reviewed/);
  assert.equal(h.events().filter(event => event.t === "delivered").length, 1);
});

test("all explicit and plan file scopes stay inside project or tmp", async () => {
  const h = harness();
  for (const files of [["../outside"], ["/repo-other/a"], ["/etc/passwd"], ["/tmp/../outside"]]) {
    await assert.rejects(h.execute("swarm_spawn", { type: "reviewer", task: "Review", files }), /inside the project or tmp/);
  }
  const outside = { ...smallPlan(), stages: [{ id: "build", steps: [{ ...smallPlan().stages[0].steps[0], files: ["/outside/"] }] }] };
  await h.execute("swarm_plan", { action: "propose", plan: outside });
  await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "Edit" }), /inside the project or tmp/);
  await assert.rejects(h.execute("swarm_spawn", { type: "impl-pro", task: "Edit", files: ["/outside/a"] }), /inside the project or tmp/);
  assert.equal(h.calls.length, 0);
  const pending = h.execute("swarm_spawn", { type: "reviewer", task: "Review", files: ["src", "/tmp/report", "/private/tmp/report"] });
  await tick(); h.calls[0].cb(null, "spawned reader (reviewer)", ""); await pending;
});

test("select/editor/confirm exceptions always clear herdr blocking", async () => {
  for (const dialog of ["select", "editor", "confirm"]) {
    const h = harness([research()]);
    h.choices[dialog] = () => { throw new Error("UI failed"); };
    let plan: any = bigPlan();
    if (dialog === "editor") h.choices.select = "Change…";
    if (dialog === "confirm") {
      await h.execute("swarm_plan", { action: "propose", plan: { ...smallPlan(), require: ["reviewer"] } });
      plan = smallPlan();
    }
    await assert.rejects(h.execute("swarm_plan", { action: dialog === "confirm" ? "amend" : "propose", plan }), /UI failed/);
    assert.deepEqual(h.blocked.map(event => event.active), [true, false]);
  }
});
