import { test } from "node:test";
import assert from "node:assert/strict";
import { reportEvent } from "../extensions/swarm-run.ts";
import {
  validatePlan, classifyTier, lintPlan, dialogOptions, interpretChoice, classifyAmend,
  renderPlan, stepStatuses, assignStep, planDone, mergeRequire,
} from "../extensions/swarm-plan.ts";
import type { Plan, Step, TypeInfo, SpawnEvent, PlanLint } from "../extensions/swarm-plan.ts";

const types: TypeInfo[] = [
  { type: "planner", caps: [], verdict: false },
  { type: "impl", caps: ["edit"], verdict: false },
  { type: "impl-pro", caps: ["edit"], verdict: false },
  { type: "tester", caps: ["edit-tests"], verdict: true },
  { type: "reviewer", caps: [], verdict: true },
  { type: "audit", caps: [], verdict: true },
  { type: "github", caps: ["github"], verdict: false },
];
const step = (id: string, type = "impl", files?: string[]): Step => ({ id, type, brief: `Do ${id}`, ...(files === undefined ? {} : { files }) });
const plan = (...groups: Step[][]): Plan => ({ goal: "Ship a change", template: "custom", stages: groups.map((steps, i) => ({ id: `stage-${i}`, steps })) });
const spawn = (worker: string, id?: string, ts = 10, type = "impl", epoch = 0): SpawnEvent => ({ t: "spawn", ts, worker, type, step: id, epoch });
const report = (worker: string, kind = "DONE", verdict?: string, ts = 20) => reportEvent({ worker, role: "impl", kind, verdict, ts, artifact: "output" });

// Tests intentionally use large and zero advisory values: no scheduling limits.
test("validatePlan checks structural errors and a shared stage/step id namespace", () => {
  assert.deepEqual(validatePlan(plan([step("a")]), types), []);
  assert.deepEqual(validatePlan({ ...plan([step("a")]), max_rounds: 0 }, types), []);
  assert.deepEqual(validatePlan({ ...plan([step("a")]), max_rounds: 1000000 }, types), []);
  assert.match(validatePlan(plan(), types).join("\n"), /no stages/);
  assert.match(validatePlan(plan([]), types).join("\n"), /no steps/);
  assert.match(validatePlan(plan([step("empty", "impl", [])]), types).join("\n"), /Empty files/);
  const invalid = plan([step("stage-0", "unknown"), step("same")], [step("same")]);
  invalid.stages[1].id = "stage-0";
  invalid.require = ["reviewer", "publisher" as "tester"];
  const errors = validatePlan(invalid, types);
  assert.equal(errors.filter(error => error.includes("Duplicate id")).length, 3);
  assert.match(errors.join("\n"), /Unknown type: unknown/);
  assert.match(errors.join("\n"), /Invalid required role: publisher/);
});

test("classifyTier distinguishes editing tests, makers, parallel stages, and publish", () => {
  assert.equal(classifyTier(plan([step("plan", "planner"), step("r", "reviewer")]), types), 0);
  assert.equal(classifyTier(plan([step("unknown", "absent")]), types), 0);
  assert.equal(classifyTier(plan([step("tests", "tester")]), types), 1);
  assert.equal(classifyTier(plan([step("a")]), types), 1);
  assert.equal(classifyTier(plan([step("a")], [step("b")]), types), 1);
  assert.equal(classifyTier(plan([step("a"), step("b")]), types), 2);
  assert.equal(classifyTier(plan([step("a")], [step("b")], [step("c")]), types), 2);
  assert.equal(classifyTier({ ...plan([step("pr", "github")]), publish: true }, types), 2);
  assert.equal(classifyTier({ ...plan([step("pr", "github")]), publish: false }, types), 2);
  assert.equal(classifyTier({ ...plan([step("a")]), publish: true }, types), 2);
  assert.equal(classifyTier(plan([step("tests", "tester"), step("a")]), types), 1);
});

