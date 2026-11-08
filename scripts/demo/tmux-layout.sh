#!/usr/bin/env bash
# Four-pane tmux layout for the walkthrough recording (AISDLC-772).
# Panes: planner | dispatch / operator TUI | shell. Attaches to the roster
# sessions that `cli-hierarchy up` created; pane 4 stays a free shell.
set -euo pipefail
S="${1:-demo}"
tmux new-session -d -s "$S" -x 220 -y 55 "node pipeline-cli/bin/cli-hierarchy.mjs attach planner"
tmux split-window -h -t "$S" "node pipeline-cli/bin/cli-hierarchy.mjs attach dispatch"
tmux split-window -v -t "$S:0.1" "AI_SDLC_TUI=experimental node pipeline-cli/bin/cli-tui.mjs"
tmux split-window -v -t "$S:0.0"
tmux select-layout -t "$S" tiled
echo "attach with: tmux attach -t $S"
