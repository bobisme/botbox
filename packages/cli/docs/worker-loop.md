# Worker Loop

Full worker lifecycle — triage, start, work, finish, repeat. This is the "colleague" agent: it shows up, finds work, does it, cleans up, and repeats until there is nothing left.

## Identity

If spawned by `agent-loop.sh`, your identity is provided as `$AGENT` (a random name like `storm-raven`). Otherwise, adopt `<project>-dev` as your name (e.g., `botbox-dev`). Run `botbus whoami --agent $AGENT` to confirm — it will generate a name if one isn't set.

Your project channel is `$BOTBOX_PROJECT`. All botbus commands must include `--agent $AGENT`. All announcements go to `$BOTBOX_PROJECT` with `-L mesh`.

**Important:** Run all `br` commands (`br update`, `br close`, `br comments`, `br sync`) from the **project root**, not from inside `.workspaces/$WS/`. This prevents merge conflicts in the beads database. Use absolute paths for file operations in the workspace — **do not `cd` into the workspace and stay there**, as this breaks cleanup when the workspace is destroyed.

## Loop

### 1. Triage — find and groom work, then pick one small task (always run this, even if you already know what to work on)

- Check inbox: `botbus inbox --agent $AGENT --channels $BOTBOX_PROJECT --mark-read`
- For messages that request work, create beads: `br create --title="..." --description="..." --type=task --priority=2`
- For questions or status checks, reply directly: `botbus send --agent $AGENT <channel> "<reply>" -L mesh -L triage-reply`
- Check ready beads: `br ready`
- If no ready beads and no new beads from inbox, stop with message "No work available."
- **Check blocked beads** for resolved blockers: if a bead was blocked pending information or an upstream fix that has since landed, unblock it with `br update <id> --status=open` and a comment noting why.
- **Groom each ready bead** (`br show <id>`): ensure it has a clear title, description with acceptance criteria and testing strategy, appropriate priority, and labels. Fix anything missing and comment what you changed.
- Pick one task: `bv --robot-next` — parse the JSON to get the bead ID.
- If the task is large (epic or multi-step), break it into smaller beads with `br create` + `br dep add`, then run `bv --robot-next` again. Repeat until you have exactly one small, atomic task.
- If the bead is claimed by another agent (`botbus check-claim --agent $AGENT "bead://$BOTBOX_PROJECT/<id>"`), skip it and pick the next recommendation. If all are claimed, stop with "No work available."

### 2. Start — claim and set up

- `br update <bead-id> --status=in_progress`
- `botbus claim --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>" -m "<bead-id>"`
- `maw ws create --random` — note the workspace name (e.g., `frost-castle`) and the **absolute path** from the output. Store as `$WS` (name) and `$WS_PATH` (absolute path).
- **All file operations must use the absolute workspace path** from `maw ws create` output. Use absolute paths for Read, Write, and Edit. For bash: `cd $WS_PATH && <command>`. For jj: `maw ws jj $WS <args>`. **Do not `cd` into the workspace and stay there** — the workspace will be destroyed during finish, breaking your shell session.
- `botbus claim --agent $AGENT "workspace://$BOTBOX_PROJECT/$WS" -m "<bead-id>"`
- `botbus send --agent $AGENT $BOTBOX_PROJECT "Working on <bead-id>" -L mesh -L task-claim`

### 3. Work — implement the task

- Read the bead details: `br show <bead-id>`
- Do the work using the tools available in the workspace.
- **You must add at least one progress comment** during work: `br comments add <bead-id> "Progress: ..."`
  - Post when you've made meaningful progress or hit a milestone
  - This is required before you can close the bead — do not skip it
  - Essential for visibility and debugging if something goes wrong

### 4. Stuck check — recognize when you are stuck

You are stuck if: you attempted the same approach twice without progress, you cannot find needed information or files, or a tool command fails repeatedly.

If stuck:
- Add a detailed comment with what you tried and where you got blocked: `br comments add <bead-id> "Blocked: ..."`
- Post in the project channel: `botbus send --agent $AGENT $BOTBOX_PROJECT "Stuck on <bead-id>: <summary>" -L mesh -L task-blocked`
- If a tool behaved unexpectedly (e.g., command succeeded but had no effect), also report it: `botbus send --agent $AGENT $BOTBOX_PROJECT "Tool issue: <tool> <what happened>" -L mesh -L tool-issue`
- `br update <bead-id> --status=blocked`
- Release the bead claim: `botbus release --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>"`
- Move on to triage again (go to step 1).

### 5. Finish — mandatory teardown (never skip)

- `br comments add <bead-id> "Completed by $AGENT"`
- `br close <bead-id> --reason="Completed" --suggest-next`
- `maw ws merge $WS --destroy` (if merge conflict, preserve workspace and announce)
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
