import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { reportEvent } from "../extensions/swarm-run.ts";
import {
  parseReportHeader, reportIdsIn, formatReport, artifactPath, contextSection,
  pendingUndelivered, replayRunState, shouldStartEpoch, hasResearch,
  parseLiveWorkers, gateStates, nextHint, renderState, keepLatestState,
} from "../extensions/swarm-state.ts";
import type { StateView } from "../extensions/swarm-state.ts";

const report = (id = "a", overrides = {}) => reportEvent({
  id, ts: 10, worker: "w1", role: "reviewer", kind: "DONE", verdict: "pass", tree: "tree",
  artifact: `artifacts/${id}.md`, ...overrides,
});
const view = (overrides: Partial<StateView> = {}): StateView => ({ goal: "ship", workers: [], gates: {}, undelivered: [], ...overrides });

test("parseReportHeader recognizes legacy and current guard headers", () => {
  assert.deepEqual(parseReportHeader("DONE w1: all good"), { kind: "DONE", worker: "w1" });
  assert.deepEqual(parseReportHeader("QUESTION w-1 [r:a-1]: why?"), { kind: "QUESTION", worker: "w-1", id: "a-1" });
  for (const verdict of ["pass", "fail"] as const) {
    assert.deepEqual(parseReportHeader(`HANDOFF w1 [r:a verdict:${verdict}]: ask github`), { kind: "HANDOFF", worker: "w1", id: "a", verdict });
  }
  for (const text of ["", " DONE w1: ok", "note DONE w1: ok", "done w1: ok", "DONE w1", "DONE w1 [r:]: ok", "DONE w1 [r:a b]: ok", "DONE w1 [r:a verdict:maybe]: ok", "DONE w1 [verdict:pass]: ok", "DONE w1 [r:a] ok"]) {
    assert.equal(parseReportHeader(text), undefined, text);
  }
});

test("reportIdsIn only reads genuine report headers, never artifact or pane text", () => {
  assert.deepEqual(reportIdsIn("=== w1: done\r\nDONE w1 [r:a]:\r\nDONE w2 [r:quoted]: inside artifact\n=== w2: blocked\n(blocked: it is showing a question/approval UI — read it and tell the user)\nQUESTION w2 [r:b verdict:fail]:\nHANDOFF w2 [r:quoted2]: pane text\n=== w3: idle\n(no report since the prompt)\nDONE w3 [r:pane]: pane text\n=== w4: TIMEOUT after 0ms (still working)\nDONE w4 [r:timeout]: fake"), ["a", "b"]);
  assert.deepEqual(reportIdsIn("noise\nDONE w1 [r:fake]: pane"), []);
  assert.deepEqual(reportIdsIn("=== w1: done\nDONE other [r:fake]: mismatch"), []);
  assert.deepEqual(reportIdsIn("DONE w1 [r:a]: pane text\nDONE w2 [r:fake]: quoted"), []);
  assert.deepEqual(reportIdsIn(""), []);
});

test("formatReport matches guard formatting, including absent metadata and multiline messages", () => {
  assert.equal(formatReport(report(), "one\ntwo"), "DONE w1 [r:a verdict:pass]: one\ntwo");
  assert.equal(formatReport({ kind: "QUESTION", worker: "w2" }, "why?"), "QUESTION w2: why?");
  assert.equal(formatReport({ kind: "HANDOFF", worker: "w2", id: "b", verdict: null }, "help"), "HANDOFF w2 [r:b]: help");
  assert.equal(formatReport({ kind: "DONE", worker: "w2", verdict: "fail" }, "bad"), "DONE w2 [verdict:fail]: bad");
  assert.deepEqual(parseReportHeader(formatReport(report(), "ok")), { kind: "DONE", worker: "w1", id: "a", verdict: "pass" });
});

