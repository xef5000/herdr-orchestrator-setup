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

| type | what it does | default model |
|---|---|---|
| `orchestrator` | Coordinates. Spawns/closes workers, never edits code. **The only agent that starts, and the one you talk to.** | claude-sonnet-5-5 · high |
| `planner` | Read-only. Turns a goal into explicit tasks tagged `[simple]` / `[hard]`. | claude-opus-5-5 · xhigh |
| `impl` | Cheap & fast implementer for well-specified `[simple]` tasks. | deepseek-v4.1-flash · max |
| `impl-pro` | Stronger implementer for `[hard]` tasks. | gpt-6.1-sol · medium |
| `reviewer` | Read-only review; approves or requests changes with file:line findings. | claude-opus-5-5 · high |
| `debugger` | Reproduces and root-causes failures; minimal fix. | claude-opus-5-5 · high |
| `tester` | Writes and runs tests. | gpt-6.1-sol · medium |
| `github` | PRs, issues, CI logs, reviews via `gh`. Never force-pushes or merges unasked. | claude-sonnet-5-5 · medium |
| `researcher` | Read-only answers about libraries, APIs, docs, the codebase. | claude-sonnet-5-5 · medium |

> Model IDs are the ones available in the author's org. Run `pi --list-models` and edit the
> frontmatter in `agents/*.md` if yours differ.

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

Commands the orchestrator uses (you can run them too, from a shell inside the swarm tab):

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
| orchestration strategy | `agents/orchestrator.md` |

Changes apply to the next agent spawned. Re-running `install.sh` after `git pull` is safe (it also
cleans up entries from older versions).

## Troubleshooting

- **`agent_pane_busy` / failed to start** — the new pane's shell wasn't ready; `swarm` retries 4×. Slow shell startup? Just retry.
- **`agent 'orchestrator' is already live`** — close the existing swarm tab or use `--prefix`.
- **Dock app does nothing** — herdr must be running; see `~/.config/herdr/swarm/launch.log`.
- **Panes don't show agent names** — `herdr integration install pi`, then restart pi.
- **Keybinding doesn't fire** — some terminals don't report `ctrl+shift+s`; use `swarm` or the app.
- **Orchestrator says `swarm: command not found`** — it was started by an old version; close the tab and start a new swarm.
- **Orchestrator seems stuck "Working" for ages** — it's probably blocked in a wait. `swarm ls` from another pane shows the worker states; if the worker is `done`/`idle`, the orchestrator is in a bad wait: `pkill -f "agent wait <worker>"` unblocks it immediately. Swarms started with the current version use `swarm wait`, which doesn't have this problem.
