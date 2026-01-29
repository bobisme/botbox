# Start

Start a bead using the standard botbox flow: claim the work, set up a workspace, announce.

## Arguments

- `$AGENT` = agent identity (required)
- `<bead-id>` = bead to start (required)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user.
2. `br update <bead-id> --status=in_progress`
3. `botbus claim --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>" -m "<bead-id>"`
4. Create a workspace: `maw ws create --random` — note the workspace name and path from the output (e.g., `.workspaces/frost-castle`). Store the workspace name as `$WS`.
5. **All file edits and commands must run from the workspace path** (e.g., `cd .workspaces/$WS && <command>`). Changes made outside this path land in the wrong workspace.
6. `botbus claim --agent $AGENT "workspace://$BOTBOX_PROJECT/$WS" -m "<bead-id>"`
7. Announce: `botbus send --agent $AGENT $BOTBOX_PROJECT "Working on <bead-id>" -L mesh -L task-claim`

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
- `maw` workspaces are used (jj required).
