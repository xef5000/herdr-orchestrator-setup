#!/usr/bin/env bash
# Installs the herdr swarm launcher for the current user (macOS, Linux, WSL, Git Bash).
#
#   git clone https://github.com/xef5000/herdr-swarm ~/.config/herdr/swarm
#   ~/.config/herdr/swarm/install.sh
#   (or: unzip it anywhere and run ./install.sh — it copies itself into place)
#
# What it does (all idempotent, safe to re-run after `git pull`):
#   - copies this folder to ~/.config/herdr/swarm (if not already there)
#   - adds `alias swarm=...` to your shell rc
#   - adds a Ctrl+Shift+S keybinding to ~/.config/herdr/config.toml
#   - makes sure the herdr <-> pi integration is installed
#   - macOS: builds ~/Applications/Herdr Swarm.app (drag it to the Dock)
#   - Linux: adds a "Herdr Swarm" entry to your app launcher
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.config/herdr/swarm"
CFG="${HERDR_CONFIG_PATH:-$HOME/.config/herdr/config.toml}"
OS="$(uname -s)"
case "$OS" in MINGW*|MSYS*|CYGWIN*) WINDOWS=1 ;; *) WINDOWS=0 ;; esac

# ---- prerequisites ----------------------------------------------------------
missing=0
command -v jq >/dev/null || { echo "✗ jq is required   (mac: brew install jq | ubuntu: sudo apt install jq | windows: winget install jqlang.jq)"; missing=1; }
command -v pi >/dev/null || { echo "✗ pi is required on PATH  (npm install -g @mariozechner/pi-coding-agent)"; missing=1; }
[[ $missing -eq 0 ]] || exit 1

HERDR="${HERDR_BIN_PATH:-$(command -v herdr || true)}"
if [[ -z "$HERDR" && $WINDOWS -eq 0 ]]; then
  HERDR="$(ps -axo args= 2>/dev/null | awk '/herdr server$/ {print $1; exit}')"
fi
[[ -n "$HERDR" ]] || echo "⚠ herdr binary not found right now (ok if herdr isn't installed/running yet; see README)"

# ---- 1. files ----------------------------------------------------------------
if [[ "$SRC" != "$DEST" ]]; then
  mkdir -p "$DEST"
  if command -v rsync >/dev/null; then
    rsync -a --exclude .git --exclude '*.log' "$SRC/" "$DEST/"
  else
    cp -R "$SRC/." "$DEST/"; rm -rf "$DEST/.git" "$DEST"/*.log
  fi
  echo "✓ copied to $DEST"
fi
chmod +x "$DEST/swarm" "$DEST/install.sh"
chmod +x "$DEST/herdr"

# ---- 2. alias ----------------------------------------------------------------
# drop entries from the pre-1.0 layout (launch.sh)
for f in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [[ -f "$f" ]] && grep -q 'herdr/swarm/launch.sh' "$f" || continue
  perl -0pi -e 's/\n# herdr swarm:[^\n]*\nalias swarm="[^\n]*launch\.sh"\n//g' "$f" && echo "✓ removed old alias from $f"
done
if [[ -f "$CFG" ]] && grep -q 'herdr/swarm/launch.sh' "$CFG"; then
  perl -0pi -e 's/\n# ---- swarm:[^\n]*\n#[^\n]*\n\[\[keys\.command\]\]\nkey = "ctrl\+shift\+s"\ntype = "pane"\ncommand = [^\n]*launch\.sh[^\n]*\n//g' "$CFG" && echo "✓ removed old keybinding from $CFG"
fi
RC="$HOME/.zshrc"
case "${SHELL##*/}" in bash) RC="$HOME/.bashrc" ;; esac
[[ $WINDOWS -eq 1 ]] && RC="$HOME/.bashrc"
if ! grep -q 'herdr/swarm/swarm' "$RC" 2>/dev/null; then
  {
    echo ''
    echo '# herdr swarm: type `swarm` in any herdr pane to open an orchestrator tab'
    echo 'alias swarm="$HOME/.config/herdr/swarm/swarm"'
  } >> "$RC"
  echo "✓ added 'swarm' alias to $RC"
fi

# ---- 3. keybinding -----------------------------------------------------------
# Native Windows runs key commands through cmd.exe, so wrap the script in bash there.
if [[ $WINDOWS -eq 1 ]]; then
  KEYCMD='bash -lc "~/.config/herdr/swarm/swarm"'
else
  KEYCMD='~/.config/herdr/swarm/swarm'
fi
mkdir -p "$(dirname "$CFG")"; touch "$CFG"
if ! grep -q 'herdr/swarm/swarm' "$CFG"; then
  {
    echo ''
    echo '# ---- herdr swarm: open an orchestrator tab'
    echo '# Hold Ctrl+Shift and press S. Runs in a temporary pane so you can see progress/errors.'
    echo '[[keys.command]]'
    echo 'key = "ctrl+shift+s"'
    echo 'type = "pane"'
    echo "command = '$KEYCMD'"
  } >> "$CFG"
  echo "✓ added Ctrl+Shift+S keybinding to $CFG"
  if [[ -n "$HERDR" ]]; then
    "$HERDR" server reload-config >/dev/null 2>&1 && echo "✓ herdr config reloaded" || true
  fi
fi

# ---- 4. pi integration -------------------------------------------------------
if [[ -n "$HERDR" ]]; then
  "$HERDR" integration install pi >/dev/null 2>&1 && echo "✓ herdr pi integration installed" || true
fi

# ---- 5. clickable launcher ---------------------------------------------------
if [[ "$OS" == "Darwin" ]] && command -v osacompile >/dev/null; then
  mkdir -p "$HOME/Applications"
  SCRIPT="do shell script \"export PATH=/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH; '$HOME/.config/herdr/swarm/swarm' >> '$HOME/.config/herdr/swarm/launch.log' 2>&1\""
  printf '%s\n' "$SCRIPT" | osacompile -o "$HOME/Applications/Herdr Swarm.app" >/dev/null
  echo "✓ built ~/Applications/Herdr Swarm.app  (drag it to your Dock)"
elif [[ "$OS" == "Linux" && -z "${WSL_DISTRO_NAME:-}" ]]; then
  mkdir -p "$HOME/.local/share/applications"
  {
    echo '[Desktop Entry]'
    echo 'Type=Application'
    echo 'Name=Herdr Swarm'
    echo 'Comment=Open a 5-agent pi swarm tab in herdr'
    echo "Exec=bash -lc \"$HOME/.config/herdr/swarm/swarm >> $HOME/.config/herdr/swarm/launch.log 2>&1\""
    echo 'Terminal=false'
    echo 'Categories=Development;'
  } > "$HOME/.local/share/applications/herdr-swarm.desktop"
  echo "✓ added 'Herdr Swarm' to your app launcher"
fi

cat <<EOF

Done. Ways to start a swarm:
  • type   swarm          in any herdr terminal pane (open a new shell first, or: source $RC)
  • press  Ctrl+Shift+S   inside herdr
EOF
[[ "$OS" == "Darwin" ]] && echo "  • click  ~/Applications/Herdr Swarm.app   (add it to the Dock)"
[[ "$OS" == "Linux" && -z "${WSL_DISTRO_NAME:-}" ]] && echo "  • launch 'Herdr Swarm' from your app menu"
cat <<EOF

Agent types, models, scopes: edit $DEST/agents/*.md
Your own / overriding agent types: ${XDG_CONFIG_HOME:-$HOME/.config}/herdr-swarm/agents/<type>.md
EOF