test("artifactPath resolves safe ids and rejects malformed ids and traversal refs", () => {
  assert.equal(artifactPath("./run", "r:a-1_2.md"), resolve("run/artifacts/a-1_2.md.md"));
  assert.equal(artifactPath("./run", "a"), resolve("run/artifacts/a.md"));
  for (const ref of ["", "r:", "../secret", "r:../secret", "r:/tmp/secret", "r:..\\secret", "r:a/b", "r:a b", "r:a\n", "r:a]", "r:%2e%2e%2fsecret", "r:r:a", "r:a\0"]) {
    assert.throws(() => artifactPath("/run", ref), /invalid report id/, ref);
  }
  for (const id of [".", "..", "...", "a-b_1.2"]) assert.equal(dirname(artifactPath("/run", id)), "/run/artifacts");
});

test("contextSection selects the latest worker report or an explicit id, ignoring logged artifact paths", () => {
  const first = report("a", { artifact: "../../secret" });
  const second = report("b", { ts: 1, kind: "QUESTION" });
  const events = [null, first, second, report("other", { worker: "w2" })];
  const paths: string[] = [];
  const read = (path: string) => { paths.push(path); return "evidence"; };
  assert.equal(contextSection(events, "w1", read, "/run"), "## Context from w1 (r:b)\nevidence");
  assert.equal(contextSection(events, "r:a", read, "/run"), "## Context from w1 (r:a)\nevidence");
  assert.deepEqual(paths, ["/run/artifacts/b.md", "/run/artifacts/a.md"]);
  for (const ref of ["missing", "r:missing"]) assert.throws(() => contextSection(events, ref, read, "/run"), new RegExp(`no report for ${ref}`));
  assert.throws(() => contextSection(events, "r:../secret", read, "/run"), /invalid report id/);
  assert.throws(() => contextSection([report("../secret")], "w1", read, "/run"), /invalid report id/);
  assert.throws(() => contextSection(events, "w1", () => { throw new Error("read failed"); }, "/run"), /read failed/);
});

test("contextSection uses a read-tool pointer only above the exact inline threshold", () => {
  const events = [report()];
  assert.equal(contextSection(events, "r:a", () => "1234", "/run", 4), "## Context from w1 (r:a)\n1234");
  assert.equal(contextSection(events, "w1", () => "12345", "/run", 4), "## Context from w1 (r:a)\nFull report (5 chars): /run/artifacts/a.md — read it with the read tool.");
  assert.ok(contextSection(events, "w1", () => "x".repeat(6000), "/run").endsWith("x".repeat(6000)));
  assert.match(contextSection(events, "w1", () => "x".repeat(6001), "/run"), /Full report \(6001 chars\)/);
  assert.equal(contextSection(events, "w1", () => "", "/run", 0), "## Context from w1 (r:a)\n");
});

test("pendingUndelivered deduplicates queue markers in order, excludes delivered and unknown ids", () => {
  const a = report("a"), b = report("b"), c = report("c");
  const events = [null, a, b, { t: "undelivered", id: "b" }, { t: "undelivered", id: "unknown" },
    { t: "undelivered", id: "a" }, { t: "undelivered", id: "b" }, c, { t: "undelivered", id: "c" }, { t: "undelivered" }];
  const delivered = new Set(["c"]);
  assert.deepEqual(pendingUndelivered(events, delivered), [b, a]);
  assert.deepEqual([...delivered], ["c"]);
  assert.deepEqual(pendingUndelivered([], new Set()), []);
});

test("replayRunState replays delivery, epoch and spawn events in append order", () => {
  assert.deepEqual(replayRunState([]), { delivered: new Set(), epoch: { n: 0, ts: 0, goal: "" }, spawns: [] });
  const spawn1 = { t: "spawn", ts: 12, worker: "w1", type: "planner", epoch: 1 };
  const spawn2 = { t: "spawn", ts: 5, worker: "w2", type: "impl", step: "s1", epoch: 2 };
  const events = [null, report(), { t: "epoch", n: 1, ts: 10, goal: "first" }, spawn1,
    { t: "delivered", id: "a", via: "prompt" }, { t: "delivered", id: "a", via: "wait" },
    { t: "epoch", n: 2, ts: 1, goal: "last" }, spawn2, { t: "delivered", id: "b", via: "context" },
    { t: "epoch", n: "bad", ts: 99, goal: "bad" }, { t: "delivered", id: null }, { t: "spawn", worker: "bad" }];
  assert.deepEqual(replayRunState(events), { delivered: new Set(["a", "b"]), epoch: { n: 2, ts: 1, goal: "last" }, spawns: [spawn1, spawn2] });
});

