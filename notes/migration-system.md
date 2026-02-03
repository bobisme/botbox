# Migration System Plan for botbox sync

## Background
- `botbox sync` currently updates workflow docs, AGENTS managed section, loop scripts, and `.botbox.json` via ad hoc checks in `packages/cli/src/commands/sync.mjs`.
- bd-3lp calls for versioned migrations so upgrades are repeatable and automatic (e.g., if version < X, run migration Y).

## Goals
- Track installed version in `.botbox.json` and use it to determine pending migrations.
- Run migrations during `botbox sync` in a deterministic order with clear logging.
- Make migrations safe to re-run (idempotent) and resume-able after partial failures.
- Keep `--check` mode strict: fail if any migrations are pending.

## Non-goals
- Full rollback/undo system (forward-only is acceptable; rollback may be manual per migration).
- General-purpose data migration framework; scope is repo files, config, and botbox-managed artifacts.
- Replacing existing docs/scripts version markers unless there is a clear benefit.

## Design Summary
Introduce a migration registry inside the CLI. Each migration has a version id, title, and an `up()` function that applies changes in the target repo. `botbox sync` loads `.botbox.json` to determine the installed version, runs pending migrations in order, updates the version after each successful migration, and then continues with existing sync updates.

## Migration Registry
**Location**: `packages/cli/src/migrations/index.mjs`

**Shape (pseudo-interface)**
```js
// packages/cli/src/migrations/index.mjs
export const migrations = [
  {
    id: "1.1.0",
    title: "Move loop scripts into .agents/botbox/scripts",
    description: "Migrates legacy scripts/ to managed location.",
    up(ctx) {
      // ctx.projectDir, ctx.agentsDir, ctx.config, ctx.log
      // idempotent: check for existence before moving
    },
  },
]
```

**Guidelines**
- `id` is a semver string (`x.y.z`) and must be unique.
- Migrations run in ascending semver order; add a simple comparator (no new dependency).
- `up()` should be idempotent and defensive (check paths before moving or deleting).
- For destructive changes, prefer quarantining to a `legacy/` path rather than deleting.
- Treat missing files/dirs as success (e.g., `existsSync` checks or `rmSync(..., { force: true })`).

## State Tracking
- `.botbox.json.version` is the single source of truth for installed version.
- Default version when missing or unreadable: `0.0.0` (treated as “pre-migrations”).
- The “latest” version is the highest migration id (or a new exported constant tied to the registry).

## Execution Flow in `botbox sync`
1. Read `.botbox.json` (existing behavior); determine `installedVersion`.
2. Load and sort migration registry; compute `pending = migrations where id > installedVersion`.
3. If `--check` and `pending.length > 0`, exit with a stale message listing versions.
4. For each pending migration:
   - Log start (version + title).
   - Run `migration.up(ctx)`.
   - On success, write `.botbox.json.version = migration.id` immediately (resume safety).
   - On failure, stop and surface the error; do not advance version.
5. Continue existing sync operations (docs, managed section, scripts, config updates).
6. If config schema changes are needed, implement them as migrations instead of a monolithic `upgradeConfig()`.

## AGENTS.md Handling
- Preserve user content: only update the managed section via `updateManagedSection()`.
- Migrations that need to touch AGENTS.md should use the same managed-section helper, not rewrite the full file.

## Error Handling and Safety
- Migrations should be safe to re-run: checks for existence and no-ops if already applied.
- Do not swallow errors silently; surface with `ExitError` and actionable messages.
- Where possible, perform atomic filesystem operations (rename) and write temp files then rename.

## Migration Examples (from bd-3lp)
- `1.1.0`: Remove old `.sh` loop scripts and add `.mjs` scripts; migrate directory layout.
- `1.2.0`: Add `.agents/botbox/` directory structure if missing.
- `1.3.0`: Update hook format / rewrite hook files for new schema.

## Testing Plan
- Add tests in `packages/cli/src/commands/sync.test.mjs`:
  - Migrates from `0.0.0` to latest, applying all migrations in order.
  - `--check` fails when migrations are pending.
  - Idempotency: run `sync` twice; second run does nothing and leaves version unchanged.
  - Failure handling: simulate a failing migration and assert version is not advanced.

## Rollout
- Introduce registry + comparator + wiring in `sync`.
- Convert existing ad hoc migration logic (e.g., scripts directory move) into the registry.
- Announce in release notes that `botbox sync` now runs migrations and relies on `.botbox.json.version`.

## References
- Rails migrations: versioned, ordered by timestamps, reversible via `change` or `up/down`.
- Django migrations: stored in VCS, ordered by dependency graph, atomic when supported.
