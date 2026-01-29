# Start

Start a bead using the standard botbox flow: claim the work, set up a workspace, announce.

## Arguments

- `$AGENT` = agent identity (required)
- `<bead-id>` = bead to start (required)
- `<path-glob>` = optional path glob to claim (e.g., `src/**`)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user.
2. `br update <bead-id> --status=in_progress`
3. `botbus claim --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>" -m "<bead-id>"`
4. If path glob provided, `botbus claim --agent $AGENT "<path-glob>" -m "<bead-id>"`
5. `maw ws create $AGENT` and enter the workspace if needed.
6. Announce: `botbus send --agent $AGENT $BOTBOX_PROJECT "Working on <bead-id>" -L mesh -L task-claim`

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
- `maw` workspaces are used (jj required).
