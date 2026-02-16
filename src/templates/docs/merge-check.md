# Merge Check

Verify preconditions and merge a worker's completed workspace.

## Preferred: Use protocol merge

```bash
botbox protocol merge <workspace> --agent $AGENT
```

This checks all preconditions (bead closed, review approved, no conflicts) and outputs the exact merge steps. Use `--execute` to run them directly, or `--force` to skip bead/review checks.

With `--format json`, returns structured output for automation.

## What protocol merge checks

1. **Workspace exists** and is not `default`
2. **Associated bead is closed** (found via claims)
3. **Review is approved** (if review is enabled in `.botbox.json`)
4. **No merge conflicts** (via `maw ws merge --check` pre-flight)

If any check fails, the output explains why and what to do.

## Merge steps (output by protocol merge)

1. `maw ws merge <workspace> --destroy` — squash-merge and clean up
2. `crit reviews mark-merged <review-id>` — mark review as merged (if review exists)
3. `br sync --flush-only` — sync beads ledger
4. `maw push` — push to remote (if `pushMain` is enabled)
5. `bus send` — announce merge on project channel

## Conflict recovery

If merge produces conflicts, the workspace is preserved (not destroyed). Protocol merge outputs recovery steps:

1. **View conflicts**: `maw exec <ws> -- jj status` and `jj resolve --list`
2. **Auto-resolvable files** (.beads/, .claude/, .agents/): `maw exec <ws> -- jj restore --from main .beads/`
3. **Code conflicts**: edit files or use `jj resolve --tool :ours` / `:theirs`
4. **After resolving**: describe and retry `maw ws merge <ws> --destroy`
5. **Undo merge entirely**: `maw exec <ws> -- jj op undo`
6. **Recover destroyed workspace**: `maw ws restore <ws>`

## Manual fallback

If `botbox protocol merge` is unavailable, check manually:

1. `maw exec $WS -- crit review <review-id>` — confirm LGTM, no blocks
2. `maw exec default -- br show <bead-id>` — confirm bead is closed
3. `maw ws merge <workspace> --check` — pre-flight conflict detection
4. `maw ws merge <workspace> --destroy` — merge
5. `bus claims release --agent $AGENT --all` — release claims
