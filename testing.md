# Testing Plan

End-to-end testing of `botbox` CLI against real repos using `botty` for interactive session control.

## Prerequisites

```bash
cd ~/src/botbox/packages/cli && bun install
export PATH="$HOME/src/botbox/packages/cli/src:$PATH"  # or: bun link
```

Confirm tools are available:
```bash
botbox --version
botty doctor
jj --version
```

## 1. Fresh repo — non-interactive init

Create a brand-new repo and bootstrap it entirely via CLI flags (simulates what an agent would do).

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

botbox init \
  --name test-fresh \
  --type api \
  --tools beads,maw,crit,botbus,botty \
  --reviewers security \
  --no-interactive

botbox doctor
botbox sync --check
```

**Verify:**
- [ ] `.agents/botbox/` exists with all 9 workflow docs
- [ ] `.agents/botbox/.version` contains a 12-char hex hash
- [ ] `AGENTS.md` exists with managed section markers
- [ ] `CLAUDE.md` is a symlink to `AGENTS.md`
- [ ] Managed section contains all expected headings (Identity, Lifecycle, Quick Start, Beads Conventions, Mesh Protocol, Spawning Agents, Reviews, Stack Reference)
- [ ] `doctor` exits 0
- [ ] `sync --check` exits 0 (already up to date)

**Cleanup:**
```bash
rm -rf "$WORKDIR"
```

## 2. Fresh repo — interactive init via botty

Test the interactive prompts by spawning botbox inside botty and sending keystrokes.

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

botty spawn -n init-test -- bash -c "cd $WORKDIR && botbox init"
```

**Drive the prompts:**
```bash
# Project name
botty wait init-test --contains "Project name:"
botty send init-test "my-interactive-project"

# Project type — select with arrow keys + enter
botty wait init-test --contains "Project type:"
botty send init-test ""  # enter selects first option (api)

# Tools — all checked by default, just confirm
botty wait init-test --contains "Tools to enable:"
botty send init-test ""  # enter confirms defaults

# Reviewer roles — select security
botty wait init-test --contains "Reviewer roles:"
botty send init-test " "  # space to toggle first option
botty send init-test ""   # enter to confirm

# Initialize beads — default yes
botty wait init-test --contains "Initialize beads?"
botty send init-test ""   # enter for default

# Wait for completion
botty wait init-test --contains "Done." --timeout 10
botty snapshot init-test
```

**Verify (after completion):**
```bash
test -d "$WORKDIR/.agents/botbox" && echo "PASS: agents dir" || echo "FAIL"
test -L "$WORKDIR/CLAUDE.md" && echo "PASS: symlink" || echo "FAIL"
grep -q "my-interactive-project" "$WORKDIR/AGENTS.md" && echo "PASS: name" || echo "FAIL"
grep -q "Reviewer roles: security" "$WORKDIR/AGENTS.md" && echo "PASS: reviewers" || echo "FAIL"
```

**Cleanup:**
```bash
botty kill init-test
rm -rf "$WORKDIR"
```

## 3. Existing repo — clone and init

Clone a real project and bootstrap it. Uses botcrit as the guinea pig since it's a known Rust project.

```bash
WORKDIR=$(mktemp -d)
cp -r ~/src/botcrit "$WORKDIR/botcrit"
cd "$WORKDIR/botcrit"

botbox init \
  --name botcrit \
  --type library \
  --tools beads,maw,crit,botbus \
  --no-interactive \
  --force
```

**Verify:**
- [ ] Existing files untouched (Cargo.toml, src/, etc. still present)
- [ ] `.agents/botbox/` created alongside existing project files
- [ ] `AGENTS.md` generated with `Project type: library`
- [ ] `CLAUDE.md` symlinked (or skipped if one already exists)
- [ ] `doctor` reports missing tools appropriately (botty not in tools list)

```bash
botbox doctor
```

**Cleanup:**
```bash
rm -rf "$WORKDIR"
```

## 4. Sync after doc change

Simulate a botbox upgrade by modifying a bundled doc, then running sync.

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

# Init
botbox init --name sync-test --type api --tools beads --no-interactive

# Verify sync says up to date
botbox sync --check && echo "PASS: up to date" || echo "FAIL: unexpected stale"

# Tamper with version marker to simulate stale docs
echo "000000000000" > .agents/botbox/.version

# sync --check should now fail
botbox sync --check 2>&1 && echo "FAIL: should be stale" || echo "PASS: detected stale"

# Run actual sync
botbox sync

