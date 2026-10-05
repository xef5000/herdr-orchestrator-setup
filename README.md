# herdr swarm

One click → a herdr tab with 5 [pi](https://github.com/earendil-works/pi-mono) agents that work as a team:

```
┌──────────────┬──────────────┬──────────────┐
│ orchestrator │    impl1     │              │
├──────────────┼──────────────┤   reviewer   │
│   planner    │    impl2     │              │
└──────────────┴──────────────┴──────────────┘
```

- **orchestrator** – coordinates; never edits code. Type your goal here.
- **planner** – read-only; turns the goal into explicit, parallelizable tasks tagged `[simple]`/`[hard]`.
- **impl1** – cheap & fast implementer for `[simple]` tasks.
- **impl2** – stronger implementer for `[hard]` tasks.
- **reviewer** – read-only; approves or requests changes.

Agents talk to each other through `herdr agent prompt <name> ...`; every pane is a normal pi you can click into and chat with.

## Install

Requirements: macOS/Linux, [herdr](https://herdr.dev) ≥ 0.9, `pi`, `jq`.

```sh
git clone <this repo> ~/.config/herdr/swarm
~/.config/herdr/swarm/install.sh
```

The installer adds a `swarm` shell alias, a `⌃⇧S` keybinding inside herdr, and (on macOS) `~/Applications/Herdr Swarm.app` you can keep in the Dock.

## Use

Start a swarm with any of: click the Dock app · type `swarm` in a herdr pane · press `⌃ control + ⇧ shift + S`.
It opens in the project of the pane you currently have focused. Then click the **orchestrator** pane and describe what you want built.

```sh
swarm --goal "Add CSV export to orders"     # hand off a goal immediately
swarm --prefix api- --cwd ~/src/other       # a second swarm (agent names must be unique)
SWARM_MODEL=anthropic/claude-sonnet-5-5 swarm   # same model for every role, one run
```

Close a swarm by closing its tab (`swarm:<project>`) in the sidebar.

## Customize

| File | What |
|---|---|
| `models.conf` | model + thinking level per role |
| `roles/*.md` | system prompt per role |
| `launch.sh` | layout / wiring |

Changes apply to the next swarm you start — no restart needed.
