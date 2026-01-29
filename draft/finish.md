# Finish

Mandatory teardown after completing work on a bead. Never skip this, even on failure paths.

## Arguments

- `$AGENT` = agent identity (required)
- `<bead-id>` = bead to close out (required)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user.
2. Add a completion comment to the bead: `br comments add <bead-id> "Completed by $AGENT"`
3. Close the bead: `br close <bead-id> --reason="Completed" --suggest-next`
4. Merge and destroy the workspace: `maw ws merge $AGENT --destroy -f`
   - If merge fails due to conflicts, do NOT destroy. Instead add a comment: `br comments add <bead-id> "Merge conflict — workspace preserved for manual resolution"` and announce the conflict in the project channel.
5. Release all claims held by this agent: `botbus release --agent $AGENT --all`
6. Sync the beads ledger: `br sync --flush-only`
7. Announce completion in the project channel: `botbus send --agent $AGENT $BOTBOX_PROJECT "Completed <bead-id>" -L mesh -L task-done`

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
- The workspace was created with `maw ws create $AGENT` during [start](start.md).
