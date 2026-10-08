import * as path from "node:path";
import * as os from "node:os";
import { statSync } from "node:fs";

export type Decision = { action: "allow" } | { action: "block"; reason: string } | { action: "confirm"; title: string; reason: string };
export interface Policy {
  role: string;
  caps: Set<string>;
  orchestrator: string;
  name: string;
  cwd: string;
  tmpDirs: string[];
  tmpDir?: string;
  homeDir?: string;
  testPathRe: RegExp;
  writeScope: string[];
  runDir?: string;
  home?: string;
  protectedDirs: string[];
  allowTools: string[];
  publishCheck?: () => { ok: boolean; why: string };
  toolInfo?: (name: string) => { readOnly?: boolean } | undefined;
  currentBranch?: () => string | undefined;
}

const DEFAULT_TEST_RE = "(^|/)(tests?|specs?|__tests__|__mocks__|testdata|fixtures|e2e)/|[._-](test|spec)s?\\.[^/]+$|(^|/)test_[^/]+\\.py$|_test\\.go$|(^|/)conftest\\.py$|Tests?\\.(swift|kt|java|cs|php)$";
export function parsePolicy(env: Record<string, string | undefined>, cwd: string): Policy | undefined {
  if (!env.SWARM_ROLE) return undefined;
  cwd = path.resolve(cwd);
  const homeDir = env.HOME || os.homedir();
  const runDir = env.SWARM_RUN_DIR ? path.resolve(cwd, env.SWARM_RUN_DIR) : undefined;
  const home = env.SWARM_HOME ? path.resolve(cwd, env.SWARM_HOME) : undefined;
  return {
    role: env.SWARM_ROLE,
    caps: new Set((env.SWARM_CAPS ?? "").split(",").map(x => x.trim()).filter(x => x && x !== "none")),
    orchestrator: env.SWARM_ORCHESTRATOR ?? "orchestrator",
    name: env.SWARM_NAME ?? env.SWARM_ROLE,
    cwd: path.resolve(cwd),
    tmpDirs: [...new Set([os.tmpdir(), "/tmp", "/private/tmp", env.TMPDIR].filter((x): x is string => !!x).map(x => path.resolve(x)))],
    tmpDir: env.TMPDIR,
    homeDir,
    runDir,
    home,
    protectedDirs: [...new Set([home, runDir, path.join(homeDir, ".pi/agent"),
      env.SWARM_AGENTS_DIR ? path.resolve(cwd, env.SWARM_AGENTS_DIR) : undefined,
      env.SWARM_PROJECT_AGENTS === "1" ? path.join(cwd, ".swarm", "agents") : undefined,
      path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "herdr-swarm", "agents")]
      .filter((dir): dir is string => !!dir && !inside(cwd, dir)))],
    allowTools: (env.SWARM_ALLOW_TOOLS ?? "").split(",").map(x => x.trim()).filter(Boolean),
    testPathRe: new RegExp(env.SWARM_TEST_PATH_RE || DEFAULT_TEST_RE),
    writeScope: (env.SWARM_WRITE_SCOPE ?? "").split(",").map(x => x.trim()).filter(Boolean),
  };
}

export interface CommandSegment { tokens: string[]; redirects: string[]; substitutedAssignments?: string[]; piped?: boolean }