test("shouldStartEpoch excludes reports and extension turns and respects unfinished work", () => {
  for (const isReport of [false, true]) for (const source of ["user", "extension", undefined]) {
    for (const spawnsInEpoch of [0, 1, 3]) for (const planDone of [false, true]) {
      assert.equal(shouldStartEpoch({ isReport, source, spawnsInEpoch, planDone }), !isReport && source !== "extension" && (spawnsInEpoch === 0 || planDone));
    }
  }
});

test("hasResearch requires DONE planner/researcher evidence at or after the cutoff", () => {
  for (const role of ["planner", "researcher"]) {
    assert.equal(hasResearch([report("a", { role, ts: 10 })], 10), true);
    assert.equal(hasResearch([report("a", { role, ts: 9 })], 10), false);
    for (const kind of ["QUESTION", "HANDOFF"]) assert.equal(hasResearch([report("a", { role, kind })], 0), false);
  }
  assert.equal(hasResearch([report("planner", { worker: "planner", role: "impl" }), null], 0), false);
  assert.equal(hasResearch([], 0), false);
});

test("parseLiveWorkers uses herdr result.agents, tab scope and orchestrator exclusion", () => {
  const agents = [{ name: "orch", tab_id: "tab1", agent_status: "working" },
    { name: "w1", tab_id: "tab1", agent_status: "blocked", pane_id: "p1", dialog: "approval" },
    { name: "w2", tab_id: "tab2", agent_status: "done" }, { name: null, tab_id: "tab1" }, null];
  const json = JSON.stringify({ result: { agents } });
  assert.deepEqual(parseLiveWorkers(json, "tab1", "orch"), [agents[1]]);
  assert.deepEqual(parseLiveWorkers(json, "", "orch"), [agents[1], agents[2]]);
  assert.deepEqual(parseLiveWorkers(json), agents.slice(0, 3));
  for (const json of ["", "not json", "null", "[]", "{}", '{"result":null}', '{"result":{"agents":{}}}']) assert.deepEqual(parseLiveWorkers(json, "tab1", "orch"), []);
});

test("gateStates maps publishStatus evidence and retains independent role gates", () => {
  assert.deepEqual(gateStates([], [], "tree"), {});
  assert.deepEqual(gateStates([], ["reviewer"], "tree"), { reviewer: "missing" });
  assert.deepEqual(gateStates([report()], ["reviewer", "tester"], "tree"), { reviewer: "fresh", tester: "missing" });
  assert.deepEqual(gateStates([report()], ["reviewer"], "new"), { reviewer: "stale" });
  assert.deepEqual(gateStates([report("a", { verdict: "fail" })], ["reviewer"], "new"), { reviewer: "fail" });
  assert.deepEqual(gateStates([report("a", { tree: null })], ["reviewer"], "tree"), { reviewer: "unknown" });
  assert.deepEqual(gateStates([report()], ["reviewer"]), { reviewer: "unknown" });
  assert.deepEqual(gateStates([report(), report("b", { verdict: "fail" })], ["reviewer"], "tree"), { reviewer: "fail" });
  assert.deepEqual(gateStates([report("a", { role: "impl" })], ["impl"], "tree"), { impl: "missing" });
});

