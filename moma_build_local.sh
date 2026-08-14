#!/bin/bash
SKILL_DIR=$([ -d "$HOME/.claude/skills/moma-cli-deploy" ] && echo "$HOME/.claude/skills/moma-cli-deploy" || find "$HOME/.claude" -maxdepth 4 -type d -name "moma-cli-deploy" 2>/dev/null | head -1)
[ -z "$SKILL_DIR" ] && echo "ERROR: moma-cli-deploy skill not found." && exit 1
bash "$SKILL_DIR/scripts/install-node-deps.sh"
