# Review Request

Request a review using crit and announce it in the project channel.

## Arguments

- `$AGENT` = agent identity (required)
- `<review-id>` = review to request (required)
- `<reviewer>` = reviewer role or agent name (optional)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user. Run `bus whoami --agent $AGENT` first to confirm; if it returns a name, use it.
2. If a specific reviewer is known: `crit reviews request <review-id> --reviewers <reviewer> --agent $AGENT`.
3. **Spawn a reviewer** (if not requesting a specific reviewer by name):
   - `botty spawn reviewer --project $BOTBOX_PROJECT`
   - This ensures a reviewer agent is running to process the review
4. Announce the review:
   - `bus send --agent $AGENT $BOTBOX_PROJECT "Review requested: <review-id>, spawned reviewer" -L review-request`
   - Include "spawned reviewer" in the message so it's clear a reviewer was started

The reviewer-loop finds open reviews via `crit reviews list` and processes them automatically.

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
