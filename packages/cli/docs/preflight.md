# Preflight

Validate toolchain and environment before multi-agent work.

## Arguments

- `$AGENT` = agent identity (required)

## Steps

1. Resolve agent identity: use `--agent` argument if provided, otherwise `$AGENT` env var. If neither is set, stop and instruct the user.
2. `botbus status`
3. `BOTBUS_AGENT=$AGENT botbus whoami`
4. `br where`
5. `maw doctor`
6. `crit doctor`