test("lintPlan adds review after unreviewed makers, purely, with collision-free ids", () => {
  const p = plan([step("review", "planner"), step("a")], [step("reviewer", "planner")]);
  const before = structuredClone(p);
  const lint = lintPlan(p, types).find(lint => lint.text === "Apply: add reviewer stage after stage-0")!;
  assert.ok(lint.apply);
  const applied = lint.apply!(p);
  assert.equal(applied.stages[1].id, "review-2");
  assert.equal(applied.stages[1].steps[0].id, "reviewer-2");
  assert.equal(applied.stages[1].steps[0].type, "reviewer");
  assert.deepEqual(validatePlan(applied, types), []);
  assert.deepEqual(p, before);
  assert.equal(lint.apply!(plan()).stages.length, 0, "stale stage action is harmless");
  assert.equal(lintPlan(plan([step("a")], [step("r", "audit")]), types).length, 0);
  assert.equal(lintPlan(plan([step("r", "audit"), step("a")]), types).length, 0, "same-stage checker runs after makers");
  assert.ok(lintPlan(plan([step("r", "reviewer")], [step("a")]), types).some(l => l.apply));
});

test("lintPlan warns about missing and overlapping parallel scopes without enforcement or apply", () => {
  const scoped = plan([step("a", "impl", ["src/a.ts"]), step("b", "impl", ["src/b.ts"])], [step("r", "reviewer")]);
  assert.deepEqual(lintPlan(scoped, types), []);
  const p = plan([step("a"), step("b", "impl", [])], [step("r", "reviewer")]);
  const missing = lintPlan(p, types);
  assert.equal(missing.length, 1);
  assert.match(missing[0].text, /lack file scopes/);
  assert.equal(missing[0].apply, undefined);
  for (const files of [["src/a.ts", "src/a.ts"], ["src", "src/a.ts"], ["src/**", "src/a.ts"], ["*", "src/a.ts"]]) {
    const overlapping = lintPlan(plan([step("a", "impl", [files[0]]), step("b", "impl", [files[1]])], [step("r", "reviewer")]), types);
    assert.match(overlapping[0].text, /overlapping files/);
    assert.equal(overlapping[0].apply, undefined);
  }
});

test("lintPlan loop fix inserts a checker in the loop even when a later stage checks", () => {
  const p = plan([step("a")], [step("review", "reviewer")]);
  p.stages[0].loop = true;
  const lints = lintPlan(p, types);
  assert.equal(lints.length, 1);
  assert.match(lints[0].text, /reviewer step to loop/);
  const applied = lints[0].apply!(p);
  assert.equal(applied.stages[0].steps[1].id, "review-2");
  assert.equal(applied.stages[0].steps[1].type, "reviewer");
  assert.equal(applied.stages[0].loop, true);
  assert.deepEqual(lintPlan(applied, types), []);
  assert.equal(p.stages[0].steps.length, 1);
});

test("bug plans get a repro tester before the first maker stage, with unique ids", () => {
  const p: Plan = { ...plan([step("repro", "planner")], [step("a")], [step("r", "reviewer")]), template: "bug" };
  const lint = lintPlan(p, types).find(l => l.text.includes("repro tester"))!;
  const next = lint.apply!(p);
  assert.equal(next.stages[1].id, "repro-2");
  assert.equal(next.stages[1].steps[0].type, "tester");
  assert.equal(next.stages[2].steps[0].id, "a");
  assert.deepEqual(validatePlan(next, types), []);
  assert.equal(lintPlan(next, types).some(l => l.text.includes("repro tester")), false);
  const onlyPlan: Plan = { ...plan([step("p", "planner")]), template: "bug" };
  assert.equal(lintPlan(onlyPlan, types)[0].apply!(onlyPlan).stages[0].id, "repro");
  assert.deepEqual(lintPlan({ ...p, template: "feature" }, types), []);
});

