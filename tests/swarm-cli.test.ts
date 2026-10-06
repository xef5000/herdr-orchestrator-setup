import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = fileURLToPath(new URL("../swarm", import.meta.url));

function swarmTypesJson(): Array<Record<string, unknown>> {
  const result = spawnSync("bash", [script, "types", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HERDR_BIN_PATH: "/bin/true" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("swarm types --json lists every worker type with caps and verdict", () => {
  const types = swarmTypesJson();
  assert.ok(Array.isArray(types));
  const byType = new Map(types.map((t) => [t.type as string, t]));
  assert.equal(byType.has("orchestrator"), false);
  assert.deepEqual(byType.get("impl")?.caps, ["edit"]);
  assert.deepEqual(byType.get("planner")?.caps, []);
  assert.deepEqual(byType.get("github")?.caps, ["git-write", "github"]);
  for (const t of types) assert.equal(typeof t.verdict, "boolean", `${t.type} verdict`);
});

function waitFixture(t: { after: (fn: () => void) => void }, status = "done") {
  const directory = mkdtempSync(join(tmpdir(), "swarm-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runDir = join(directory, "run");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  const herdr = join(directory, "herdr");
  const calls = join(directory, "calls");
  writeFileSync(herdr, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$1 $2" in
  'agent get') printf '{"result":{"agent":{"agent_status":"%s","state_change_seq":5}}}\\n' "$FAKE_STATUS" ;;
  'agent wait'|'agent prompt') exit 0 ;;
  'agent read')
    lines=60
    while [[ $# -gt 0 ]]; do
      case "$1" in --lines) lines="$2"; shift 2 ;; *) shift ;; esac
    done
    for ((i=61-lines; i<=60; i++)); do printf 'pane line %02d\\n' "$i"; done ;;
  *) exit 1 ;;
esac
`);
  chmodSync(herdr, 0o755);
  const env = {
    ...process.env, HERDR_BIN_PATH: herdr, TMPDIR: directory,
    SWARM_RUN_DIR: runDir, SWARM_ORCHESTRATOR: "orch", FAKE_STATUS: status, FAKE_CALLS: calls,
  };
  const invoke = (...args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8", env });
  const wait = (...args: string[]) => {
    const result = invoke("wait", "worker", ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const event = (id = "latest", ts = 2000, verdict: string | null = "pass") => ({
    t: "report", ts, id, worker: "worker", role: "reviewer", kind: "DONE", verdict,
    tree: null, artifact: `artifacts/${id}.md`,
  });
  const artifact = (text: string, id = "latest") => {
    const path = join(runDir, "artifacts", `${id}.md`);
    writeFileSync(path, text);
    return path;
  };
  const events = (...entries: unknown[]) => writeFileSync(join(runDir, "events.jsonl"),
    entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n");
  const seqFile = join(directory, "swarm-seq", "orch.worker");
  const promptTime = (ts: number) => {
    mkdirSync(join(directory, "swarm-seq"), { recursive: true });
    writeFileSync(seqFile, "3");
    writeFileSync(`${seqFile}.ts`, String(ts));
  };
  return { wait, invoke, event, artifact, events, promptTime, seqFile, calls };
}

function assertPane(output: string) {
  assert.doesNotMatch(output, /pane line 20/);
  assert.match(output, /pane line 21/);
  assert.match(output, /pane line 60/);
  assert.equal(output.match(/pane line /g)?.length, 40);
}

test("swarm wait prints the latest report and header instead of the pane", (t) => {
  const f = waitFixture(t);
  f.artifact("previous report", "old");
  f.artifact("latest report text");
  f.events(f.event("old"), f.event());
  const output = f.wait();
  assert.match(output, /=== worker: done\nDONE worker \[r:latest verdict:pass\]:\nlatest report text/);
  assert.doesNotMatch(output, /previous report|pane line/);
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /agent read/);
});

test("swarm wait inlines an 8000-byte artifact but points to larger reports", (t) => {
  const f = waitFixture(t);
  const path = f.artifact("x".repeat(8000));
  f.events(f.event());
  assert.ok(f.wait().includes("x".repeat(8000)));
  f.artifact("x".repeat(8001));
  const output = f.wait();
  assert.ok(output.includes(`(report is 8001 chars, not inlined) full text: ${path}`));
  assert.ok(output.includes('swarm_read {report:"latest"} or context_from:["r:latest"]'));
  assert.doesNotMatch(output, /xxx|pane line/);
});

test("swarm wait ignores a report's artifact path and reads artifacts/<id>.md", (t) => {
  const f = waitFixture(t);
  const real = f.artifact("trusted artifact");
  const evil = join(real, "..", "evil.md");
  writeFileSync(evil, "evil artifact");
  f.events({ ...f.event("latest", 2000, "pass"), artifact: evil });
  const output = f.wait();
  assert.match(output, /trusted artifact/);
  assert.doesNotMatch(output, /evil artifact/);
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /agent read/);
});

test("swarm wait ignores a report whose id is not a safe artifact name", (t) => {
  const f = waitFixture(t);
  f.events(f.event("../evil", 2000));
  const output = f.wait();
  assert.match(output, /\(no report since the prompt\)/);
  assertPane(output);
});

test("swarm wait falls back to the last 40 pane lines without a report", (t) => {
  const f = waitFixture(t);
  const output = f.wait();
  assert.match(output, /\(no report since the prompt\)/);
  assertPane(output);
});

test("swarm wait shows both report and pane for a blocked worker", (t) => {
  const f = waitFixture(t, "blocked");
  f.artifact("worker question");
  f.events({ ...f.event("latest", 2000, null), kind: "QUESTION" });
  const output = f.wait();
  assert.match(output, /=== worker: blocked/);
  assert.match(output, /QUESTION worker \[r:latest\]:\nworker question/);
  assert.doesNotMatch(output, /verdict:/);
  assertPane(output);
});

test("swarm wait --no-read suppresses pane fallback, including blocked workers", (t) => {
  const f = waitFixture(t, "blocked");
  assert.doesNotMatch(f.wait("--no-read"), /pane line/);
  f.artifact("blocked report");
  f.events(f.event());
  const output = f.wait("--no-read");
  assert.match(output, /blocked report/);
  assert.doesNotMatch(output, /pane line/);
  assert.doesNotMatch(readFileSync(f.calls, "utf8"), /agent read/);
});

test("swarm wait ignores reports older than the prompt and removes prompt markers", (t) => {
  const f = waitFixture(t);
  f.promptTime(2001);
  f.artifact("stale report");
  f.events(f.event());
  const output = f.wait();
  assert.match(output, /\(no report since the prompt\)/);
  assert.doesNotMatch(output, /stale report/);
  assertPane(output);
  assert.equal(existsSync(f.seqFile), false);
  assert.equal(existsSync(`${f.seqFile}.ts`), false);
});

test("swarm wait skips malformed events and includes reports at the prompt timestamp", (t) => {
  const f = waitFixture(t);
  f.promptTime(2000);
  f.artifact("valid report");
  f.events("not json", null, 42, f.event(), '{"t":"report"');
  const output = f.wait();
  assert.match(output, /valid report/);
  assert.doesNotMatch(output, /pane line/);
});

test("swarm prompt records a millisecond timestamp beside the sequence file", (t) => {
  const f = waitFixture(t);
  const before = Date.now();
  const result = f.invoke("prompt", "worker", "do work");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.seqFile, "utf8").trim(), "5");
  const timestamp = Number(readFileSync(`${f.seqFile}.ts`, "utf8"));
  assert.ok(timestamp >= before && timestamp <= Date.now());
});

test("swarm wait preserves TIMEOUT output and prompt markers", (t) => {
  const f = waitFixture(t, "working");
  f.promptTime(2000);
  const result = f.invoke("wait", "worker", "--timeout", "0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /=== worker: TIMEOUT after 0ms \(still working\)/);
  assert.equal(existsSync(f.seqFile), true);
  assert.equal(existsSync(`${f.seqFile}.ts`), true);
});