/** A small lexical scanner, not a shell interpreter. Quoted data is never treated as commands. */
export function splitCommands(cmd: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let tokens: string[] = [], redirects: string[] = [], token = "", started = false;
  let redirect = false, substituted = false, piped = false;
  let substitutedAssignments: string[] = [];
  let heredoc: { delimiter: string; quoted: boolean; tabs: boolean } | undefined;
  const pending: { delimiter: string; quoted: boolean; tabs: boolean }[] = [];
  const finishToken = () => {
    if (!started) return;
    if (heredoc) { pending.push({ ...heredoc, delimiter: token }); heredoc = undefined; }
    else if (redirect) { redirects.push(token); redirect = false; }
    else {
      tokens.push(token);
      if (substituted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) substitutedAssignments.push(token);
    }
    token = ""; started = false; substituted = false;
  };
  const finish = () => {
    finishToken();
    if (tokens.length || redirects.length) {
      segments.push({ tokens, redirects, ...(substitutedAssignments.length ? { substitutedAssignments } : {}), ...(piped ? { piped: true } : {}) });
      piped = false;
    }
    tokens = []; redirects = []; substitutedAssignments = [];
  };
  // Return the body and end offset for a substitution, retaining nested substitutions.
  const substitution = (start: number, backtick: boolean, source = cmd): { body: string; end: number } => {
    let depth = 1, quote = "", j = start;
    const documents: { delimiter: string; tabs: boolean }[] = [];
    for (; j < source.length; j++) {
      const c = source[j];
      if (c === "\\" && quote !== "'") { j++; continue; }
      if (backtick) { if (c === "`") break; continue; }
      if (quote) {
        if (c === quote) quote = "";
        else if (quote === '"' && (c === "`" || (c === "$" && source[j + 1] === "("))) {
          j = substitution(j + (c === "`" ? 1 : 2), c === "`", source).end;
        }
        continue;
      }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "<" && source.slice(j, j + 3) === "<<<") { j += 2; continue; }
      if (c === "<" && source[j + 1] === "<") {
        const match = source.slice(j).match(/^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/);
        if (!match) throw new SyntaxError("invalid heredoc");
        documents.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: match[1] === "-" });
        j += match[0].length - 1;
        continue;
      }
      if (c === "\n") {
        for (const h of documents.splice(0)) {
          let closed = false;
          while (j + 1 < source.length) {
            const lineStart = j + 1, end = source.indexOf("\n", lineStart);
            j = end < 0 ? source.length : end;
            const line = source.slice(lineStart, j);
            if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delimiter) { closed = true; break; }
          }
          if (!closed) throw new SyntaxError("unterminated heredoc");
        }
        continue;
      }
      if (c === "(") depth++;
      if (c === ")" && --depth === 0) break;
    }
    if (j >= source.length || quote || documents.length) throw new SyntaxError("unterminated substitution");
    return { body: source.slice(start, j), end: j };
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") { started = true; if (cmd[i + 1] !== "\n") token += cmd[++i] ?? ""; else i++; continue; }
    if (c === "'" || c === '"') {
      started = true;
      if (heredoc) heredoc.quoted = true;
      const quote = c;
      for (i++; i < cmd.length && cmd[i] !== quote; i++) {
        if (quote === '"' && cmd[i] === "\\") {
          const next = cmd[i + 1];
          if (next && /[$`"\\\n]/.test(next)) { if (next !== "\n") token += next; i++; }
          else token += "\\";
        } else if (quote === '"' && (cmd[i] === "`" || (cmd[i] === "$" && cmd[i + 1] === "("))) {
          const backtick = cmd[i] === "`";
          const sub = substitution(i + (backtick ? 1 : 2), backtick);
          segments.push(...splitCommands(sub.body));
          substituted = true;
          token += cmd.slice(i, sub.end + 1); i = sub.end;
        } else token += cmd[i];
      }
      if (i >= cmd.length) throw new SyntaxError("unterminated quote");
      continue;
    }
    if (c === "`" || (c === "$" && cmd[i + 1] === "(")) {
      const backtick = c === "`", sub = substitution(i + (backtick ? 1 : 2), backtick);
      segments.push(...splitCommands(sub.body));
      token += cmd.slice(i, sub.end + 1); started = true; substituted = true; i = sub.end; continue;
    }
    if (c === "#" && !started) { while (i < cmd.length && cmd[i] !== "\n") i++; i--; continue; }
    // A here-string is input data, not a heredoc with a following body.
    if (c === "<" && cmd.slice(i, i + 3) === "<<<") { finishToken(); i += 2; continue; }
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      finishToken(); i++;
      const tabs = cmd[i + 1] === "-"; if (tabs) i++;
      heredoc = { delimiter: "", quoted: false, tabs }; continue;
    }
    if (c === ">" || (c === "&" && cmd[i + 1] === ">")) {
      // N> uses the number as a file descriptor, not as an operand.
      if (/^\d+$/.test(token)) { token = ""; started = false; } else finishToken();
      if (c === "&") i++;
      if (cmd[i + 1] === ">") i++;
      if (cmd[i + 1] === "&") {
        i++;
        // >&N duplicates a descriptor; >&file redirects to a file.
        const descriptor = cmd.slice(i + 1).match(/^(?:\d+|-)(?=\s|[;&|()]|$)/);
        if (descriptor) { i += descriptor[0].length; continue; }
      }
      redirect = true; continue;
    }
    if (/\s/.test(c)) {
      finishToken();
      if (c === "\n") {
        finish();
        for (const h of pending.splice(0)) {
          let body = "";
          while (i + 1 < cmd.length) {
            const start = i + 1, end = cmd.indexOf("\n", start);
            const lineEnd = end < 0 ? cmd.length : end;
            const line = cmd.slice(start, lineEnd);
            i = lineEnd;
            if ((h.tabs ? line.replace(/^\t+/, "") : line) === h.delimiter) break;
            body += line + "\n";
          }
          if (!h.quoted) {
            // A heredoc is data; only its command expansions execute.
            for (let j = 0; j < body.length; j++) {
              if (body[j] === "\\") { j++; continue; }
              if (body[j] === "`" || (body[j] === "$" && body[j + 1] === "(")) {
                const backtick = body[j] === "`";
                const sub = substitution(j + (backtick ? 1 : 2), backtick, body);
                segments.push(...splitCommands(sub.body));
                j = sub.end;
              }
            }
          }
        }
      }
      continue;
    }
    if (/[;&|()]/.test(c)) {
      finish();
      if (c === "|" && cmd[i + 1] !== "|") piped = true;
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      else if (c === "|" && cmd[i + 1] === "&") i++;
      continue;
    }
    started = true; token += c;
  }
  finish();
  return segments;
}

