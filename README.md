# herdr-swarm

An **orchestrator-driven agent swarm** for [herdr](https://herdr.dev) + [pi](https://github.com/earendil-works/pi-mono).

One click opens a tab with a single **orchestrator** agent. You tell it what you want. It spawns
specialised workers into the same tab as it needs them — a planner, cheap or strong implementers, a
reviewer, a debugger, a GitHub expert… — gives them self-contained tasks, collects their reports, and
closes them when they're done. Every worker is a normal interactive pi pane you can click into.

```
 you ──▶ ┌──────────────┬──────────────┐
         │ orchestrator │   planner    │      swarm spawn planner   --task "..." --wait
         │              ├──────────────┤      swarm spawn impl      --task "..."
         │              │    impl      │      swarm spawn impl-pro  --task "..."
         ├──────────────┼──────────────┤      swarm spawn reviewer  --task "..." --wait
         │   impl-pro   │   reviewer   │      swarm close impl
         └──────────────┴──────────────┘
```

## Agent types

Defined in [`agents/`](agents) — one Markdown file per type, with model + thinking level in the frontmatter.
Add a file, and the orchestrator can spawn it; no other change needed. Agent types are loaded when the
swarm starts and cached by the orchestrator, so a type added mid-run is picked up when it is first
requested (a missing type triggers a refresh).

### Your own agent types

| source | directory |
|---|---|
| `project` | `.swarm/agents/` in the swarm's project dir, only with `SWARM_PROJECT_AGENTS=1` |
| `env` | `$SWARM_AGENTS_DIR` |
| `xdg` | `${XDG_CONFIG_HOME:-~/.config}/herdr-swarm/agents/` |
| `built-in` | `agents/` |

- The first `<type>.md` found wins, and a same-name file replaces the built-in entirely (no frontmatter merge).
- `swarm types` shows the source.
- `orchestrator` always comes from `agents/orchestrator.md`.
- Names allow only letters, digits, `.`, `_` and `-`.
- The project folder is opt-in because a repository could otherwise widen `caps:` or replace `reviewer`.
- The variables are read when you run `swarm` and are passed into the swarm tab.
- Custom types kept here are never touched by `swarm update`.

| type | what it does | scope (enforced) | default model |
|---|---|---|---|
| `orchestrator` | Coordinates. Plans, spawns/closes workers, never edits code. **The only agent that starts, and the one you talk to.** | swarm_plan + swarm_* tools | claude-sonnet-5-5 · medium |
| `planner` | Read-only. Turns a goal into explicit tasks tagged `[simple]` / `[hard]`. | read-only | claude-opus-5-5 · xhigh |
| `impl` | Cheap & fast implementer for well-specified `[simple]` tasks. | edit files | deepseek-v4.1-flash · max |
| `impl-pro` | Stronger implementer for `[hard]` tasks. | edit files | gpt-6.1-sol · medium |
| `reviewer` | Read-only review; approves or requests changes with file:line findings. | read-only | claude-opus-5-5 · high |
| `debugger` | Reproduces and root-causes failures; minimal fix. | edit files | claude-opus-5-5 · high |
| `tester` | Writes and runs tests. | test files only | gpt-6.1-sol · medium |
| `github` | PRs, issues, CI logs, reviews via `gh`. Never force-pushes or merges unasked. | git write + GitHub, no file edits | claude-sonnet-5-5 · medium |
| `researcher` | Read-only answers about libraries, APIs, docs, the codebase. | read-only | claude-sonnet-5-5 · medium |

> Model IDs are the ones available in the author's org. Run `pi --list-models` and edit the
> frontmatter in `agents/*.md` if yours differ, or override the type in
> `${XDG_CONFIG_HOME:-~/.config}/herdr-swarm/agents/`.
>
> No `caps:` in the frontmatter means **read-only** — a type only gets write access it asks for.

## Scopes & enforcement

Agent scopes are **enforced**, not just prose. The frontmatter of `agents/<type>.md` sets the scope, and the
`swarm` script turns it into pi flags (`--tools` / `--exclude-tools`), environment (`SWARM_ROLE`, `SWARM_CAPS`)
and the `extensions/swarm-guard.ts` extension, which checks every tool call against the rules in
`extensions/swarm-policy.ts`.

Frontmatter keys:

- `use_for:` one-line routing hint shown to the orchestrator in its agent table.
- `caps:` comma list from `edit`, `edit-tests`, `git-write`, `github` — or `none`. **Missing = none = read-only.**
- `tools:` exact comma-separated tool allowlist (orchestrator only; the `swarm_*` tools).
- `prompt_mode: replace` — use the body as the whole system prompt instead of appending it (orchestrator only).
- `context_files: off` — start without project context files (orchestrator only).
- `test_paths:` optional JavaScript test-path regex, overriding the guard's default (tester).

What the guard does:

- A tool call outside the role's scope is **blocked** with a reason that names whom to hand the work off to,
  e.g. `swarm guard: impl may not use GitHub. Hand off: swarm_report HANDOFF 'github should …'`. A blocked
  worker hands the work off instead of working around it.
- **Approval dialogs**: force-push, push to `main`/`master`, `gh pr merge`, closing/deleting issues or repos,
  releases and other mutating `gh api` calls make the worker show as `blocked` and open a dialog **in that
  worker's pane**. The orchestrator tells you what it asks; you approve or decline there. A declined action is
  never retried another way.
- Workers report with the `swarm_report` tool (`DONE` / `QUESTION` / `HANDOFF`). The orchestrator has **only**
  `swarm_*` tools — no shell, file, web or GitHub access — so everything else is delegated.
- Inspect the exact pi flags a type gets: `swarm args <type>`.
- Run the guard/policy tests: `node --test`.

**Limits.** The guard is a guardrail against over-eager models, not a sandbox. It cannot catch
`find -delete`/`-exec rm`, `python -c`, `node -e`, running scripts, variable-named commands, or GitHub
access via MCP/codemode tools.

---

## Invariants & threat model

These hold no matter what the user, the orchestrator or a worker says. They are what makes a "done"
from the swarm trustworthy.

**Verdicts are authentic.** `pass`/`fail` verdicts come *only* from the `reviewer` and `tester` agents,
and only through the `verdict` field of `swarm_report`. A verdict counts only on a `DONE` report; a
`pass`/`fail` attached to a `QUESTION` or `HANDOFF` is not review evidence, and a report without a
verdict from those two types is not a review. The `verdict: required` frontmatter on those agents makes
`swarm_report` refuse their `DONE` without one, and `impl*` reports are never accepted as review
evidence even if named in `SWARM_PUBLISH_REQUIRE`.

**Publish gate.** Pushing to the hub — `git push`, `gh pr create`/`ready`/`merge` by the `github` role
— asks the user to confirm **only when evidence is missing or stale**: no fresh `reviewer` (or other
required role) `DONE` with `verdict: "pass"` whose recorded tree fingerprint equals the current working
tree. A fresh pass goes straight through; dangerous-action confirms (force-push, push to
`main`/`master`, …) still apply even then. The fingerprint is `git add -A` + `write-tree` over the
**working tree**, not the ref being pushed: a push of another branch or a partial commit is not
distinguished, so the gate is a reminder, not a proof. Any file changed after a review makes that review
stale; a `tester` that changes the tree during its turn records `tree=null` — re-run it on the final
tree to satisfy `require: tester`.

**Protected directories.** These paths are protected from every worker, whatever its `caps:` —
`SWARM_HOME` (this repo), `SWARM_RUN_DIR` (the run's state dir), `~/.pi/agent` (pi config), the default
`${XDG_CONFIG_HOME:-~/.config}/herdr-swarm/agents/` folder, `$SWARM_AGENTS_DIR` when set, and the
project's `.swarm/agents/` when `SWARM_PROJECT_AGENTS=1` — and each is dropped if the project directory
lies inside it. `edit`/`write` and shell writes to them are blocked with a reason telling you to report
through `swarm_report` instead. The xdg folder sits outside `SWARM_HOME` and is explicitly guarded, not
merely left out of the write scope. Protecting the project's `.swarm/agents/` is **best-effort**: like
every protected path it depends on the heuristic shell scanner, which refuses what it cannot parse but
can still be bypassed by a determined worker (see the threat model). `.git/`, `.github/`, `node_modules/`
and `.env` are **not** specially protected; they are only covered by the normal write scope and
capability rules.

**Write scope.** By default a write-capable worker may edit the project working tree and temp
directories, and nothing else. Narrow it with `SWARM_WRITE_SCOPE` (comma-separated files/directories,
no trailing slash needed on directories) or `swarm spawn <type> --scope "a,b"`; the orchestrator passes
the same scope through its `swarm_spawn` `files` parameter. Paths outside the scope are blocked with a
reason, not silently ignored. `cd` is not tracked — paths resolve against the pane's start dir.

**MCP tool policy.** Read-only roles (`caps: none`) may call any MCP tool. Roles with `edit`, `git-write`
or `github` caps may only call non-built-in tools that are explicitly read-only (the `readOnlyHint`
annotation) or listed in the agent's `allow_tools:` frontmatter (a comma list, passed to the worker as
`SWARM_ALLOW_TOOLS`). `codemode` is always allowed. Any tool whose name contains `github` needs the
`github` cap, **even for read-only roles**. A non-annotated extension tool (e.g. a web search) is
blocked for an edit/git/github role until you list it in `allow_tools:`.

**Orchestrator messages.** A worker's `herdr agent prompt` to the orchestrator must start with `DONE`,
`QUESTION` or `HANDOFF` (`KIND name [r:ID verdict:V]: message`), so the orchestrator's inbox stays
parseable. Reports are delivered **once**: one already returned by `swarm_wait` is deduped from the
inbox, and one that arrived while the orchestrator was in an approval dialog or otherwise busy is
recorded as `undelivered` and replayed automatically on a later turn (the hidden state lists what is
pending).

**State directory.** Run state lives under
`${SWARM_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/herdr-swarm}/runs/…` — one directory per run,
holding `events.jsonl` and `artifacts/` — and runs older than 14 days are pruned when a swarm starts. It
is state, not project data — never commit it.

**No limits.** There are **no** limits on the number of workers, rounds or spawns. The orchestrator may
spawn as many workers as a task needs and may replace a worker rather than reuse it.

### Threat model

The guards are a guardrail against **over-eager models**, not a sandbox against **adversaries**. They
stop an agent that is trying to do the right thing but reaches for the wrong tool; they do not stop an
agent that is actively trying to escape. Known limits, by design:

- Anything a worker hides inside a script it writes and runs — `npm run`/`make` targets, test/build
  hooks, a downloaded binary — is opaque to the guard.
- The shell scanner refuses constructs it cannot parse rather than guessing, but a determined agent can
  still smuggle work through a file, an environment variable or a subprocess.
- MCP/codemode servers run outside the shell guard; the MCP tool policy above is a routing rule, not a
  sandbox.
- The publish fingerprint covers the whole working tree, not the exact ref being pushed, so it can be
  fresh-but-partial; it is a reminder, not a proof.

Treat the working tree and the machine as trusted. If they are not, run the swarm in a container or VM.

---

## Install

### Prerequisites (all platforms)

1. **herdr** ≥ 0.9 — <https://herdr.dev/docs/install/>
2. **pi** on your `PATH` — `npm install -g @mariozechner/pi-coding-agent` (run `pi` once to log in to a provider)
3. **jq**

### macOS

```sh
brew install herdr jq                    # if needed
git clone https://github.com/xef5000/herdr-swarm ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
```

You get:
- **`~/Applications/Herdr Swarm.app`** → Finder → your home folder → `Applications`, drag it to the Dock. Click it to start a swarm. *(First click: allow the macOS permission prompt.)*
- the `swarm` command in any herdr terminal pane
- the **⌃ control + ⇧ shift + S** shortcut inside herdr

### Windows

herdr runs natively on Windows, but `swarm` is a bash script. Two options:

#### Option A — WSL2 (recommended)

Everything (herdr, pi, this repo) lives inside WSL; identical to the Linux setup and the tested path.

```powershell
wsl --install -d Ubuntu          # once; reboot; open "Ubuntu" from the Start menu
```

In the Ubuntu terminal:

```sh
sudo apt update && sudo apt install -y jq git curl
curl -fsSL https://herdr.dev/install.sh | sh
# node + pi, if missing:
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
npm install -g @mariozechner/pi-coding-agent
git clone https://github.com/xef5000/herdr-swarm ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
herdr
```

Start a swarm with `swarm` in a pane or **Ctrl+Shift+S**. [Windows Terminal](https://aka.ms/terminal) with the Ubuntu profile works best.

#### Option B — native Windows + Git Bash (best-effort)

1. `powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"`
2. Install [Git for Windows](https://git-scm.com/download/win), [Node.js](https://nodejs.org), and jq (`winget install jqlang.jq`).
3. In **Git Bash**:
   ```sh
   npm install -g @mariozechner/pi-coding-agent
   git clone https://github.com/xef5000/herdr-swarm ~/.config/herdr/swarm
   ~/.config/herdr/swarm/install.sh
   ```
4. Make herdr open Git Bash panes — in `%USERPROFILE%\.config\herdr\config.toml`:
   ```toml
   default_shell = "C:\\Program Files\\Git\\bin\\bash.exe"
   ```
   then `herdr server reload-config`.

On native Windows herdr can't confirm a pane's shell is idle, so `swarm` waits a few seconds instead
(`SWARM_SHELL_WAIT=8` if your shell starts slowly). If anything misbehaves, use Option A.

### Linux

```sh
sudo apt install -y jq
curl -fsSL https://herdr.dev/install.sh | sh
npm install -g @mariozechner/pi-coding-agent
git clone https://github.com/xef5000/herdr-swarm ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
```

Also adds a **"Herdr Swarm"** entry to your desktop app launcher.

### Update

For a standard git-clone install:

```sh
swarm update          # fetch origin/main, fast-forward, then re-run install.sh
swarm update --check  # show current/new commits and a short changelog; don't apply
```

`swarm update` fast-forwards the currently checked-out branch to `origin/main`; a branch that is
only ahead of `origin/main` with local commits is reported as already up to date.
Checking needs only Git, not a running herdr. `--check` exits **0** when up to date,
**10** when an update is available, **1** on failure, or **2** for invalid arguments.
A normal update exits **0** on success/already up to date, **1** on failure, or **2**
for invalid arguments. Checking fetches remote metadata but leaves HEAD, files and
installation settings unchanged.

Your configuration means edits to `agents/*.md` and untracked custom agent files.
Agent types in `${XDG_CONFIG_HOME:-~/.config}/herdr-swarm/agents/`, `$SWARM_AGENTS_DIR` or a project's
`.swarm/agents/` are outside the tracked tree and never updated.
Non-overlapping local edits and custom files are kept unchanged; if incoming files
would overlap them, the update refuses rather than stashing or overwriting them.
Local commits/diverged branches also require a manual merge. Detached HEADs,
non-git installs and missing/unreachable `origin` remotes produce an error.
Per-run state (including `policy.json` in the run directory) is not user configuration
and is left alone. Restart running swarms after updating to load the new extensions.

`install.sh` is safe to re-run: it refreshes the launcher/integration and adds missing
shell aliases/keybindings without duplicating them. If installation fails after the
fast-forward, the update reports that the code was updated and asks you to re-run
`install.sh`. The manual alternative is `git pull --ff-only origin main` inside
`~/.config/herdr/swarm`, followed by `./install.sh` (resolve any local conflicts first).

---

## Use

Start a swarm with any of:

- 🖱️ click **Herdr Swarm** (Dock on macOS / app menu on Linux)
- ⌨️ type **`swarm`** in any herdr terminal pane (not inside an agent) and press Enter
- ⌨️ press **Ctrl+Shift+S** inside herdr (Mac: ⌃ control + ⇧ shift + S)

A tab `swarm:<project>` opens with just the orchestrator, in the project of the pane you had focused.
**Type what you want built.** Watch workers appear as panes beside it; click any of them to see or
talk to it. When the orchestrator is done it reports back and closes its workers.

```sh
swarm --goal "Add CSV export to the orders page"   # hand off a goal immediately
swarm --cwd ~/src/other-project                    # pick the project explicitly
swarm --prefix api-                                # a second swarm (names must be unique per herdr server)
SWARM_MODEL=anthropic/claude-sonnet-5-5 swarm      # one model for every agent, this run only
```

The orchestrator drives these through its `swarm_*` tools; the same commands still work for you from a shell
inside the swarm tab:

```sh
swarm types                                  # list agent types and where each is defined
swarm spawn reviewer --task "..." --wait     # add a worker, send a task, wait for its answer
swarm prompt reviewer "follow-up" --wait     # message a live worker (and wait)
swarm wait impl impl-2                       # wait for several workers started without --wait
swarm wait impl --no-read                    # report only; skip the pane fallback
swarm ls                                     # live agents in this tab + state
swarm close reviewer                         # close a worker's pane
```

`swarm wait` is activity-aware: it only returns once the agent has actually run its turn and settled
(`idle`, `done` or `blocked`). It prints the worker's latest report — header `KIND name [r:ID verdict:V]:`
— and inlines the artifact when it is ≤ 8000 bytes, otherwise printing the artifact path plus
`swarm_read {report:"r:ID"}` / `context_from:["r:ID"]` pointers. It reads the pane only when there is
no report since the prompt, or the worker is `blocked`; `--no-read` suppresses that fallback. Don't
hand-roll `herdr agent wait --until idle` — a finished worker is `done`, and that call hangs.

Finished? Close the `swarm:<project>` tab from the sidebar.

## Plans, epochs & state

Edit-capable work goes through `swarm_plan` before any worker is spawned. A plan is
`{goal, template, stages:[{id, loop?, steps:[{id, type, brief, files?}]}], require?, max_rounds?, publish?, suggestions?}`;
`max_rounds` is advisory text only, never a scheduling limit. Built-in templates (all adapt freely):

| template | skeleton |
|---|---|
| `small-change` | `ctx(researcher) → ⟳[impl → review]` |
| `feature` | `plan → ⟳[impl-a ∥ impl-b → review] → test` |
| `bug` | `debug → repro(tester) → ⟳[fix → review]` |
| `ci-fix` | `ci(github) → debug → ⟳[fix → review] → push(github)` |
| `custom` | compose stages/steps yourself |

Plans are tiered by blast radius:

- **Tier 0 — read-only** (any plan with no edit-capable step and nothing that publishes, e.g. `planner`,
  `researcher`, `reviewer` — `github` publishes and `debugger` edits, so neither is Tier 0): proposed and
  run without a dialog.
- **Tier 1 — small** (one maker, no publish): no dialog; the plan is shown as a notify + widget.
- **Tier 2 — bigger** (a stage with ≥ 2 makers, ≥ 3 makers in total, or any plan that publishes
  via a `github`-capable step or `publish: true`):
  requires a fresh `planner`/`researcher` `DONE` report from this epoch, then shows **one** dialog:
  `Run this plan` / up to 3 lint+suggestion choices / `Change…` / `Wrong — I'll describe the workflow`.
  Non-publish plans auto-run after 90 s; publish plans never do.

`swarm_plan` actions are `propose`, `amend` and `status`. **Tightening** auto-applies with a notify —
adding stages, steps or `require` roles, narrowing a step's `files`, and other changes that don't loosen
safeguards. Anything that **loosens** asks the user first: widening a step's `files`, removing a
`require` role, a checker or a loop, or newly publishing (a `github` step or `publish: true`); so does
moving a plan into Tier 2, and changing a Tier-2 plan's goal or maker steps re-asks. On an unapproved or
`NOT APPROVED` dialog, revise the plan and propose again — never spawn a maker against an unapproved
plan. An approved plan's `require` is written to `$SWARM_RUN_DIR/policy.json` and is **additive** to the
default `reviewer` publish gate.

**Spawns and prompts.** Spawning an edit-capable worker needs an approved plan for the current goal;
when its plan step defines `files`, the spawn's `files` may only narrow them. Prompting an edit-capable
worker likewise needs an approved plan in the current goal epoch — a worker spawned in an earlier goal
must be re-spawned there, not prompted. A plan publishes when it has a `github`-capable step (or
`publish: true`); publish plans are always Tier 2 and never auto-run.
A `github`-capable worker without edit capabilities can still be spawned without a plan;
the guard's publish gate, not the spawn plan check, enforces publication safeguards.

Plans render as e.g. `plan → ⟳[impl-a ∥ impl-b → review] → pr(github) 🔒reviewer`.

**Epochs.** A new user message starts a new *goal epoch* when the current one has no spawns yet or its
plan is done; `/swarm-goal` forces one. Tier 2 approval looks for a planner/researcher report *within
the current epoch*.

**Hidden state.** A short `[swarm state …]` message is refreshed each prompt and never shown to you:
goal, plan/step states, live workers, gate freshness (`fresh`/`stale`/`missing`/`fail`) and a next hint.
It is context, not a report — don't quote it.

## Customize

| what | where |
|---|---|
| add an agent type | create `${XDG_CONFIG_HOME:-~/.config}/herdr-swarm/agents/<type>.md` (copy one from `agents/`) |
| override a built-in type without editing the clone | same file name in `${XDG_CONFIG_HOME:-~/.config}/herdr-swarm/agents/` or `$SWARM_AGENTS_DIR` |
| change a model / thinking level | the frontmatter of `agents/<type>.md` |
| change behaviour | the Markdown body of `agents/<type>.md` |
| change what an agent may do | `caps:` in `agents/<type>.md` |
| guard rules | `extensions/swarm-policy.ts` |
| orchestration strategy | `agents/orchestrator.md` |

Changes apply to the next agent spawned. Use `swarm update` to update the installation and
re-run its install steps safely (it also cleans up entries from older versions); see [Update](#update).

## Troubleshooting

- **`Failed to load extension …swarm-guard.ts`** — pi is too old or the file is missing. Run `swarm args <type>`, then start pi with those exact flags to see the error.
- **`swarm guard: … blocked`** — working as intended. Edit `caps:` in `agents/<type>.md` if the scope is wrong.
- **`agent_pane_busy` / failed to start** — the new pane's shell wasn't ready; `swarm` retries 4×. Slow shell startup? Just retry.
- **`agent 'orchestrator' is already live`** — close the existing swarm tab or use `--prefix`.
- **Dock app does nothing** — herdr must be running; see `~/.config/herdr/swarm/launch.log`.
- **Panes don't show agent names** — `herdr integration install pi`, then restart pi.
- **Keybinding doesn't fire** — some terminals don't report `ctrl+shift+s`; use `swarm` or the app.
- **Orchestrator says `swarm: command not found`** — it was started by an old version; close the tab and start a new swarm.
- **Orchestrator seems stuck "Working" for ages** — it's probably blocked in a wait. `swarm ls` from another pane shows the worker states; if the worker is `done`/`idle`, the orchestrator is in a bad wait: `pkill -f "agent wait <worker>"` unblocks it immediately. Swarms started with the current version use `swarm wait`, which doesn't have this problem.
