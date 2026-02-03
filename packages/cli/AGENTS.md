# Botbox CLI - Agent Instructions

This document tracks the interconnected components that must be kept in sync when making changes to the botbox CLI.

## Component Overview

```
packages/cli/
├── scripts/           # Loop scripts (copied to target projects)
├── prompts/           # Prompt templates (copied to target projects)
├── docs/              # Workflow docs (copied to target projects)
├── src/
│   ├── commands/      # CLI commands (init, sync, doctor, run-agent)
│   ├── lib/           # Shared libraries
│   └── migrations/    # Version migrations
```

## Scripts (`packages/cli/scripts/`)

Loop scripts that run agents. **These are copied to target projects** at `.agents/botbox/scripts/`.

| Script | Purpose |
|--------|---------|
| `agent-loop.mjs` | Worker agent: triage-start-work-finish |
| `dev-loop.mjs` | Lead dev: triage, dispatch, monitor, merge |
| `reviewer-loop.mjs` | Reviewer: process reviews, vote LGTM/BLOCKED |

### Script Requirements

- **Must be self-contained**: Scripts run from target projects, not from node_modules. Cannot import from `../src/lib/` - inline any needed utilities.
- **Version tracked**: Changes update the hash in `.scripts-version`, triggering sync updates.
- **Bus command syntax**: Use `bus claims list --mine` not `bus claims --mine`.

## Prompts (`packages/cli/prompts/`)

Reviewer prompt templates. **Copied to target projects** at `.agents/botbox/prompts/`.

| Prompt | Purpose |
|--------|---------|
| `reviewer.md` | Base/generic reviewer prompt |
| `reviewer-security.md` | Security-focused reviewer (aggressive checklist) |

### Adding New Reviewer Roles

1. Create `prompts/reviewer-<role>.md`
2. The role is derived from agent name: `project-<role>` → loads `reviewer-<role>.md`
3. Falls back to `reviewer.md` if specialized prompt not found

### Prompt Variables

Templates use `{{VARIABLE}}` substitution:
- `{{AGENT}}` - Agent name (e.g., `myproject-security`)
- `{{PROJECT}}` - Project name (e.g., `myproject`)

## Migrations (`packages/cli/src/migrations/index.mjs`)

Version-tracked migrations that run during `botbox sync`.

| Version | Migration |
|---------|-----------|
| 1.0.1 | Move scripts from `scripts/` to `.agents/botbox/scripts/` |
| 1.0.2 | Replace `.sh` scripts with `.mjs` versions |
| 1.0.3 | Update botbus hooks from `.sh` to `.mjs` |
| 1.0.4 | Add `default_agent` and `channel` to project config |

### Migration Guidelines

- Migrations must be **idempotent** (safe to re-run)
- Update `.botbox.json` version after each successful migration
- Handle missing files gracefully (check `existsSync` before operations)
- For hooks: strip `@` prefix from mention conditions

## Config File (`.botbox.json`)

Project configuration stored in target projects. Key fields:

```json
{
  "version": "1.0.4",
  "project": {
    "name": "myproject",
    "type": ["cli"],
    "default_agent": "myproject-dev",
    "channel": "myproject"
  },
  "tools": { "beads": true, "maw": true, ... },
  "review": { "enabled": true, "reviewers": ["security"] },
  "agents": {
    "dev": { "model": "opus", "timeout": 900 },
    "worker": { "model": "haiku", "timeout": 600 },
    "reviewer": { "model": "opus", "timeout": 600 }
  }
}
```

### Project Identity Fields

- `project.default_agent`: Lead agent name (e.g., `myproject-dev`). Used by dev-loop.mjs as default AGENT.
- `project.channel`: Botbus channel name (e.g., `myproject`). Used by all scripts as default PROJECT.

Scripts read these on startup, so CLI args become optional:
```bash
# Before: required positional args
bun dev-loop.mjs myproject myproject-dev

# After: can run with no args if config exists
bun dev-loop.mjs
```

CLI args still override config values when provided.

## Init Command (`src/commands/init.mjs`)

Registers botbus hooks for auto-spawning agents.

### Hook Registration

**Dev agent hook** (claim-based):
```
bus hooks add --channel <project> --claim "agent://<project>-dev" --claim-owner <project>-dev --ttl 600 ...
```

**Reviewer hooks** (mention-based):
```
bus hooks add --channel <project> --mention "<project>-<role>" --claim-owner <project>-<role> --ttl 600 ...
```

**Important**: Use `--mention "agent-name"` NOT `--mention "@agent-name"` - botbus expects no `@` prefix.

## Sync Command (`src/commands/sync.mjs`)

Updates target projects with latest docs, scripts, prompts, and runs migrations.

### What Gets Synced

1. **Workflow docs** → `.agents/botbox/*.md` (version in `.version`)
2. **Scripts** → `.agents/botbox/scripts/*.mjs` (version in `.scripts-version`)
3. **Prompts** → `.agents/botbox/prompts/*.md` (version in `.prompts-version`)
4. **Migrations** → Updates `.botbox.json` version
5. **AGENTS.md** → Updates managed section only

### Adding New Synced Content

1. Create version tracking functions in `src/lib/<type>.mjs`:
   - `current<Type>Version()` - hash of bundled content
   - `read<Type>VersionMarker()` / `write<Type>VersionMarker()`
   - `copy<Type>()` or `update<Type>()`

2. Add to `sync.mjs`:
   - Import version functions
   - Add `get<Type>UpdateState()` helper
   - Add to `--check` validation
   - Add update logic

## Common Pitfalls

### Scripts can't import from src/lib
Scripts are copied to target projects. Any imports from `../src/lib/` will fail at runtime. Inline needed utilities directly in the script.

### Hook mention format
Botbus expects `--mention "agent-name"` without `@` prefix. Messages store mentions without `@`, so hooks must match.

### Bus claims syntax
Use `bus claims list --mine` not `bus claims --mine`. The `--mine` flag belongs to the `list` subcommand.

### spawn-security-reviewer.sh is gone
This script was removed. Security reviewers now use `reviewer-loop.mjs` which loads `reviewer-security.md` prompt based on the agent name suffix.

## Testing Changes

1. Run `bun test` - all 105+ tests should pass
2. Run `just lint` - check for lint errors
3. Test on a companion project:
   ```bash
   cd ~/src/<project>
   botbox sync
   # Verify scripts, prompts, docs updated
   # Test hook firing if applicable
   ```
