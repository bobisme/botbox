# Worker Loop

Full worker lifecycle — triage, start, work, finish, repeat. This is the "colleague" agent: it shows up, finds work, does it, cleans up, and repeats until there is nothing left.

Your identity is `$AGENT`. Your project channel is `$BOTBOX_PROJECT`. All botbus commands must include `--agent $AGENT`. All announcements go to `$BOTBOX_PROJECT` with `-L mesh`.

## Loop

### 1. Triage — find exactly one small task

- Check inbox: `botbus inbox --agent $AGENT --all --mark-read`
- For messages that request work, create beads: `br create --title="..." --description="..." --type=task --priority=2`
- For questions or status checks, reply directly: `botbus send --agent $AGENT <channel> "<reply>" -L mesh -L triage-reply`
- Check ready beads: `br ready`
- If no ready beads and no new beads from inbox, stop with message "No work available."
- Pick one task: `bv --robot-next` — parse the JSON to get the bead ID.
- If the task is large (epic or multi-step), break it into smaller beads with `br create` + `br dep add`, then run `bv --robot-next` again. Repeat until you have exactly one small, atomic task.
- If the bead is claimed by another agent (`botbus check-claim --agent $AGENT "bead://$BOTBOX_PROJECT/<id>"`), skip it and pick the next recommendation. If all are claimed, stop with "No work available."

### 2. Start — claim and set up

- `br update <bead-id> --status=in_progress`
- `botbus claim --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>" -m "<bead-id>"`
- `maw ws create $AGENT` and work inside the workspace.
- `botbus send --agent $AGENT $BOTBOX_PROJECT "Working on <bead-id>" -L mesh -L task-claim`

### 3. Work — implement the task

- Read the bead details: `br show <bead-id>`
- Do the work using the tools available in the workspace.
- **Add at least one progress comment** during work: `br comments add <bead-id> "Progress: ..."`
  - Post when you've made meaningful progress or hit a milestone
  - Essential for visibility and debugging if something goes wrong

### 4. Stuck check — recognize when you are stuck

You are stuck if: you attempted the same approach twice without progress, you cannot find needed information or files, or a tool command fails repeatedly.

If stuck:
- Add a detailed comment with what you tried and where you got blocked: `br comments add <bead-id> "Blocked: ..."`
- Post in the project channel: `botbus send --agent $AGENT $BOTBOX_PROJECT "Stuck on <bead-id>: <summary>" -L mesh -L task-blocked`
- `br update <bead-id> --status=blocked`
- Release the bead claim: `botbus release --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>"`
- Move on to triage again (go to step 1).

### 5. Finish — mandatory teardown (never skip)

- `br comments add <bead-id> "Completed by $AGENT"`
- `br close <bead-id> --reason="Completed" --suggest-next`
- `maw ws merge $AGENT --destroy -f` (if merge conflict, preserve workspace and announce)
- `botbus release --agent $AGENT --all`
- `br sync --flush-only`
- `botbus send --agent $AGENT $BOTBOX_PROJECT "Completed <bead-id>" -L mesh -L task-done`

### 6. Repeat

Go back to step 1. The loop ends when triage finds no work.

## Key Rules

- **Exactly one small task at a time.** Never work on multiple beads concurrently.
- **Always finish or release before picking new work.** Context must be clear.
- **If claim is denied, back off and pick something else.** Never force or wait.
- **All botbus commands use `--agent $AGENT`.**