const ALLOW: Decision = { action: "allow" };
function block(reason: string, type = "impl", action = "handle this operation"): Decision {
  return { action: "block", reason: `${reason}. Hand off: swarm_report({kind:"HANDOFF", message:"${type} should ${action}"})` };
}
function confirm(reason: string): Decision {
  return { action: "confirm", title: "Swarm: user approval required", reason };
}
function inside(file: string, directory: string): boolean {
  const rel = path.relative(directory, file);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function temporary(file: string, p: Policy): boolean {
  const expanded = file.replace(/^(?:\$TMPDIR|\$\{TMPDIR\})(?=\/|$)/, p.tmpDir ?? "$TMPDIR")
    .replace(/^~(?=\/|$)/, p.homeDir ?? os.homedir());
  // Do not resolve unknown variables as literal project-relative paths.
  if (expanded.includes("$") || expanded.startsWith("~")) return false;
  return p.tmpDirs.some(dir => inside(path.resolve(p.cwd, expanded), dir));
}
function testFile(file: string, p: Policy): boolean {
  p.testPathRe.lastIndex = 0;
  return p.testPathRe.test(path.relative(p.cwd, path.resolve(p.cwd, file)).split(path.sep).join("/"));
}
function protectedPath(file: string, p: Policy): boolean {
  if (/\$(?:SWARM_(?:RUN_DIR|HOME)\b|\{SWARM_(?:RUN_DIR|HOME)\})/.test(file)) return true;
  const expanded = file.replace(/^(?:\$TMPDIR|\$\{TMPDIR\})(?=\/|$)/, p.tmpDir ?? "$TMPDIR")
    .replace(/^~(?=\/|$)/, p.homeDir ?? os.homedir());
  return p.protectedDirs.some(dir => inside(path.resolve(p.cwd, expanded), dir));
}
function protectedBlock(): Decision {
  return block("swarm run state/config is protected; report through swarm_report", "orchestrator", "handle run state/config through swarm_report");
}
function scoped(file: string, p: Policy): boolean {
  if (temporary(file, p)) return true;
  if (!p.writeScope.length) return !file.includes("$") && !file.startsWith("~") && inside(path.resolve(p.cwd, file), p.cwd);
  file = path.resolve(p.cwd, file);
  return p.writeScope.some(scope => scope.endsWith("/") || statSync(path.resolve(p.cwd, scope), { throwIfNoEntry: false })?.isDirectory()
    ? inside(file, path.resolve(p.cwd, scope)) : file === path.resolve(p.cwd, scope));
}

/** Strip launch wrappers so that env/sudo/xargs cannot hide the actual executable. */
function unwrap(tokens: string[]): string[] {
  let t = [...tokens];
  while (t.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { t.shift(); continue; }
    const command = path.basename(t[0]);
    if (!["sudo", "env", "command", "exec", "time", "nohup", "xargs", "nice", "timeout", "stdbuf", "npx", "bunx"].includes(command)) break;
    if (["npx", "bunx"].includes(command) && !t.slice(1).find(a => !a.startsWith("-"))?.match(/^(?:.*\/)?gh$/)) break;
    if (command === "command" && t.slice(1).some(a => /^-[^-]*[vV]/.test(a))) break;
    t.shift();
    const valueOptions: Record<string, string[]> = {
      sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group", "--host", "--prompt", "--chdir"],
      env: ["-u", "--unset", "-C", "--chdir"], exec: ["-a"],
      nice: ["-n", "--adjustment"], timeout: ["-s", "--signal", "-k", "--kill-after"],
      stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
      time: ["-o", "--output", "-f", "--format"],
      xargs: ["-n", "-P", "-I", "-L", "-s", "-a", "-E", "--max-args", "--max-procs", "--replace", "--arg-file"],
    };
    while (t[0]?.startsWith("-")) {
      const opt = t.shift()!;
      if (command === "env" && (opt === "-S" || opt === "--split-string" || opt.startsWith("--split-string=") || /^-S.+/.test(opt))) {
        const source = opt === "-S" || opt === "--split-string" ? t.shift() ?? "" : opt.startsWith("-S") ? opt.slice(2) : opt.slice(opt.indexOf("=") + 1);
        t.unshift(...(splitCommands(source)[0]?.tokens ?? []));
        break;
      }
      if (valueOptions[command]?.includes(opt)) t.shift();
      if (opt === "--") break;
    }
    if (command === "timeout") t.shift(); // duration precedes the wrapped command
  }
  return t;
}
function gitArgs(tokens: string[]): string[] {
  let i = 1;
  while (tokens[i]?.startsWith("-")) {
    const arg = tokens[i++];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) i++;
  }
  return tokens.slice(i);
}
function gitWrites(sub: string, args: string[]): boolean {
  if (sub === "stash" && ["list", "show"].includes(args[0])) return false;
  if (sub === "worktree" && args[0] === "list") return false;
  if (sub === "notes" && ["list", "show"].includes(args[0])) return false;
  if (sub === "apply" && args.includes("--check")) return false;
  if (sub === "reflog") return ["expire", "delete"].includes(args[0]);
  if ("add commit checkout switch restore reset stash rebase merge cherry-pick revert clean am apply mv rm init worktree bisect notes update-ref replace symbolic-ref update-index".split(" ").includes(sub)) return true;
  if (sub === "submodule") return ["add", "update", "sync", "deinit"].includes(args[0]);
  if (sub === "tag") return args.length > 0 && !args.some(a => a === "-l" || a === "--list");
  if (sub === "config") return !(args.length === 1 && !args[0].startsWith("-")) && !args.some(a => /^(--get(?:-all|-regexp)?|--list|-l)$/.test(a));
  if (sub === "branch") {
    if (args.some(a => /^-[^-]*[dDmMcCfC]/.test(a) || /^--(delete|move|copy|force)(?:$|=)/.test(a))) return true;
    // --list patterns and --contains/--merged revisions are read-only operands.
    if (args.some(a => ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(a))) return false;
    return args.some(a => !a.startsWith("-"));
  }
  return false;
}
function pushDanger(args: string[], p: Policy): string | undefined {
  if (args.some(a => /^--(force(?:-with-lease|-if-includes)?|mirror|delete)(=|$)/.test(a) || /^-[^-]*[fd]/.test(a) || /^[+:]/.test(a))) return "force/delete push changes remote history";
  if (args.some(a => /^(?:refs\/heads\/)?(?:main|master)$/.test(a) || /:(?:refs\/heads\/)?(?:main|master)$/.test(a))) return "push to main/master";
  // Options may have operands; do not mistake -u/--set-upstream for a refspec.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["--repo", "--receive-pack", "--exec", "--push-option", "-o"].includes(args[i])) { i++; continue; }
    if (!args[i].startsWith("-")) positional.push(args[i]);
  }
  if (positional.slice(1).some(a => /[$`]/.test(a))) return "push target contains a variable/substitution and cannot be checked";
  if ((positional.length <= 1 || positional.slice(1).some(a => a === "HEAD" || a === "@")) && ["main", "master"].includes(p.currentBranch?.() ?? "")) return "push from main/master";
}
function githubDanger(tokens: string[], p: Policy): string | undefined {
  const exe = path.basename(tokens[0] ?? "");
  if (exe === "git") {
    const [sub, ...args] = gitArgs(tokens);
    if (sub === "reset" && args.includes("--hard")) return "git reset --hard discards working-tree changes";
    if (sub === "clean" && args.some(a => /^-[^-]*f/.test(a) || a === "--force")) return "git clean removes untracked files";
    if (sub === "checkout" && (args.some(a => /^-[^-]*f/.test(a) || a === "--force") || (args.includes("--") && args.slice(args.indexOf("--") + 1).some(a => [".", "*", ":/", ":/*", ":(top)", ":(top).", ":(top)*"].includes(a))))) return "git checkout discards working-tree changes";
    if (sub === "restore" && args.some(a => [".", "*", ":/", ":/*", ":(top)", ":(top).", ":(top)*"].includes(a))) return "git restore discards whole-tree changes";
    if (sub === "stash" && ["drop", "clear"].includes(args[0])) return "git stash deletes saved changes";
    if (sub === "branch" && (args.some(a => /^-[^-]*D/.test(a)) || (args.some(a => /^-[^-]*f/.test(a) || a === "--force") && args.some(a => /^(?:main|master)$/.test(a))))) return "git branch deletes or overwrites branches";
    if (sub === "update-ref" && args.includes("-d")) return "git update-ref deletes a reference";
    if (sub === "push") return pushDanger(args, p);
    return;
  }
  if (["curl", "wget"].includes(exe) && tokens.some(a => /(?:^|\/\/)api\.github\.com(?:[/:]|$)/i.test(a))) {
    const args = tokens.slice(1);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (["-X", "--request"].includes(a) && /^(DELETE|PUT|PATCH|POST)$/i.test(args[++i] ?? "")) return "mutating GitHub API request";
      if (/^(?:-X|--request=)(?:DELETE|PUT|PATCH|POST)$/i.test(a) || /^-d|^--data(?:$|[-=])/.test(a)) return "mutating GitHub API request";
    }
  }
  if (exe !== "gh" && exe !== "hub") return;
  if (exe === "hub") {
    const [sub, ...args] = gitArgs(tokens);
    if (sub === "push") return pushDanger(args, p);
    if (sub === "merge") return "hub merge merges a pull request";
  }
  const args = exe === "hub" ? gitArgs(tokens) : tokens.slice(1);
  // gh global options can precede the command.
  while (args[0]?.startsWith("-")) { const a = args.shift(); if (a === "--repo" || a === "-R" || a === "--hostname") args.shift(); }
  const [group, sub] = args;
  const gated: Record<string, string[]> = {
    pr: ["merge", "close"], issue: ["close", "delete", "transfer"], repo: ["create", "delete", "archive", "rename", "edit"],
    alias: ["set"], label: ["delete"], run: ["delete"], cache: ["delete"], auth: ["logout"],
    release: ["create", "delete", "edit"], workflow: ["run", "enable", "disable"], secret: ["set", "delete"], variable: ["set", "delete"],
  };
  if (gated[group]?.includes(sub)) return `${exe} ${group} ${sub} changes GitHub state`;
  if (group === "pr" && sub === "review" && args.includes("--approve")) return "gh pr review approves a pull request";
  if (group === "api") {
    const graphql = args.includes("graphql");
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (["-X", "--method"].includes(a) && args[++i]?.toUpperCase() !== "GET") return "mutating GitHub API request";
      if (/^(?:--method=|-X)(?!GET$)/i.test(a) && a !== "-X") return "mutating GitHub API request";
      if (/^(?:-f|-F|--field|--raw-field|--input)(?:$|=)/.test(a) || /^-[fF].+/.test(a)) {
        if (graphql && !a.startsWith("--input")) {
          const field = ["-f", "-F", "--field", "--raw-field"].includes(a) ? args[++i] ?? "" : a.replace(/^(?:-[fF]|--(?:raw-)?field=)/, "");
          if (/\bmutation\b/.test(field)) return "GraphQL mutation changes GitHub state";
          continue;
        }
        return "GitHub API fields/input imply a mutating request";
      }
    }
  }
}

const MUTATING = new Set("rm rmdir mv cp mkdir touch tee truncate dd ln chmod chown patch install rsync".split(" "));
function packageMutation(exe: string, args: string[]): boolean {
  const operations: Record<string, string[]> = {
    npm: ["install", "i", "ci", "add", "remove", "uninstall", "update", "upgrade"],
    pnpm: ["install", "i", "ci", "add", "remove", "uninstall", "update", "upgrade"],
    yarn: ["install", "i", "ci", "add", "remove", "uninstall", "update", "upgrade"],
    bun: ["install", "i", "ci", "add", "remove", "uninstall", "update", "upgrade"],
    pip: ["install", "uninstall"], pip3: ["install", "uninstall"], bundle: ["install", "update", "add"],
    gem: ["install"], brew: ["install", "upgrade", "uninstall"], cargo: ["add", "install"], go: ["get"],
  };
  let i = 0;
  while (args[i]?.startsWith("-")) {
    const option = args[i++];
    if (["--prefix", "--cwd", "--dir", "-C", "--cache", "--registry", "--userconfig", "--config", "--root", "--target", "--install-dir", "--path"].includes(option)) i++;
  }
  return !!operations[exe]?.includes(args[i] ?? "");
}
function packageDestinations(exe: string, args: string[]): string[] {
  const flags: Record<string, string[]> = {
    npm: ["--prefix"], pnpm: ["--dir", "-C"], yarn: ["--cwd"], bun: ["--cwd"],
    pip: ["--target", "-t", "--prefix", "--root"], pip3: ["--target", "-t", "--prefix", "--root"],
    bundle: ["--path"], gem: ["--install-dir", "-i"], cargo: ["--root"],
  };
  const destinations: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const [flag, ...value] = args[i].split("=");
    if (flags[exe]?.includes(flag)) destinations.push(value.length ? value.join("=") : args[++i] ?? "");
  }
  // A global install can affect the machine regardless of the local project destination.
  if (args.includes("-g") || args.includes("--global")) return [];
  return destinations;
}
/** Destination/all path operands for the explicitly recognized file-writing commands. */
function mutationPaths(exe: string, args: string[]): string[] {
  const operands: string[] = [];
  let destination: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["-t", "--target-directory", "--output", "-o"].includes(arg)) { destination = args[++i]; continue; }
    if (arg.startsWith("--target-directory=")) { destination = arg.slice(arg.indexOf("=") + 1); continue; }
    if (!arg.startsWith("-") || arg === "-") operands.push(arg);
  }
  if (exe === "dd") return args.filter(a => a.startsWith("of=")).map(a => a.slice(3));
  if (exe === "mv") return destination ? [...operands, destination] : operands;
  if (["cp", "ln", "install", "rsync"].includes(exe)) return destination ? [destination] : operands.slice(-1);
  if (["chmod", "chown"].includes(exe)) return operands.slice(1);
  if (exe === "sed" || exe === "perl") return operands.slice(1);
  // patch may target files named inside its input; there is no trustworthy path operand.
  if (exe === "patch") return [];
  return operands;
}

export function decide(toolName: string, input: Record<string, unknown>, p: Policy): Decision {
  if (p.role === "orchestrator") return toolName.startsWith("swarm_") ? ALLOW : block("orchestrator delegates; use swarm_spawn", "orchestrator", "delegate with swarm_spawn");
  if (toolName === "subagent") return block("only the orchestrator spawns agents; swarm_report HANDOFF", "orchestrator", "spawn the required worker");
  if (toolName === "edit" || toolName === "write") {
    const target = String(input.path ?? "");
    if (protectedPath(target, p)) return protectedBlock();
    const file = path.resolve(p.cwd, target);
    if (p.caps.has("edit") || p.caps.has("edit-tests")) {
      if (!scoped(target, p)) return block("outside your task's files; QUESTION orchestrator", "orchestrator", "clarify the task's file scope");
      if (p.caps.has("edit") || testFile(file, p) || temporary(file, p)) return ALLOW;
      return block("tester edits test files only; HANDOFF impl/debugger for source changes", "impl/debugger", "make the source changes");
    }
    return block(`${p.role} is read-only; HANDOFF impl`, "impl", "edit the project files");
  }
  if (toolName !== "bash" && toolName !== "powershell") {
    if (["read", "grep", "find", "ls"].includes(toolName) || toolName.startsWith("swarm_")) return ALLOW;
    if (/github/i.test(toolName)) return p.caps.has("github") ? ALLOW : block(`${p.role} may not use GitHub`, "github", "perform this GitHub operation");
    if (toolName === "codemode" || !p.caps.size || p.allowTools.includes(toolName) || p.toolInfo?.(toolName)?.readOnly) return ALLOW;
    return block(`${p.role} may not use unclassified tool ${toolName}`, "orchestrator", "delegate or explicitly allow this tool");
  }
  let segments: CommandSegment[];
  try { segments = splitCommands(String(input.command ?? "")); }
  catch { return block("command too complex for the guard; split it", "orchestrator", "split the command into guardable steps"); }
  let approval: Decision = ALLOW;
  const tempVariables = new Set<string>();
  for (const segment of segments) {
    // Trust only simple, same-command mktemp assignments, never arbitrary shell variables.
    for (const token of segment.tokens) {
      const assignment = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (!assignment) break;
      const [, name, value] = assignment;
      tempVariables.delete(name);
      if (segment.substitutedAssignments?.includes(token) && /^\$\(mktemp(?:\s[^()]*)?\)$/.test(value)) {
        const [creation] = splitCommands(value.slice(2, -1));
        const operands = creation.tokens.slice(1);
        if (!operands.length || operands.every(arg => arg === "-d" || arg === "--directory" || temporary(arg, p))) tempVariables.add(name);
      }
    }
    const t = unwrap(segment.tokens);
    const exe = path.basename(t[0] ?? ""), args = t.slice(1);
    if (segment.piped && ["bash", "sh", "zsh", "fish"].includes(exe) && !p.caps.has("github")) return block("piping into a shell cannot be checked", "orchestrator", "delegate this script to the appropriate worker");
    for (const target of segment.redirects) {
      if (protectedPath(target, p)) return protectedBlock();
      const variable = target.match(/^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/);
      const tempVariable = variable && tempVariables.has(variable[1] ?? variable[2]);
      const device = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].includes(target) || /^\/dev\/fd\/[^/]+$/.test(target);
      if (device || tempVariable) continue;
      if ((p.caps.has("edit") || p.caps.has("edit-tests")) && !scoped(target, p)) return block("outside your task's files; QUESTION orchestrator", "orchestrator", "clarify the task's file scope");
      if (!p.caps.has("edit") && !temporary(target, p)) return block(`${p.role} may not redirect output to project files`, "impl", "write that file");
    }
    if (["bash", "sh", "zsh", "fish"].includes(exe) && args.some(a => /^-[^-]*c/.test(a))) {
      const index = args.findIndex(a => /^-[^-]*c/.test(a));
      const d = decide("bash", { command: args[index + 1] ?? "" }, p);
      if (d.action === "block") return d;
      if (d.action === "confirm") approval = d;
    }
    if (exe === "eval") {
      const d = decide("bash", { command: args.join(" ") }, p);
      if (d.action === "block") return d;
      if (d.action === "confirm") approval = d;
    }
    if (/^(?:node|python[\d.]*|ruby|perl|deno|bun)$/.test(exe)) {
      const code: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (["eval", "--eval", "--print", "--command", "-e", "-c", "-p"].includes(args[i]) || /^-[^-]*[ecp]$/.test(args[i])) code.push(args[i + 1] ?? "");
        else if (/^(?:--(?:eval|print|command)=|-[ecp].+)/.test(args[i])) code.push(args[i].replace(/^(?:--[^=]+=|-[ecp])/, ""));
      }
      if (code.some(text => /\bSWARM_(?:RUN_DIR|HOME)\b/.test(text) || p.protectedDirs.some(dir => {
        if (text.includes(dir)) return true;
        if (!p.homeDir || !inside(dir, p.homeDir)) return false;
        const rel = path.relative(p.homeDir, dir).split(path.sep).join("/");
        return [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`].some(literal => text.includes(literal));
      }))) return protectedBlock();
      if (code.some(text => /api\.github\.com|\bgh\s|\bgit\s+(?:[^\s]+\s+)*(?:push|pull|fetch|clone|add|commit|checkout|switch|restore|reset|stash|rebase|merge|cherry-pick|revert|clean|am|apply|mv|rm|init|worktree|bisect|notes|update-ref|replace|symbolic-ref|update-index|submodule|tag|config|branch|remote)\b/i.test(text))) return block("run git directly instead of through an interpreter", "github", "run the GitHub/git operation directly");
    }
    if (exe === "swarm") return block("only the orchestrator controls swarm agents", "orchestrator", "perform agent control");
    if (exe === "herdr" && !(args[0] === "agent" && args[1] === "prompt" && [p.orchestrator, "$SWARM_ORCHESTRATOR", "${SWARM_ORCHESTRATOR}"].includes(args[2]))) return block("workers may only prompt their orchestrator with herdr", "orchestrator", "perform agent/pane control");
    if (exe === "herdr" && !/^(DONE|QUESTION|HANDOFF) /.test(args[3] ?? "")) return block("orchestrator prompts must be DONE, QUESTION or HANDOFF reports", "orchestrator", "receive the report through swarm_report");
    if (exe === "pi" && !(args.length && args.every(a => ["--version", "--help", "--list-models"].includes(a)))) return block("only the orchestrator spawns agents", "orchestrator", "spawn the required worker");
    let github = exe === "gh" || exe === "hub" || (["curl", "wget"].includes(exe) && args.some(a => /(?:^|\/\/)api\.github\.com(?:[/:]|$)/i.test(a)));
    if (exe === "git") {
      const [sub, ...ga] = gitArgs(t);
      github ||= ["push", "pull", "fetch", "clone", "ls-remote"].includes(sub) || (sub === "remote" && ["add", "remove", "rm", "set-url", "rename"].includes(ga[0]));
      if (gitWrites(sub, ga) && !p.caps.has("git-write")) return block(`${p.role} may not change git's shared working tree/history`, "github", "perform this git write");
    }
    if (github && !p.caps.has("github")) return block(`${p.role} may not use GitHub`, "github", "perform this GitHub operation");
    if (p.caps.has("github")) {
      const ghArgs = [...args];
      while (ghArgs[0]?.startsWith("-")) { const option = ghArgs.shift(); if (["--repo", "-R", "--hostname"].includes(option!)) ghArgs.shift(); }
      const publishing = (exe === "git" && gitArgs(t)[0] === "push") || (exe === "hub" && ["push", "pull-request"].includes(gitArgs(t)[0])) || (exe === "gh" && ghArgs[0] === "pr" && ["create", "ready", "merge"].includes(ghArgs[1]));
      const review = publishing ? p.publishCheck?.() : undefined;
      const danger = githubDanger(t, p);
      const reasons: string[] = [];
      if (danger) reasons.push(danger + "; only the USER may approve this action");
      if (review && !review.ok) reasons.push(`unreviewed or stale review: ${review.why}`);
      if (reasons.length) approval = confirm(reasons.join("; "));
    }
    const mutating = MUTATING.has(exe) || (exe === "sed" && args.some(a => /^-[^-]*i|^--in-place/.test(a))) || (exe === "perl" && args.some(a => /^-[lpnaswtTuUWX0-9]*i/.test(a)));
    if (mutating) {
      const targets = mutationPaths(exe, args);
      if (targets.some(file => protectedPath(file, p))) return protectedBlock();
      if ((p.caps.has("edit") || p.caps.has("edit-tests")) && targets.some(file => !scoped(file, p))) return block("outside your task's files; QUESTION orchestrator", "orchestrator", "clarify the task's file scope");
    }
    if (!p.caps.has("edit")) {
      if (packageMutation(exe, args)) {
        const destinations = packageDestinations(exe, args);
        if (!destinations.length || !destinations.every(file => file && temporary(file, p))) return block(`${p.role} may not install/change packages`, "impl", "change dependencies");
      }
      if (mutating) {
        const targets = mutationPaths(exe, args);
        const tempOnly = targets.length > 0 && targets.every(file => temporary(file, p));
        const testsOnly = p.caps.has("edit-tests") && ["mkdir", "touch", "cp"].includes(exe) && targets.length > 0 && targets.every(file => testFile(file, p) && scoped(path.resolve(p.cwd, file), p));
        if (!tempOnly && !testsOnly) return block(`${p.role} may not mutate project files with ${exe}`, "impl/debugger", "make these file changes");
      }
    }
  }
  return approval;
}
