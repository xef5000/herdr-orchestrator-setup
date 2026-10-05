import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
): Promise<{ stdout: string; output: string }> {
  const home = process.env.SWARM_HOME;
  if (!home) return Promise.reject(new Error("SWARM_HOME is not set"));
  return new Promise((resolve, reject) => {
    execFile(`${home}/${executable}`, args, {
      cwd,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      signal,
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

export default function (pi: ExtensionAPI) {
  if (process.env.SWARM_ROLE !== "orchestrator") return;

  pi.registerTool({
    name: "swarm_spawn",
    label: "Spawn worker",
    description: "Delegate work: open a worker of <type> (see the agent table) and send it a SELF-CONTAINED task. wait:true blocks until it settles and returns its output. Multiple calls in one message run in parallel.",
    parameters: Type.Object({
      type: Type.String({ minLength: 1, description: "Agent type from the agent table or swarm_types." }),
      task: Type.String({ minLength: 1, description: "Self-contained task, including context, files, acceptance and verification." }),
      name: Type.Optional(name),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: timeout,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["spawn", params.type];
      if (params.name) args.push("--name", params.name);
      args.push("--task", params.task);
      const spawned = await serializeSpawn(() => run("swarm", args, ctx.cwd, signal));
      const workerName = /^spawned (\S+) \(/m.exec(spawned.stdout)?.[1];
      if (!workerName) throw new Error(truncate("Could not parse spawned worker name:\n" + spawned.output));
      let output = spawned.output;
      if (params.wait) {
        const waited = await run("swarm", ["wait", workerName, "--timeout", String(params.timeout_ms ?? DEFAULT_TIMEOUT_MS)], ctx.cwd, signal, true);
        output += "\n" + waited.output;
      }
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
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: timeout,
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["prompt", params.name, params.text];
      if (params.wait) args.push("--wait", "--timeout", String(params.timeout_ms ?? DEFAULT_TIMEOUT_MS));
      const result = await run("swarm", args, ctx.cwd, signal, params.wait === true);
      return toolResult(result.output);
    },
  });

  pi.registerTool({
    name: "swarm_wait",
    label: "Wait for workers",
    description: "Wait for named workers to settle and return their outputs, including blocked approval dialogs. On timeout, wait again rather than spawning duplicates.",
    parameters: Type.Object({ names: Type.Array(name, { minItems: 1 }), timeout_ms: timeout }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await run("swarm", ["wait", ...params.names, "--timeout", String(params.timeout_ms ?? DEFAULT_TIMEOUT_MS)], ctx.cwd, signal, true);
      return toolResult(result.output);
    },
  });

  pi.registerTool({
    name: "swarm_read",
    label: "Read worker",
    description: "Read recent unwrapped output from a worker's pane (default 150 lines). Use this to re-read reports or inspect a blocked worker's dialog.",
    parameters: Type.Object({ name, lines: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await run("herdr", ["agent", "read", params.name, "--source", "recent-unwrapped", "--lines", String(params.lines ?? 150)], ctx.cwd, signal);
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
