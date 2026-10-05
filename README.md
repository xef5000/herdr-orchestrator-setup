# herdr orchestrator setup

One click → a [herdr](https://herdr.dev) tab with **5 [pi](https://github.com/earendil-works/pi-mono) agents working as a team**:

```
┌──────────────┬──────────────┬──────────────┐
│ orchestrator │    impl1     │              │
├──────────────┼──────────────┤   reviewer   │
│   planner    │    impl2     │              │
└──────────────┴──────────────┴──────────────┘
```

| pane | job | default model |
|---|---|---|
| **orchestrator** | Coordinates everyone, never edits code. **You talk to this one.** | claude-sonnet-5-5 · high |
| **planner** | Read-only. Turns your goal into explicit tasks tagged `[simple]` / `[hard]`. | claude-opus-5-5 · xhigh |
| **impl1** | Cheap & fast implementer for `[simple]` tasks. | deepseek-v4.1-flash · max |
| **impl2** | Stronger implementer for `[hard]` tasks. | gpt-6.1-sol · medium |
| **reviewer** | Read-only. Approves or requests changes. | claude-opus-5-5 · high |

The agents message each other through `herdr agent prompt`. Every pane is a normal interactive pi — click into any of them and chat.

---

## Install

### Prerequisites (all platforms)

1. **herdr** ≥ 0.9 — <https://herdr.dev/docs/install/>
2. **pi** on your `PATH` — `npm install -g @mariozechner/pi-coding-agent` (and log in to a provider once by running `pi`)
3. **jq**

### macOS

```sh
brew install herdr jq                    # if you don't have them yet
git clone https://github.com/xef5000/herdr-orchestrator-setup ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
```

You get:
- **`~/Applications/Herdr Swarm.app`** → open Finder → your home folder → `Applications`, drag it to the Dock. Click it to start a swarm. *(First click: macOS may ask for permission — allow it.)*
- the `swarm` command in any herdr terminal pane
- the **⌃ control + ⇧ shift + S** shortcut inside herdr

### Windows

herdr runs natively on Windows, but this launcher is a bash script. Two options:

#### Option A — WSL2 (recommended, fully supported)

Everything (herdr, pi, this repo) lives inside WSL. This is identical to the Linux setup and is what's been tested.

```powershell
wsl --install -d Ubuntu          # once, then reboot and open "Ubuntu" from the Start menu
```

Inside the Ubuntu terminal:

```sh
sudo apt update && sudo apt install -y jq git curl
curl -fsSL https://herdr.dev/install.sh | sh
# install node + pi if you don't have them:
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
npm install -g @mariozechner/pi-coding-agent
git clone https://github.com/xef5000/herdr-orchestrator-setup ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
herdr                               # start herdr
```

Start a swarm by typing `swarm` in a herdr pane or pressing **Ctrl+Shift+S**.
Tip: use [Windows Terminal](https://aka.ms/terminal) with the Ubuntu profile for the best experience.

#### Option B — native Windows + Git Bash (best-effort)

1. Install herdr natively:
   ```powershell
   powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
   ```
2. Install [Git for Windows](https://git-scm.com/download/win) (provides Git Bash), [Node.js](https://nodejs.org), and jq (`winget install jqlang.jq`).
3. In **Git Bash**:
   ```sh
   npm install -g @mariozechner/pi-coding-agent
   git clone https://github.com/xef5000/herdr-orchestrator-setup ~/.config/herdr/swarm
   ~/.config/herdr/swarm/install.sh
   ```
4. Set herdr to open Git Bash panes, in `%USERPROFILE%\.config\herdr\config.toml`:
   ```toml
   default_shell = "C:\\Program Files\\Git\\bin\\bash.exe"
   ```
   then `herdr server reload-config`.

Start a swarm with `swarm` in a pane or **Ctrl+Shift+S**. On native Windows herdr can't confirm a pane's shell is idle before launching an agent, so the launcher just waits a few seconds instead (`SWARM_SHELL_WAIT=8 swarm` if your shell starts slowly). If something misbehaves, prefer Option A.

### Linux

```sh
sudo apt install -y jq            # or your distro's equivalent
curl -fsSL https://herdr.dev/install.sh | sh
npm install -g @mariozechner/pi-coding-agent
git clone https://github.com/xef5000/herdr-orchestrator-setup ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
```

You also get a **"Herdr Swarm"** entry in your desktop app launcher.

---

## Use

Start a swarm with any of:

- 🖱️ click **Herdr Swarm** (Dock on macOS / app menu on Linux)
- ⌨️ type **`swarm`** in any herdr terminal pane (not inside an agent) and press Enter
- ⌨️ press **Ctrl+Shift+S** inside herdr (on Mac: ⌃ control + ⇧ shift + S)

A new tab named `swarm:<project>` appears, using the project of the pane you had focused. **Click the orchestrator pane (top-left) and describe what you want built.** It plans with the planner, farms work to impl1/impl2, and routes results through the reviewer, then reports back.

```sh
swarm --goal "Add CSV export to the orders page"   # hand off a goal immediately
swarm --cwd ~/src/other-project                    # pick the project explicitly
swarm --prefix api-                                # a second swarm (agent names must be unique)
SWARM_MODEL=anthropic/claude-sonnet-5-5 swarm      # one model for every role, this run only
```

Finished? Close the `swarm:<project>` tab from the sidebar (right-click → close).

## Customize

| file | what |
|---|---|
| `models.conf` | model + thinking level per role (`<role> <provider/model> <thinking>`) — run `pi --list-models` to see what you have |
| `roles/*.md` | the system prompt of each role |
| `launch.sh` | pane layout and wiring |

Changes apply to the next swarm you start. Re-running `install.sh` after a `git pull` is safe.

> Model IDs in `models.conf` are the ones available in the author's org. If `pi --list-models` doesn't list them for you, edit that file first.

## Troubleshooting

- **`agent_pane_busy`** — a pane's shell wasn't ready yet. The launcher retries 4×; if it still fails your shell startup is very slow — run `swarm` again.
- **`agent 'orchestrator' is already live`** — you already have a swarm; close its tab or use `--prefix`.
- **Dock app does nothing** — check `~/.config/herdr/swarm/launch.log`. herdr must be running.
- **Panes don't show agent names** — run `herdr integration install pi` and restart pi.
- **Keybinding doesn't fire** — some terminals don't report `ctrl+shift+s`; just use `swarm` or the app.
