import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile, execFileSync } from "node:child_process";
import { parsePolicy, decide } from "./swarm-policy.ts";

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
    }),
    async execute(_toolCallId, params, signal) {
      const text = `${params.kind} ${policy.name}: ${params.message}`;
      if (!process.env.SWARM_HOME) throw new Error("SWARM_HOME is required to report to the orchestrator");
      await new Promise<void>((resolve, reject) => {
        execFile(`${process.env.SWARM_HOME}/herdr`, ["agent", "prompt", orch, text], {
          cwd: policy.cwd, env: process.env, signal,
        }, (error, _stdout, stderr) => {
          if (error) reject(new Error(`swarm_report failed: ${stderr || error.message}`));
          else resolve();
        });
      });
      return {
        content: [{ type: "text", text: "sent to " + orch }],
        details: undefined,
        terminate: params.kind === "DONE",
      };
    },
  });
}
