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
Add a file, and the orchestrator can spawn it; no other change needed.

| type | what it does | scope (enforced) | default model |
|---|---|---|---|
| `orchestrator` | Coordinates. Spawns/closes workers, never edits code. **The only agent that starts, and the one you talk to.** | swarm_* tools only | claude-sonnet-5-5 · medium |
| `planner` | Read-only. Turns a goal into explicit tasks tagged `[simple]` / `[hard]`. | read-only | claude-opus-5-5 · xhigh |
| `impl` | Cheap & fast implementer for well-specified `[simple]` tasks. | edit files | deepseek-v4.1-flash · max |
| `impl-pro` | Stronger implementer for `[hard]` tasks. | edit files | gpt-6.1-sol · medium |
| `reviewer` | Read-only review; approves or requests changes with file:line findings. | read-only | claude-opus-5-5 · high |
| `debugger` | Reproduces and root-causes failures; minimal fix. | edit files | claude-opus-5-5 · high |
| `tester` | Writes and runs tests. | test files only | gpt-6.1-sol · medium |
| `github` | PRs, issues, CI logs, reviews via `gh`. Never force-pushes or merges unasked. | git write + GitHub, no file edits | claude-sonnet-5-5 · medium |
| `researcher` | Read-only answers about libraries, APIs, docs, the codebase. | read-only | claude-sonnet-5-5 · medium |

> Model IDs are the ones available in the author's org. Run `pi --list-models` and edit the
> frontmatter in `agents/*.md` if yours differ.
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
swarm types                                  # list agent types
swarm spawn reviewer --task "..." --wait     # add a worker, send a task, wait for its answer
swarm prompt reviewer "follow-up" --wait     # message a live worker (and wait)
swarm wait impl impl-2                       # wait for several workers started without --wait
swarm ls                                     # live agents in this tab + state
swarm close reviewer                         # close a worker's pane
```

`swarm wait` is activity-aware: it only returns once the agent has actually run its turn and settled
(`idle`, `done` or `blocked`). Don't hand-roll `herdr agent wait --until idle` — a finished worker is
`done`, and that call hangs.

Finished? Close the `swarm:<project>` tab from the sidebar.

## Customize

| what | where |
|---|---|
| add an agent type | create `agents/<type>.md` (copy an existing one) |
| change a model / thinking level | the frontmatter of `agents/<type>.md` |
| change behaviour | the Markdown body of `agents/<type>.md` |
| change what an agent may do | `caps:` in `agents/<type>.md` |
| guard rules | `extensions/swarm-policy.ts` |
| orchestration strategy | `agents/orchestrator.md` |

Changes apply to the next agent spawned. Re-running `install.sh` after `git pull` is safe (it also
cleans up entries from older versions).

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