test("dialogOptions puts at most three actionable lints/suggestions between fixed choices", () => {
  const p = { ...plan([step("a")]), suggestions: ["one", "two", "three", "four"] };
  const change = (p: Plan) => ({ ...p, goal: "Changed" });
  const lints: PlanLint[] = [{ text: "Warning only" }, { text: "Apply: first", apply: change }, { text: "second", apply: change }];
  const { options, map } = dialogOptions(p, lints);
  assert.deepEqual(options, ["Run this plan", "Apply: first", "Apply: second", "Suggestion: one", "Change…", "Wrong — I'll describe the workflow"]);
  assert.deepEqual(map[options[0]], { kind: "run" });
  assert.deepEqual(map[options[1]], { kind: "lint", lint: lints[1] });
  assert.deepEqual(map[options[3]], { kind: "suggestion", suggestion: "one" });
  assert.deepEqual(map[options[4]], { kind: "change" });
  assert.deepEqual(map[options[5]], { kind: "wrong" });
  assert.equal(dialogOptions(p, [...lints, { text: "third", apply: change }, { text: "fourth", apply: change }]).options.includes("Suggestion: one"), false);
  assert.equal(dialogOptions(p, []).options.length, 6);
  assert.equal(dialogOptions(plan(), []).options.length, 3);
  assert.equal(dialogOptions(p, [lints[1], lints[1]]).options.length, 6, "duplicate labels do not consume extra slots");
});

test("interpretChoice distinguishes timeout, dismissal and all explicit actions", () => {
  const dialog = dialogOptions({ ...plan(), suggestions: ["test it"] }, [{ text: "Apply: add", apply: p => p }]);
  assert.deepEqual(interpretChoice(undefined, true, dialog.map), { kind: "auto" });
  assert.deepEqual(interpretChoice(undefined, false, dialog.map), { kind: "dismissed" });
  assert.deepEqual(interpretChoice(undefined, false, dialog.map), { kind: "dismissed" });
  assert.deepEqual(interpretChoice(undefined, true, dialog.map), { kind: "auto" });
  for (const choice of dialog.options) assert.equal(interpretChoice(choice, true, dialog.map), dialog.map[choice]);
  assert.deepEqual(interpretChoice("unknown", false, dialog.map), { kind: "dismissed" });
  assert.deepEqual(interpretChoice("toString", false, {}), { kind: "dismissed" });
});

test("classifyAmend detects loosening and reapproves changed Tier-2 work", () => {
  const old = { ...plan([step("a", "impl", ["a.ts"]), step("r", "reviewer")]), require: ["reviewer", "tester"] as Plan["require"] };
  old.stages[0].loop = true;
  const next = { ...plan([step("a")]), publish: true, require: ["tester"] as Plan["require"] };
  const amended = classifyAmend(old, next, types);
  assert.deepEqual(amended.loosen, ["Removed required role reviewer", "Stage stage-0 lost loop", "Widened files for step a", "Removed checker step r", "Enabled publish"]);
  assert.equal(amended.reapprove, true);
  assert.equal(classifyAmend(next, { ...next, goal: "Other" }, types).reapprove, true);
  assert.equal(classifyAmend(plan([step("a")]), plan([step("a"), step("b")]), types).reapprove, true);
  assert.equal(classifyAmend(plan([step("a"), step("b")]), plan([step("a")]), types).reapprove, true);
  assert.deepEqual(classifyAmend(old, structuredClone(old), types), { loosen: [], tighten: [], reapprove: false });
  const tier2 = plan([step("a"), step("b")]);
  for (const changed of [
    plan([step("a"), step("b"), step("c")]),
    plan([step("a")]),
    plan([step("a", "impl-pro"), step("b")]),
    plan([{ ...step("a"), brief: "Different work" }, step("b")]),
    { ...tier2, goal: "Different goal" },
  ]) assert.equal(classifyAmend(tier2, changed, types).reapprove, true);
  assert.equal(classifyAmend(tier2, structuredClone(tier2), types).reapprove, false);
  assert.match(classifyAmend(plan([step("r", "audit")]), plan([step("r", "planner")]), types).loosen[0], /Removed checker/);
  assert.ok(classifyAmend(old, plan(), types).loosen.includes("Stage stage-0 lost loop"));
});

