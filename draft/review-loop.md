# Review Loop

Review loop for reviewer agents. Process pending review requests and leave feedback.

Your identity is `$AGENT`. All botbus commands must include `--agent $AGENT`.

## Loop

1. Read new review requests:
   - `botbus inbox --agent $AGENT --channel $BOTBOX_PROJECT -n 50`
   - `botbus wait --agent $AGENT -L review-request -t 5` (optional)
2. Use `crit inbox` to find reviews needing attention.
3. For each review, open details: `crit review <id>` and `crit diff <id>`.
4. Leave feedback with `crit comment <id> "..."`.
5. Vote:
   - `crit lgtm <id>` if acceptable
   - `crit block <id>` if changes required
6. Post a summary in the project channel and tag the author: `botbus send --agent $AGENT $BOTBOX_PROJECT "..." -L mesh -L review-done`

Be aggressive on security and correctness. If re-review is requested, verify fixes and state whether risks are resolved.
