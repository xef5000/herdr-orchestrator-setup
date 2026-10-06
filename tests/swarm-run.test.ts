import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestReport, parseEvents, publishStatus, reportEvent, treeFingerprint } from "../extensions/swarm-run.ts";

function repo(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-run-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_INDEX_FILE: undefined, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  }).trim();
  git("init");
  return { cwd, git };
}

function evidence(role: string, verdict: string | null = "pass", tree: string | null = "tree", worker = role) {
  return reportEvent({ worker, role, kind: "DONE", verdict, tree, artifact: "Checks completed" });
}

test("parseEvents skips malformed and blank lines without discarding valid JSON", () => {
  const report = evidence("reviewer");
  assert.deepEqual(parseEvents(`\n${JSON.stringify(report)}\r\nbroken\n{\"t\":\"start\"}\n{\"partial\":\nnull\n`), [report, { t: "start" }, null]);
});

test("reportEvent preserves evidence and supplies a timestamp and unique id", () => {
  const report = reportEvent({ worker: "r1", role: "reviewer", kind: "DONE", verdict: "pass", tree: "tree", artifact: "review.txt", id: "id", ts: 123 });
  assert.deepEqual(report, { t: "report", ts: 123, id: "id", worker: "r1", role: "reviewer", kind: "DONE", verdict: "pass", tree: "tree", artifact: "review.txt" });
  const a = evidence("reviewer"), b = evidence("reviewer");
  assert.equal(typeof a.ts, "number");
  assert.notEqual(a.id, b.id);
});

test("fingerprint survives a commit, changes with edits and new files, and leaves staging untouched", t => {
  const { cwd, git } = repo(t);
  writeFileSync(join(cwd, "tracked.txt"), "original\n");
  git("add", "tracked.txt");
  const index = join(cwd, git("rev-parse", "--git-path", "index"));
  const stagedIndex = readFileSync(index);
  const before = treeFingerprint(cwd);
  assert.match(before!, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(readFileSync(index), stagedIndex);
  git("-c", "commit.gpgsign=false", "commit", "-m", "Initial");
  assert.equal(treeFingerprint(cwd), before);

  // Staged content differs from the worktree; fingerprint must use the latter.
  writeFileSync(join(cwd, "tracked.txt"), "staged\n");
  git("add", "tracked.txt");
  writeFileSync(join(cwd, "tracked.txt"), "working\n");
  const indexBefore = readFileSync(index);
  const edited = treeFingerprint(cwd);
  assert.notEqual(edited, before);
  assert.deepEqual(readFileSync(index), indexBefore);
  assert.equal(git("show", ":tracked.txt"), "staged");
  writeFileSync(join(cwd, "new.txt"), "new\n");
  assert.notEqual(treeFingerprint(cwd), edited);
  assert.deepEqual(readFileSync(index), indexBefore);
  assert.equal(existsSync(index + ".lock"), false);
  rmSync(join(cwd, "tracked.txt"));
  const deleted = treeFingerprint(cwd);
  assert.notEqual(deleted, edited);
  assert.deepEqual(readFileSync(index), indexBefore);
});

test("fingerprinting handles unborn repositories without creating their real index", t => {
  const { cwd, git } = repo(t);
  const index = join(cwd, git("rev-parse", "--git-path", "index"));
  writeFileSync(join(cwd, "new.txt"), "new\n");
  assert.equal(existsSync(index), false);
  assert.ok(treeFingerprint(cwd));
  assert.equal(existsSync(index), false);
});

test("fingerprinting outside Git or on error returns undefined", t => {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-not-git-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(treeFingerprint(cwd), undefined);
  assert.equal(treeFingerprint(join(cwd, "missing")), undefined);
});

test("publish gate uses recorded roles, not worker names or implementation verdicts", () => {
  assert.equal(publishStatus([evidence("impl", "pass", "tree", "reviewer")], ["reviewer"], "tree").ok, false);
  assert.equal(publishStatus([evidence("impl")], ["impl"], "tree").ok, false);
  assert.equal(publishStatus([evidence("impl-pro")], ["impl-pro"], "tree").ok, false);
  assert.equal(publishStatus([evidence("reviewer", "pass", "tree", "impl")], ["reviewer"], "tree").ok, true);
});

test("tester is not implicitly required and verdicts from other roles do not block", () => {
  const events = [evidence("reviewer"), evidence("tester", "fail"), evidence("impl", "fail")];
  assert.equal(publishStatus(events, ["reviewer"], "tree").ok, true);
  assert.equal(publishStatus(events, ["reviewer", "tester"], "tree").ok, false);
  assert.equal(publishStatus([], [], undefined).ok, true);
});

test("publish gate takes the latest verdict, ignoring reports without verdicts and non-reports", () => {
  const pass = evidence("reviewer");
  const fail = evidence("reviewer", "fail");
  assert.equal(publishStatus([pass, fail], ["reviewer"], "tree").ok, false);
  assert.equal(publishStatus([fail, pass], ["reviewer"], "tree").ok, true);
  const note = reportEvent({ worker: "r2", role: "reviewer", kind: "HANDOFF", artifact: "note" });
  assert.equal(publishStatus([pass, note, null, { ...fail, t: "start" }], ["reviewer"], "tree").ok, true);
});

test("publish gate ignores QUESTION and HANDOFF verdicts, including legacy events", () => {
  for (const kind of ["QUESTION", "HANDOFF"]) {
    const notePass = { ...evidence("reviewer"), kind };
    const noteFail = { ...evidence("reviewer", "fail"), kind };
    assert.equal(publishStatus([notePass], ["reviewer"], "tree").ok, false);
    assert.equal(publishStatus([evidence("reviewer", "fail"), notePass], ["reviewer"], "tree").ok, false);
    assert.equal(publishStatus([evidence("reviewer"), noteFail], ["reviewer"], "tree").ok, true);
  }
});

test("publish gate explains missing, failed, stale and unknown tree evidence", () => {
  for (const [events, tree, reason] of [
    [[], "tree", /missing/i],
    [[evidence("reviewer", "fail")], "tree", /failed/i],
    [[evidence("reviewer", "pass", "old")], "tree", /stale/i],
    [[evidence("reviewer", "pass", null)], "tree", /unknown tree/i],
    [[evidence("reviewer")], undefined, /unknown tree/i],
    [[evidence("reviewer", null)], "tree", /missing/i],
  ] as const) {
    const status = publishStatus(events, ["reviewer"], tree);
    assert.equal(status.ok, false);
    assert.match(status.why, reason);
  }
  assert.equal(publishStatus([evidence("reviewer")], ["reviewer", "security"], "tree").ok, false);
});

test("latestReport selects the last matching worker report at or after sinceTs", () => {
  const a = reportEvent({ worker: "w1", role: "reviewer", kind: "DONE", artifact: "a", ts: 10 });
  const b = reportEvent({ worker: "w1", role: "reviewer", kind: "QUESTION", artifact: "b", ts: 20 });
  const other = reportEvent({ worker: "w2", role: "reviewer", kind: "DONE", artifact: "other", ts: 30 });
  const events = [a, b, other, null, { ...other, t: "start", worker: "w1" }];
  assert.equal(latestReport(events, "w1", 10), b);
  assert.equal(latestReport(events, "w1", 20), b);
  assert.equal(latestReport(events, "w1", 21), undefined);
  assert.equal(latestReport(events, "missing", 0), undefined);
});