test("classifyAmend file widening is subset-based; other edits are described as tightening", () => {
  const p = plan([step("a", "impl", ["a.ts", "b.ts"])]);
  assert.deepEqual(classifyAmend(p, plan([step("a", "impl", ["b.ts"])]), types).loosen, []);
  assert.match(classifyAmend(p, plan([step("a", "impl", ["c.ts"])]), types).loosen[0], /Widened files/);
  assert.match(classifyAmend(p, plan([step("a")]), types).loosen[0], /Widened files/);
  assert.match(classifyAmend(p, plan([step("a", "impl", [])]), types).loosen[0], /Widened files/);
  assert.deepEqual(classifyAmend(plan([step("a")]), p, types).loosen, []);
  const next: Plan = { ...plan([step("a", "impl-pro", ["a.ts"])]), goal: "New", template: "feature", publish: false, max_rounds: 0, suggestions: ["Try this"], require: ["tester"] };
  next.stages[0].loop = true;
  next.stages[0].steps[0].brief = "New brief";
  const changed = classifyAmend({ ...p, publish: true }, next, types);
  assert.deepEqual(changed.loosen, []);
  for (const text of ["Added required role tester", "Added loop", "Changed type", "Changed brief", "Changed files", "Disabled publish", "Changed goal", "Changed template", "advisory max_rounds", "Changed suggestions"]) {
    assert.ok(changed.tighten.some(value => value.includes(text)), text);
  }
  const moved = plan([], [step("a")]);
  assert.ok(classifyAmend(plan([step("a")]), moved, types).tighten.includes("Moved step a"));
  const reordered = plan([step("b"), step("a")]);
  assert.ok(classifyAmend(plan([step("a"), step("b")]), reordered, types).tighten.includes("Changed stage or step order"));
});

test("renderPlan uses execution groups, loops, prefix labels, and explicit required roles", () => {
  const p = plan([step("plan", "planner")], [step("review", "reviewer"), step("impl-a"), step("impl-b")], [step("pr", "github")]);
  p.stages[1].loop = true;
  assert.equal(renderPlan(p, ["reviewer"], types), "plan → ⟳[impl-a ∥ impl-b → review] → pr(github) 🔒reviewer");
  assert.equal(renderPlan(plan([step("test", "tester"), step("audit", "audit")]), ["reviewer", "tester"], types), "test ∥ audit 🔒reviewer,tester");
  assert.equal(renderPlan(plan([step("r", "reviewer")]), [], types), "r");
  assert.equal(renderPlan({ ...plan([step("x", "planner")]), require: ["tester"] }, [], types), "x(planner)");
  assert.equal(renderPlan(plan(), [], types), "");
});

test("stepStatuses tracks pending, running, waiting, done, failed without round limits", () => {
  const p = { ...plan([step("a"), step("b"), step("r", "reviewer"), step("t", "tester"), step("custom", "audit"), step("pending")]), max_rounds: 0 };
  const spawns = [spawn("w1", "a"), spawn("w2", "b"), spawn("w3", "r"), spawn("w4", "t"), spawn("w5", "custom")];
  const events = [report("w1"), report("w3"), report("w4", "DONE", "fail"), report("w5", "DONE", "pass")];
  const result = stepStatuses(p, events, spawns, types);
  assert.deepEqual({ ...result }, { a: "done", b: "running", r: "waiting", t: "failed", custom: "done", pending: "pending" });
  assert.equal(stepStatuses(p, [...events, report("w3", "DONE", "pass")], spawns, types).r, "done");
  assert.equal(stepStatuses(p, [...events, report("w1", "QUESTION")], spawns, types).a, "waiting");
  assert.equal(stepStatuses(p, [...events, report("w1", "HANDOFF")], spawns, types).a, "waiting");
  assert.equal(stepStatuses(p, [...events, report("w3", "DONE", "uncertain")], spawns, types).r, "waiting");
});

