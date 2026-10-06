import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../swarm", import.meta.url));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "swarm-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const install = join(root, "install");
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    ...process.env, HOME: home, HERDR_BIN_PATH: "/bin/true",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    SWARM_ORCHESTRATOR: "", SWARM_RUN_DIR: "",
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8", env });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, work);
  mkdirSync(join(work, "agents"));
  // Commit the exact script under test so the install clone is clean, not a
  // locally modified launcher that accidentally blocks an incoming update.
  copyFileSync(script, join(work, "swarm"));
  writeFileSync(join(work, "install.sh"), '#!/usr/bin/env bash\nprintf "installed\\n" > "$(dirname "$0")/install-marker"\n');
  writeFileSync(join(work, "agents", "impl.md"), "original agent\n");
  writeFileSync(join(work, "notes.txt"), "original notes\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "initial install");
  git(work, "push", "origin", "main");
  git(root, "clone", origin, install);
  copyFileSync(script, join(install, "swarm"));
  const head = () => git(install, "rev-parse", "HEAD");
  const initial = head();
  const invoke = (...args: string[]) => {
    const r = spawnSync("bash", [join(install, "swarm"), ...args], { encoding: "utf8", env });
    return { ...r, output: r.stdout + r.stderr };
  };
  const upstream = (path = "release.txt", contents = "new release\n") => {
    writeFileSync(join(work, path), contents);
    git(work, "add", ".");
    git(work, "commit", "-m", "new release");
    git(work, "push", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  };
  return { root, origin, work, install, home, env, git, head, initial, invoke, upstream };
}

test("update is already up to date without running installer", (t) => {
  const f = fixture(t);
  const r = f.invoke("update");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Already up to date/);
  assert.equal(f.head(), f.initial);
  assert.equal(existsSync(join(f.install, "install-marker")), false);
  const check = f.invoke("update", "--check");
  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /Already up to date/);
});

test("--check reports update and changelog without moving HEAD or installing", (t) => {
  const f = fixture(t);
  f.upstream();
  const r = f.invoke("update", "--check");
  assert.equal(r.status, 10, r.output);
  assert.match(r.output, /Current .* -> new/);
  assert.match(r.output, /Changelog:[\s\S]*new release/);
  assert.equal(f.head(), f.initial);
  assert.equal(existsSync(join(f.install, "release.txt")), false);
  assert.equal(existsSync(join(f.install, "install-marker")), false);
});

test("update fast-forwards and re-runs installer", (t) => {
  const f = fixture(t);
  const next = f.upstream();
  const r = f.invoke("update");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.head(), next);
  assert.match(r.output, /Updated .* -> .*Restart running swarms/);
  assert.equal(readFileSync(join(f.install, "install-marker"), "utf8"), "installed\n");
  // The fixture installer must not create real installation settings.
  assert.equal(existsSync(join(f.home, ".config")), false);
});

test("overlapping tracked agent edits are refused and kept intact", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.install, "agents", "impl.md"), "my config\n");
  f.upstream("agents/impl.md", "upstream config\n");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /local changes would be overwritten.*agents\/impl.md/);
  assert.equal(f.head(), f.initial);
  assert.equal(readFileSync(join(f.install, "agents", "impl.md"), "utf8"), "my config\n");
});

test("unrelated staged and unstaged edits, custom agents and per-run state survive", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.install, "agents", "impl.md"), "my config\n");
  f.git(f.install, "add", "agents/impl.md");
  writeFileSync(join(f.install, "notes.txt"), "my notes\n");
  writeFileSync(join(f.install, "agents", "custom.md"), "custom agent\n");
  const state = join(f.root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "policy.json"), '{"require":["tester"]}\n');
  f.env.SWARM_RUN_DIR = state;
  const next = f.upstream();
  const r = f.invoke("update");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.head(), next);
  assert.equal(readFileSync(join(f.install, "agents", "impl.md"), "utf8"), "my config\n");
  assert.equal(readFileSync(join(f.install, "notes.txt"), "utf8"), "my notes\n");
  assert.equal(readFileSync(join(f.install, "agents", "custom.md"), "utf8"), "custom agent\n");
  assert.equal(readFileSync(join(state, "policy.json"), "utf8"), '{"require":["tester"]}\n');
  assert.match(r.output, /Warning: running inside a swarm/);
});

