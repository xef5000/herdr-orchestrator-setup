import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { parsePolicy } from "../extensions/swarm-policy.ts";
import { parseEvents, publishStatus, reportEvent } from "../extensions/swarm-run.ts";

// Evaluate the extension with a minimal API and injected IO: no Pi runtime required.
const source = stripTypeScriptTypes(readFileSync(new URL("../extensions/swarm-guard.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default function", "globalThis.install = function");
function harness(extra: Record<string, string> = {}) {
  const env = { SWARM_ROLE: "reviewer", SWARM_NAME: "r1", SWARM_ORCHESTRATOR: "orch", SWARM_HOME: "/swarm", SWARM_RUN_DIR: "/run", SWARM_VERDICT: "required", ...extra };
  const policy = parsePolicy(env, "/repo")!;
  const files = new Map<string, string>();
  const handlers: Record<string, Function> = {};
  const state = { tree: "tree", calls: 0, delays: 0, errors: [] as string[], failFiles: false, tool: undefined as any, tools: [] as any[], prompts: [] as string[] };
  const context: any = {
    process: { env, cwd: () => "/repo" },
    Type: new Proxy({}, { get: () => (...args: unknown[]) => args }),
    parsePolicy: () => policy, decide: () => ({ action: "allow" }), parseEvents, publishStatus, reportEvent,
    treeFingerprint: () => state.tree, randomBytes: () => ({ toString: () => "abcdef" }), join: (...parts: string[]) => parts.join("/"),
    execFileSync: () => "feature",
    readFileSync: (path: string) => { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); },
    mkdirSync: () => {},
    writeFileSync: (path: string, text: string) => { if (state.failFiles) throw new Error("disk full"); files.set(path, text); },
    appendFileSync: (path: string, text: string) => { if (state.failFiles) throw new Error("disk full"); files.set(path, (files.get(path) ?? "") + text); },
    execFile: (_path: string, args: string[], _opts: unknown, cb: Function) => {
      state.calls++; state.prompts.push(args[3]);
      // Recording must precede delivery.
      if (!state.failFiles && env.SWARM_RUN_DIR) assert.ok(files.get("/run/events.jsonl"));
      const error = state.errors.shift(); cb(error ? new Error(error) : null, "", error ?? "");
    },
    delay: async (ms: number, _value: unknown, opts: { signal?: AbortSignal }) => { assert.equal(ms, 5000); state.delays++; opts.signal?.throwIfAborted(); },
  };
  runInNewContext(source, context);
  context.install({ on: (name: string, fn: Function) => { handlers[name] = fn; }, getAllTools: () => state.tools, registerTool: (tool: any) => { state.tool = tool; } });
  return { policy, files, handlers, state, report: (params: any, signal?: AbortSignal) => state.tool.execute("call", params, signal), events: () => parseEvents(files.get("/run/events.jsonl") ?? "") as any[] };
}

test("guard wires live tool annotations and a default reviewer publish gate", async () => {
  const h = harness();
  assert.equal(h.policy.publishCheck!().ok, false);
  h.state.tools = [{ name: "lookup", annotations: { readOnlyHint: true } }];
  assert.equal(h.policy.toolInfo!("lookup")?.readOnly, true);
  assert.equal(h.policy.toolInfo!("unknown"), undefined);
  h.handlers.before_agent_start();
  const result = await h.report({ kind: "DONE", message: "reviewed", verdict: "pass" });
  assert.equal(result.terminate, true);
  assert.equal(h.policy.publishCheck!().ok, true);
  assert.match(h.state.prompts[0], /^DONE r1 \[r:.* verdict:pass\]: reviewed$/);
  assert.equal(h.files.get("/run/" + h.events()[0].artifact), "reviewed");
  h.state.tree = "changed";
  assert.equal(h.policy.publishCheck!().ok, false);
});

test("required DONE rejects a missing verdict, and mid-review changes invalidate evidence", async () => {
  const h = harness();
  await assert.rejects(h.report({ kind: "DONE", message: "reviewed" }), /DONE from reviewer must include verdict "pass" or "fail"/);
  assert.equal(h.state.calls, 0);
  h.handlers.before_agent_start(); h.state.tree = "changed";
  await h.report({ kind: "DONE", message: "reviewed", verdict: "pass", role: "tester" });
  assert.equal(h.events()[0].tree, null);
  assert.equal(h.events()[0].role, "reviewer");
  assert.equal(h.policy.publishCheck!().ok, false);
});

test("QUESTION and HANDOFF verdict arguments cannot create publish evidence", async () => {
  for (const kind of ["QUESTION", "HANDOFF"]) {
    const h = harness(); h.handlers.before_agent_start();
    await h.report({ kind, message: "not final", verdict: "pass" });
    assert.equal(h.events()[0].verdict, undefined);
    assert.equal(h.policy.publishCheck!().ok, false);
    assert.doesNotMatch(h.state.prompts[0], /verdict:/);
  }
});

test("implementation verdict arguments cannot create verdict evidence", async () => {
  const h = harness({ SWARM_ROLE: "impl-pro", SWARM_VERDICT: "" });
  await h.report({ kind: "DONE", message: "implemented", verdict: "pass", role: "reviewer" });
  assert.equal(h.events()[0].role, "impl-pro");
  assert.equal(h.events()[0].verdict, undefined);
  assert.doesNotMatch(h.state.prompts[0], /verdict:/);
});

test("blocked delivery retries twelve times and records undelivered DONE", async () => {
  const h = harness(); h.handlers.before_agent_start();
  h.state.errors = Array(13).fill("agent_blocked");
  const result = await h.report({ kind: "DONE", message: "reviewed", verdict: "fail" });
  assert.equal(h.state.calls, 13); assert.equal(h.state.delays, 12);
  assert.equal(result.terminate, true);
  assert.match(result.content[0].text, /your report is recorded in the run log/);
  assert.ok(result.content[0].text.includes(`artifact r:${h.events()[0].id}`));
  assert.doesNotMatch(result.content[0].text, /will be delivered/);
  assert.equal(h.events()[1].t, "undelivered");
  assert.equal(h.events()[1].id, h.events()[0].id);
});

test("recording failures are warnings, other prompt failures and aborts throw", async () => {
  const h = harness(); h.state.failFiles = true;
  const result = await h.report({ kind: "HANDOFF", message: "help" });
  assert.match(result.content[0].text, /Report recording error:.*disk full/);
  h.state.errors = ["other failure"];
  await assert.rejects(h.report({ kind: "QUESTION", message: "help" }), /other failure/);
  const controller = new AbortController(); controller.abort();
  const calls = h.state.calls;
  await assert.rejects(h.report({ kind: "QUESTION", message: "help" }, controller.signal), /abort/i);
  assert.equal(h.state.calls, calls);
});

test("custom publish roles are required and missing start evidence stays invalid", async () => {
  const h = harness({ SWARM_PUBLISH_REQUIRE: "reviewer,tester" });
  await h.report({ kind: "DONE", message: "reviewed", verdict: "pass" });
  assert.equal(h.events()[0].tree, null);
  assert.equal(h.policy.publishCheck!().ok, false);
  h.handlers.before_agent_start();
  await h.report({ kind: "DONE", message: "reviewed again", verdict: "pass" });
  assert.match(h.policy.publishCheck!().why, /Missing verdict for required role tester/);
});
