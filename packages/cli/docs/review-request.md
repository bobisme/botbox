# Review Request

Request a review using crit and announce it in the project channel.

## Arguments

- `$AGENT` = agent identity (required)
- `<review-id>` = review to request (required)
- `<reviewer>` = reviewer role or agent name (optional)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user. Run `bus whoami --agent $AGENT` first to confirm; if it returns a name, use it.
2. If reviewer provided: `crit reviews request <review-id> --reviewers <reviewer>`.
3. Otherwise: `crit reviews request <review-id>`.
4. `bus send --agent $AGENT $BOTBOX_PROJECT "Review requested: <review-id>" -L mesh -L review-request`

## Assumptions

- `BOTBOX_PROJECT` env var contains the project channel name.