test("incoming untracked custom agent collision is refused", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.install, "agents", "custom.md"), "my custom\n");
  f.upstream("agents/custom.md", "upstream custom\n");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /local changes would be overwritten/);
  assert.equal(f.head(), f.initial);
  assert.equal(readFileSync(join(f.install, "agents", "custom.md"), "utf8"), "my custom\n");
});

test("non-clone install is rejected", (t) => {
  const f = fixture(t);
  rmSync(join(f.install, ".git"), { recursive: true, force: true });
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /not a git clone/);
});

test("detached HEAD is rejected", (t) => {
  const f = fixture(t);
  f.git(f.install, "checkout", "--detach");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /detached HEAD/);
  assert.equal(f.head(), f.initial);
});

test("unreachable origin leaves files and HEAD untouched", (t) => {
  const f = fixture(t);
  f.git(f.install, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const before = f.git(f.install, "status", "--porcelain");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /couldn't reach origin/);
  assert.equal(f.head(), f.initial);
  assert.equal(f.git(f.install, "status", "--porcelain"), before);
});

test("local commits ahead of origin are reported up to date", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.install, "local.txt"), "local commit\n");
  f.git(f.install, "add", "local.txt");
  f.git(f.install, "commit", "-m", "local change");
  const local = f.head();
  for (const args of [["update", "--check"], ["update"]]) {
    const r = f.invoke(...args);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /Already up to date .*local commits ahead of origin\/main/);
    assert.equal(f.head(), local);
  }
  assert.equal(existsSync(join(f.install, "install-marker")), false);
});

test("divergence is refused by --check and update, tree untouched", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.install, "local.txt"), "local commit\n");
  f.git(f.install, "add", "local.txt");
  f.git(f.install, "commit", "-m", "local change");
  const local = f.head();
  f.upstream();
  const before = f.git(f.install, "status", "--porcelain");
  for (const args of [["update", "--check"], ["update"]]) {
    const r = f.invoke(...args);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /local commits; merge manually/);
    assert.equal(f.head(), local);
    assert.equal(f.git(f.install, "status", "--porcelain"), before);
  }
  assert.equal(existsSync(join(f.install, "release.txt")), false);
});

test("staged rename whose old path changes upstream is refused", (t) => {
  const f = fixture(t);
  f.git(f.install, "mv", "agents/impl.md", "agents/impl-renamed.md");
  f.upstream("agents/impl.md", "upstream config\n");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /local changes would be overwritten.*agents\/impl\.md/);
  assert.equal(f.head(), f.initial);
  assert.ok(existsSync(join(f.install, "agents", "impl-renamed.md")));
});

test("ignored local file colliding with incoming new file is refused", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.install, ".git", "info", "exclude"), "*.secret\n");
  writeFileSync(join(f.install, "notes.secret"), "ignored local\n");
  f.upstream("notes.secret", "upstream secret\n");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /local changes would be overwritten.*notes\.secret/);
  assert.equal(f.head(), f.initial);
  assert.equal(readFileSync(join(f.install, "notes.secret"), "utf8"), "ignored local\n");
});

test("help mentions update, update help works and invalid flags exit 2", (t) => {
  const f = fixture(t);
  const help = f.invoke("--help");
  assert.equal(help.status, 0, help.output);
  assert.match(help.output, /swarm update \[--check\]/);
  assert.equal(f.invoke("update", "-h").status, 0);
  assert.equal(f.invoke("update", "--unknown").status, 2);
});

test("installer failure reports that HEAD was updated", (t) => {
  const f = fixture(t);
  const next = f.upstream("install.sh", "#!/usr/bin/env bash\nexit 7\n");
  const r = f.invoke("update");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /updated, but install.sh failed; re-run it/);
  assert.equal(f.head(), next);
});

test("launcher can replace itself safely during update", (t) => {
  const f = fixture(t);
  const next = f.upstream("swarm", "#!/usr/bin/env bash\necho replacement-launcher\nexit 99\n");
  const r = f.invoke("update");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.head(), next);
  assert.match(r.output, /Updated/);
  assert.doesNotMatch(r.output, /replacement-launcher/);
  assert.ok(existsSync(join(f.install, "install-marker")));
});
