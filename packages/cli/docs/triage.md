# Triage

Find exactly one actionable bead, or determine there is no work available.

## Arguments

- `$AGENT` = agent identity (required)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user.
2. Check inbox for new messages:
   - `botbus inbox --agent $AGENT --all --mark-read`
   - For each message that requests work (task request, bug report, feature ask), create a bead: `br create --title="..." --description="..." --type=task --priority=2`
   - For messages with `-L feedback` (reports from other agents):
     - Review the mentioned bead IDs with `br show <bead-id>`
     - Triage the beads (accept, adjust priority, close if duplicate/out-of-scope)
     - Respond on botbus: `botbus send --agent $AGENT <channel> "Triaged N beads: <summary> @<reporter-agent>" -L mesh -L triage-reply`
   - For messages that are questions or status checks, reply inline: `botbus send --agent $AGENT <channel> "<response>" -L mesh -L triage-reply`
3. Check for ready beads: `br ready`
   - If no ready beads exist and no inbox messages created new beads, output `NO_WORK_AVAILABLE` and stop.
4. Use bv to pick exactly one task: `bv --robot-next`
   - Parse the JSON output to get the recommended bead ID.
5. Check the bead size: `br show <bead-id>`
   - If the bead is large (epic, or description suggests multiple distinct changes), break it down:
     - Create smaller child beads with `br create` and `br dep add <child> <parent>`.
     - Then run `bv --robot-next` again to pick one of the children.
   - Repeat until you have exactly one small, atomic task.
6. Verify the bead is not claimed by another agent: `botbus check-claim --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>"`
   - If claimed by someone else, back off and run `bv --robot-next` again excluding that bead.
   - If all candidates are claimed, output `NO_WORK_AVAILABLE` and stop.
7. Output the single bead ID as the result.

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
- `bv` is available and the beads database is initialized.
- The agent will use the [start](start.md) workflow next to claim and begin work.