# Verify it updated
botbox sync --check && echo "PASS: synced" || echo "FAIL"
```

**Verify:**
- [ ] `sync --check` exits non-zero when stale
- [ ] `sync` updates docs and version marker
- [ ] `sync --check` exits 0 after sync
- [ ] AGENTS.md managed section is refreshed (contains current headings)

**Cleanup:**
```bash
rm -rf "$WORKDIR"
```

## 5. Sync preserves user content

Ensure the managed section replacement doesn't eat user-written content.

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

botbox init --name preserve-test --type frontend --tools beads --no-interactive

# Add custom content above and below managed section
sed -i '1i\# My Custom Header\n\nDo not delete this.\n' AGENTS.md
echo -e "\n## My Custom Footer\n\nThis should survive sync." >> AGENTS.md

# Force stale
echo "000000000000" > .agents/botbox/.version

# Sync
botbox sync

# Check preservation
grep -q "My Custom Header" AGENTS.md && echo "PASS: header preserved" || echo "FAIL"
grep -q "Do not delete this" AGENTS.md && echo "PASS: custom content" || echo "FAIL"
grep -q "My Custom Footer" AGENTS.md && echo "PASS: footer preserved" || echo "FAIL"
grep -q "botbox:managed-start" AGENTS.md && echo "PASS: markers present" || echo "FAIL"
```

**Cleanup:**
```bash
rm -rf "$WORKDIR"
```

## 6. Doctor on a healthy vs broken setup

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

# Doctor before init — should fail
botbox init --name doctor-test --type api --tools beads,maw,crit,botbus,botty --no-interactive
botbox doctor && echo "PASS: healthy" || echo "FAIL"

# Break things
rm -rf .agents/botbox
botbox doctor 2>&1 && echo "FAIL: should detect missing dir" || echo "PASS: detected"

# Partially break — remove symlink
botbox init --name doctor-test --type api --tools beads,maw,crit,botbus,botty --no-interactive --force
rm CLAUDE.md
botbox doctor 2>&1  # should report missing CLAUDE.md
```

**Cleanup:**
```bash
rm -rf "$WORKDIR"
```

## 7. Interactive init via botty — edge cases

Test prompt validation and unusual inputs.

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

botty spawn -n edge-test -- bash -c "cd $WORKDIR && botbox init"

# Empty project name — should re-prompt or accept empty
botty wait edge-test --contains "Project name:"
botty send edge-test "test-edge"

# Navigate project type with arrow keys — select "monorepo" (4th option)
botty wait edge-test --contains "Project type:"
botty send-bytes edge-test "1b5b42"  # down arrow
botty send-bytes edge-test "1b5b42"  # down arrow
botty send-bytes edge-test "1b5b42"  # down arrow
botty send edge-test ""              # enter on monorepo

# Deselect all tools
botty wait edge-test --contains "Tools to enable:"
# All checked by default — press 'a' to toggle all off (inquirer checkbox)
botty send edge-test "a"
botty send edge-test ""  # confirm empty selection

# Skip reviewers
botty wait edge-test --contains "Reviewer roles:"
botty send edge-test ""

# No beads
botty wait edge-test --contains "Initialize beads?"
botty send edge-test "n"

botty wait edge-test --contains "Done." --timeout 10
botty snapshot edge-test
```

**Verify:**
```bash
grep -q "monorepo" "$WORKDIR/AGENTS.md" && echo "PASS: type" || echo "FAIL"
```

**Cleanup:**
```bash
botty kill edge-test
rm -rf "$WORKDIR"
```

## 8. Init on existing repo — --force vs no --force

```bash
WORKDIR=$(mktemp -d)
cd "$WORKDIR" && jj git init

# First init
botbox init --name force-test --type api --tools beads --no-interactive

# Second init without --force — should warn about AGENTS.md
botbox init --name force-test-2 --type library --tools beads --no-interactive 2>&1 \
  | grep -q "already exists" && echo "PASS: warned" || echo "FAIL"

# Verify AGENTS.md still has original name
grep -q "force-test" AGENTS.md && echo "PASS: not overwritten" || echo "FAIL"

# With --force — should overwrite
botbox init --name force-test-2 --type library --tools beads --no-interactive --force
grep -q "force-test-2" AGENTS.md && echo "PASS: overwritten" || echo "FAIL"
```

**Cleanup:**
```bash
rm -rf "$WORKDIR"
```

## Running all non-interactive tests

The non-interactive tests (1, 3, 4, 5, 6, 8) can be scripted. The interactive tests (2, 7) require botty and are better run manually or in a dedicated test harness.

A future `scripts/e2e-test.sh` could automate the non-interactive suite.