test("stepStatuses uses checker metadata, with built-in fallback only for missing types", () => {
  const p = plan([step("r", "reviewer"), step("c", "audit"), step("a")]);
  const spawns = [spawn("r", "r"), spawn("c", "c"), spawn("a", "a")];
  const events = [report("r"), report("c"), report("a")];
  assert.equal(stepStatuses(p, events, spawns, types).c, "waiting");
  assert.equal(stepStatuses(p, events, spawns, []).r, "waiting");
  assert.equal(stepStatuses(p, events, spawns, []).a, "done");
  const overridden = [{ type: "reviewer", caps: [], verdict: false }];
  assert.equal(stepStatuses(p, events, spawns, overridden).r, "done");
});

test("stepStatuses excludes stale reports, honors latest assignment and JSONL append order", () => {
  const p = plan([step("a"), step("b"), step("r", "reviewer")]);
  const spawns = [spawn("w", "a", 10), spawn("w", "b", 30, "impl", 1), spawn("r1", "r", 10), spawn("r2", "r", 10)];
  const events = [report("w", "DONE", undefined, 20), report("r1", "DONE", "pass", 40), report("r2", "DONE", "fail", 20), null, { t: "spawn" }];
  assert.deepEqual({ ...stepStatuses(p, events, spawns, types) }, { a: "pending", b: "running", r: "failed" });
  assert.equal(stepStatuses(p, [...events, report("w", "DONE", undefined, 30)], spawns, types).b, "done");
  assert.equal(stepStatuses(p, [...events, report("r1", "DONE", "pass", 20)], spawns, types).r, "done");
  assert.equal(stepStatuses(p, [], [spawn("unassigned")], types).a, "pending");
});

test("assignStep prefers first same-type pending step and falls back only for makers in unfinished stages", () => {
  const p = plan([step("a"), step("review", "reviewer")], [step("b", "impl-pro"), step("c", "impl-pro")]);
  assert.equal(assignStep(p, { a: "pending", review: "pending", b: "pending", c: "pending" }, "impl-pro", types)?.id, "b");
  assert.equal(assignStep(p, { a: "done", review: "pending", b: "done", c: "done" }, "impl-pro", types)?.id, "a", "maker can repair an unfinished stage");
  assert.equal(assignStep(p, { a: "done", review: "done", b: "running", c: "running" }, "impl", types)?.id, "b");
  assert.equal(assignStep(p, { a: "done", review: "done", b: "done", c: "done" }, "impl", types), undefined);
  assert.equal(assignStep(p, { a: "pending", review: "running", b: "running", c: "running" }, "reviewer", types), undefined);
  assert.equal(assignStep(p, { a: "running", review: "pending", b: "running", c: "running" }, "reviewer", types)?.id, "review");
  assert.equal(assignStep(p, { a: "running" }, "tester", types), undefined, "edit-tests is not a maker");
  assert.equal(assignStep(p, {}, "unknown", types), undefined);
});

test("planDone requires every status done and mergeRequire is a stable pure union", () => {
  assert.equal(planDone({ a: "done", b: "done" }), true);
  assert.equal(planDone({}), true);
  for (const status of ["pending", "running", "waiting", "failed"] as const) assert.equal(planDone({ a: "done", b: status }), false);
  assert.deepEqual(mergeRequire(), []);
  assert.deepEqual(mergeRequire(undefined, ["tester"]), ["tester"]);
  const old: ("reviewer" | "tester")[] = ["reviewer", "reviewer"];
  assert.deepEqual(mergeRequire(old, ["tester", "reviewer"]), ["reviewer", "tester"]);
  assert.deepEqual(old, ["reviewer", "reviewer"]);
});