test("nextHint is ordered: revise, dialog, wait, step, review, close, report", () => {
  const workers = [{ name: "idle", agent_status: "idle" }, { name: "done", agent_status: "done" },
    { name: "busy", agent_status: "working" }, { name: "dialog", agent_status: "blocked" }];
  const base = view({ workers, gates: { reviewer: "stale" }, steps: [{ id: "s1", status: "pending", type: "impl" }] });
  for (const status of ["proposed", "revise"]) assert.equal(nextHint({ ...base, plan: { status } }), "revise and call swarm_plan propose");
  assert.equal(nextHint(base), "tell the user about dialog's dialog");
  assert.equal(nextHint({ ...base, workers: workers.slice(0, 3) }), "swarm_wait busy");
  assert.equal(nextHint({ ...base, workers: workers.slice(0, 2) }), "spawn plan step s1 (impl)");
  assert.equal(nextHint({ ...base, workers: workers.slice(0, 2), steps: [] }), "spawn reviewer on the current tree");
  assert.equal(nextHint(view({ gates: { tester: "missing" } })), "spawn reviewer on the current tree");
  assert.equal(nextHint(view({ workers: workers.slice(0, 2), gates: { reviewer: "fresh" } })), "swarm_close idle, done");
  assert.equal(nextHint(view({ gates: { reviewer: "fail", tester: "unknown" } })), "report to the user");
  assert.equal(nextHint(view({ plan: { status: "approved", steps: [{ id: "s2", status: "pending" }] } })), "spawn plan step s2");
  assert.equal(nextHint(view({ workers: [{ name: "one", agent_status: "working" }, { name: "two", agent_status: "working" }] })), "swarm_wait one, two");
});

test("renderState includes concise state and never exceeds line or character limits", () => {
  assert.equal(renderState(view()), "[swarm state — hidden, refreshed each prompt]\ngoal: ship\nlive: none\ngates: none\nundelivered: none\nnext: report to the user");
  const state = renderState(view({ plan: { status: "approved", steps: [{ id: "s1", status: "done" }] },
    workers: [{ name: "w1", agent_status: "idle" }], gates: { reviewer: "fresh" }, undelivered: [report(), "r:b"] }));
  assert.match(state, /plan: approved\nsteps: s1=done\nlive: w1=idle\ngates: reviewer=fresh\nundelivered: r:a, r:b\nnext: swarm_close w1$/);
  const huge = "x".repeat(1000) + "\n\r\u2028\u2029extra";
  const lines = renderState(view({ goal: huge, plan: { status: huge }, steps: [{ id: huge, status: huge }],
    workers: [{ name: huge, agent_status: "working" }], gates: { [huge]: "missing" }, undelivered: [huge] })).split("\n");
  assert.ok(lines.length <= 10);
  assert.equal(lines[0], "[swarm state — hidden, refreshed each prompt]");
  assert.ok(lines.every(line => line.length <= 200 && !/[\r\u2028\u2029]/.test(line)));
  assert.ok(lines.at(-1)?.startsWith("next:"));
  assert.ok(lines[1].endsWith("…"));
});

test("keepLatestState removes only older matching custom messages, preserving order and inputs", () => {
  const messages = [{ role: "custom", customType: "swarm-state", text: "old" }, { role: "user", text: "hello" },
    { role: "custom", customType: "other", text: "other" }, { role: "assistant", customType: "swarm-state", text: "keep" },
    { role: "custom", customType: "swarm-state", text: "new" }, { role: "user", text: "later" }];
  const original = [...messages];
  assert.deepEqual(keepLatestState(messages), messages.slice(1));
  assert.deepEqual(messages, original);
  assert.deepEqual(keepLatestState([]), []);
  assert.deepEqual(keepLatestState(messages, "other"), messages);
  assert.deepEqual(keepLatestState([{ role: "custom" }]), [{ role: "custom" }]);
  assert.deepEqual(keepLatestState([{ role: "custom", customType: "x" }, { role: "user" }, { role: "custom", customType: "x" }], "x"), [{ role: "user" }, { role: "custom", customType: "x" }]);
});
