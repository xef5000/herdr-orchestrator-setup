#!/usr/bin/env bash
# Installs the herdr swarm launcher for the current user.
#
#   git clone <repo> ~/.config/herdr/swarm && ~/.config/herdr/swarm/install.sh
#   (or: unzip it anywhere and run ./install.sh — it copies itself into place)
#
# What it does (all idempotent):
#   - copies this folder to ~/.config/herdr/swarm (if not already there)
#   - adds `alias swarm=...` to ~/.zshrc
#   - adds a ctrl+shift+s keybinding to ~/.config/herdr/config.toml
#   - builds ~/Applications/Herdr Swarm.app (macOS only) you can drag to the Dock
#   - makes sure the herdr <-> pi integration is installed
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.config/herdr/swarm"
CFG="$HOME/.config/herdr/config.toml"

# ---- prerequisites ----------------------------------------------------------
command -v jq  >/dev/null || { echo "✗ jq is required (brew install jq)"; exit 1; }
command -v pi  >/dev/null || { echo "✗ pi is required on PATH"; exit 1; }
HERDR="${HERDR_BIN_PATH:-$(command -v herdr || true)}"
if [[ -z "$HERDR" ]]; then
  HERDR="$(ps -axo args= | awk '/herdr server$/ {print $1; exit}')"
fi
[[ -n "$HERDR" ]] || echo "⚠ herdr binary not found right now (fine if herdr isn't running yet)"

# ---- 1. files ----------------------------------------------------------------
if [[ "$SRC" != "$DEST" ]]; then
  mkdir -p "$(dirname "$DEST")"
  rsync -a --exclude .git --exclude '*.log' "$SRC/" "$DEST/"
  echo "✓ copied to $DEST"
fi
chmod +x "$DEST/launch.sh" "$DEST/install.sh"

# ---- 2. alias ----------------------------------------------------------------
RC="$HOME/.zshrc"; [[ "${SHELL##*/}" == "bash" ]] && RC="$HOME/.bashrc"
if ! grep -q 'herdr/swarm/launch.sh' "$RC" 2>/dev/null; then
  printf '\n# herdr swarm: type `swarm` in any herdr pane to open the 5-agent tab\nalias swarm="$HOME/.config/herdr/swarm/launch.sh"\n' >> "$RC"
  echo "✓ added 'swarm' alias to $RC"
fi

# ---- 3. keybinding -----------------------------------------------------------
mkdir -p "$(dirname "$CFG")"; touch "$CFG"
if ! grep -q 'herdr/swarm/launch.sh' "$CFG"; then
  cat >> "$CFG" <<'EOF'

# ---- swarm: 5-pane multi-agent tab (orchestrator/planner/impl1/impl2/reviewer)
# Hold control(⌃)+shift(⇧) and press S. Runs in a temporary pane so you can see progress/errors.
[[keys.command]]
key = "ctrl+shift+s"
type = "pane"
command = "~/.config/herdr/swarm/launch.sh"
EOF
  echo "✓ added ctrl+shift+s keybinding to $CFG"
  [[ -n "$HERDR" ]] && "$HERDR" server reload-config >/dev/null 2>&1 && echo "✓ herdr config reloaded" || true
fi

# ---- 4. pi integration -------------------------------------------------------
if [[ -n "$HERDR" ]]; then
  "$HERDR" integration install pi >/dev/null 2>&1 && echo "✓ herdr pi integration installed" || true
fi

# ---- 5. Dock app (macOS) -----------------------------------------------------
if [[ "$(uname)" == "Darwin" ]] && command -v osacompile >/dev/null; then
  mkdir -p "$HOME/Applications"
  osacompile -o "$HOME/Applications/Herdr Swarm.app" >/dev/null <<EOF
do shell script "export PATH=/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH; '$HOME/.config/herdr/swarm/launch.sh' >> '$HOME/.config/herdr/swarm/launch.log' 2>&1"
EOF
  echo "✓ built ~/Applications/Herdr Swarm.app  (drag it to your Dock)"
fi

cat <<EOF

Done. Three ways to start a swarm:
  • click  ~/Applications/Herdr Swarm.app   (add it to the Dock)
  • type   swarm        in any herdr terminal pane (open a new shell first, or: source $RC)
  • press  ⌃ control + ⇧ shift + S   inside herdr

Models per role: edit $DEST/models.conf
Role prompts:    edit $DEST/roles/*.md
EOF
