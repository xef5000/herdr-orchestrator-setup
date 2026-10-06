import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ReportInput {
  worker: string;
  role: string;
  kind: string;
  verdict?: string | null;
  tree?: string | null;
  artifact: string;
  id?: string;
  ts?: number;
}
export interface ReportEvent extends ReportInput { t: "report"; id: string; ts: number }

/** A partial final line or corrupt entry must not hide the remaining evidence. */
export function parseEvents(jsonl: string): unknown[] {
  const events: unknown[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* Skip malformed lines. */ }
  }
  return events;
}

export function reportEvent({ worker, role, kind, verdict, tree, artifact, id = randomUUID(), ts = Date.now() }: ReportInput): ReportEvent {
  return { t: "report", ts, id, worker, role, kind, verdict, tree, artifact };
}

/** Stage into a private copy of the index, never the user's real staging area. */
export function treeFingerprint(cwd: string): string | undefined {
  let directory: string | undefined;
  try {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    const git = (args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const index = resolve(cwd, git(["rev-parse", "--git-path", "index"]));
    directory = mkdtempSync(join(tmpdir(), "swarm-index-"));
    const temporaryIndex = join(directory, "index");
    try { copyFileSync(index, temporaryIndex); }
    catch (error) {
      // New repositories have no index yet; Git creates a valid empty index itself.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    env.GIT_INDEX_FILE = temporaryIndex;
    git(["add", "-A"]);
    return git(["write-tree"]);
  } catch { return undefined; }
  finally {
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
    }
  }
}

function isReport(event: unknown): event is ReportEvent {
  return typeof event === "object" && event !== null && "t" in event && event.t === "report";
}

/** JSONL append order is authoritative, including reports with equal timestamps. */
export function latestReport(events: readonly unknown[], worker: string, sinceTs: number): ReportEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (isReport(event) && event.worker === worker && event.ts >= sinceTs) return event;
  }
  return undefined;
}

export function publishStatus(events: readonly unknown[], requireRoles: string[], currentTree?: string): { ok: boolean; why: string } {
  for (const role of requireRoles) {
    let report: ReportEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      // Implementation output is not independent review evidence, even if required accidentally.
      if (isReport(event) && event.kind === "DONE" && !/^impl(?:-|$)/.test(event.role) && event.role === role && event.verdict != null) {
        report = event;
        break;
      }
    }
    if (!report) return { ok: false, why: `Missing verdict for required role ${role}` };
    if (report.verdict !== "pass") return { ok: false, why: `Required role ${role} failed (${report.verdict})` };
    if (!currentTree || !report.tree) return { ok: false, why: `Unknown tree for required role ${role}` };
    if (report.tree !== currentTree) return { ok: false, why: `Stale verdict for required role ${role}: tree has changed` };
  }
  return { ok: true, why: "All required roles passed on the current tree" };
}
