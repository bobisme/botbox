# Update

Post a bead status update and notify the project channel.

## Arguments

- `$AGENT` = agent identity (required)
- `<bead-id>` = bead to update (required)
- `<status>` = new status (required): open | in_progress | blocked | done

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user.
2. `br update <bead-id> --status=<status>`
3. `botbus send --agent $AGENT $BOTBOX_PROJECT "<bead-id> -> <status>" -L mesh -L task-update`

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
