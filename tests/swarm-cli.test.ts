import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
