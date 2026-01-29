#!/usr/bin/env bash
# Populate the #projects registry on botbus with known projects.
#
# Usage: ./populate-projects-registry.sh

set -euo pipefail

AGENT="${1:-registry-bot}"

echo "Populating #projects registry as agent: $AGENT"
echo

# Project registry format:
# project:<name> repo:<path> lead:<agent> tools:<tool1>,<tool2>
# Labels: -L project-registry

botbus send --agent "$AGENT" projects \
  "project:botty repo:~/src/botty lead:botty-dev tools:botty" \
  -L project-registry

botbus send --agent "$AGENT" projects \
  "project:botbus repo:~/src/botbus lead:botbus-dev tools:botbus" \
  -L project-registry

botbus send --agent "$AGENT" projects \
  "project:beads_rust repo:~/src/beads_rust lead:beads-dev tools:br,bv" \
  -L project-registry

botbus send --agent "$AGENT" projects \
  "project:botcrit repo:~/src/botcrit lead:crit-dev tools:crit" \
  -L project-registry

botbus send --agent "$AGENT" projects \
  "project:maw repo:~/src/maw lead:maw-dev tools:maw" \
  -L project-registry

botbus send --agent "$AGENT" projects \
  "project:botbox repo:~/src/botbox lead:botbox-dev tools:botbox" \
  -L project-registry

echo "Done. View registry with:"
echo "  botbus inbox --agent $AGENT --channels projects --all"
