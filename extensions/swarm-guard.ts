import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parsePolicy, decide } from "./swarm-policy.ts";
import { parseEvents, publishStatus, reportEvent, treeFingerprint } from "./swarm-run.ts";

export default function (pi: ExtensionAPI) {
  const policy = parsePolicy(process.env, process.cwd());
  if (!policy) return;
  policy.currentBranch = () => {
    try {
      return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: policy.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch { return undefined; }
  };

  if (policy.runDir) {
    policy.publishCheck = () => {
      let jsonl = "";
      try { jsonl = readFileSync(join(policy.runDir!, "events.jsonl"), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return { ok: false, why: `Cannot read publish evidence: ${String(error)}` };
        }
      }
      const roles = (process.env.SWARM_PUBLISH_REQUIRE ?? "reviewer").split(",").map(role => role.trim()).filter(Boolean);
      return publishStatus(parseEvents(jsonl), roles, treeFingerprint(policy.cwd));
    };
  }
  policy.toolInfo = name => {
    const tool = pi.getAllTools().find(tool => tool.name === name);
    return tool ? { readOnly: tool.annotations?.readOnlyHint } : undefined;
  };

  const verdictRequired = process.env.SWARM_VERDICT === "required";
  let startTree: string | undefined;
  if (verdictRequired) {
    pi.on("before_agent_start", () => { startTree = treeFingerprint(policy.cwd); });
  }

  pi.on("tool_call", async (event, ctx) => {
    const decision = decide(event.toolName, event.input, policy);
    if (decision.action === "allow") return undefined;
    if (decision.action === "block") return { block: true, reason: "swarm guard: " + decision.reason };
    if (!ctx.hasUI) return { block: true, reason: "swarm guard: user approval requires a UI. Hand off: swarm_report({kind:\"HANDOFF\", message:\"github should request user approval in an interactive pane\"})" };
    let approved = false;
    pi.events.emit("herdr:blocked", { active: true, label: decision.title });
    try {
      approved = await ctx.ui.confirm(decision.title, decision.reason + "\n\n" + String(event.input.command ?? ""));
    } finally {
      pi.events.emit("herdr:blocked", { active: false });
    }
    if (!approved) return { block: true, reason: "swarm guard: the user declined; report it in DONE, do not retry another way. Hand off: swarm_report({kind:\"HANDOFF\", message:\"orchestrator should relay the declined approval\"})" };
    return undefined;
  });

  const orch = process.env.SWARM_ORCHESTRATOR;
  if (policy.role === "orchestrator" || !orch) return;
  pi.registerTool({
    name: "swarm_report",
    label: "Report to orchestrator",
    description: "Send DONE, QUESTION or HANDOFF to your orchestrator. DONE is your final report and terminates the turn; send it exactly once after finishing your work.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("DONE"), Type.Literal("QUESTION"), Type.Literal("HANDOFF")]),
      message: Type.String({ description: "Self-contained summary, question or hand-off request" }),
      verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail")], { description: "Required on DONE for verdict roles" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (verdictRequired && params.kind === "DONE" && !params.verdict) {
        throw new Error(`DONE from ${policy.role} must include verdict "pass" or "fail"`);
      }
      if (!process.env.SWARM_HOME) throw new Error("SWARM_HOME is required to report to the orchestrator");
      const verdict = verdictRequired && params.kind === "DONE" ? params.verdict : undefined;
      const warnings: string[] = [];
      const fileError = (error: unknown) => { warnings.push(`Report recording error: ${String(error)}`); };
      let id: string | undefined;
      if (policy.runDir) {
        id = `${Date.now()}-${policy.name}-${randomBytes(3).toString("hex")}`;
        const currentTree = treeFingerprint(policy.cwd);
        // Writing tests or producing untracked, non-ignored review files changes the tree;
        // such verdicts get tree=null and require a fresh review of the resulting tree.
        const tree = currentTree && currentTree === startTree ? currentTree : null;
        const artifact = join("artifacts", `${id}.md`);
        try {
          mkdirSync(join(policy.runDir, "artifacts"), { recursive: true });
          writeFileSync(join(policy.runDir, artifact), params.message, "utf8");
        } catch (error) { fileError(error); }
        try {
          appendFileSync(join(policy.runDir, "events.jsonl"), JSON.stringify(reportEvent({
            id, worker: policy.name, role: policy.role, kind: params.kind, verdict, tree, artifact,
          })) + "\n", "utf8");
        } catch (error) { fileError(error); }
      }
      const metadata = [id ? `r:${id}` : "", verdict ? `verdict:${verdict}` : ""].filter(Boolean);
      const text = `${params.kind} ${policy.name}${metadata.length ? ` [${metadata.join(" ")}]` : ""}: ${params.message}`;
      let result = "sent to " + orch;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(`${process.env.SWARM_HOME}/herdr`, ["agent", "prompt", orch, text], {
              cwd: policy.cwd, env: process.env, signal,
            }, (error, _stdout, stderr) => {
              if (error) reject(new Error(`swarm_report failed: ${stderr || error.message}`));
              else resolve();
            });
          });
          break;
        } catch (error) {
          signal?.throwIfAborted();
          if (!String(error).includes("agent_blocked")) throw error;
          if (attempt < 12) {
            await delay(5000, undefined, { signal });
            continue;
          }
          if (!policy.runDir) throw error;
          try {
            appendFileSync(join(policy.runDir, "events.jsonl"), JSON.stringify({ t: "undelivered", ts: Date.now(), id }) + "\n", "utf8");
          } catch (recordError) { fileError(recordError); }
          result = `orchestrator is busy with a user dialog; your report is recorded in the run log (artifact r:${id}). Tell the orchestrator via your final answer if needed`;
          break;
        }
      }
      return {
        content: [{ type: "text", text: [result, ...warnings].join("\n") }],
        details: undefined,
        terminate: params.kind === "DONE",
      };
    },
  });
}
