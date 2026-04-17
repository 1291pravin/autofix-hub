# Plan: Skill-Driven Orchestration (Worktree + On-Demand PR Flow)

**Status:** Not started. Design ready. Supersedes the earlier Kanban-trigger
and background-watcher ideas.

## Core idea

`SKILL.md` is the orchestrator. The user interacts with autofix-hub entirely
through a small set of slash commands in Windsurf/Cascade. Dashboard
becomes an optional stats view — not the trigger path. No background
daemons, no cron jobs. Everything runs on user invocation.

## Constraint from the user (carried forward)

Git operations are currently commented out in the codebase because the user
doesn't want autofix-hub touching git until this flow is trusted. All new
git/PR behavior in this plan lives behind `AUTOFIX_GIT_MODE=worktree` and
`AUTOFIX_GH_PR=true` — both off by default.

## Workflow

```
/autofix fetch apiiro
    ↓   (scanner runs, issues land in DB)
/autofix fix-next apiiro            ← highest-priority cluster (exact-tier first)
    ↓
autofix-hub creates:
  • worktree at .autofix-hub/worktrees/autofix-<id>/ on branch autofix/<id>
  • returns { worktreePath, branch, files, fixPrompt, clusterInfo }
    ↓
Cascade:
  • edits files at absolute paths inside the worktree
  • may READ beyond files[] to understand the fix — but only EDITS files[]
    unless the fix genuinely requires a new file
    ↓
autofix-hub complete <id> --pr
  • git -C <wt> commit + push, gh pr create
  • status: in_progress → ai_fixed → pr_open
    ↓
Skill reports:
  "PR opened: <url>. Next cluster: <key> (N issues).
   Run /autofix fix-next to continue, or /autofix list to pick another."
    ↓
Later: /autofix check-prs apiiro
  • polls gh pr view for every ai_fixed/pr_open issue
  • merged → merged, closed-unmerged → rejected, CI failed → flagged
```

User's main checkout and WIP are never touched. The worktree is a
throwaway isolation boundary.

## Command surface

### Main verbs

| Command | What it does |
|---|---|
| `/autofix fetch [scanner]` | Pull latest issues into DB |
| `/autofix fix-next [scanner]` | **Pick highest-priority cluster/issue**, worktree, fix, PR |
| `/autofix fix <id>` | **Priority override — fix a specific issue by id** |
| `/autofix fix-cluster <clusterId>` | **Priority override — fix a specific cluster by id** |
| `/autofix check-prs [scanner]` | Poll gh, advance `ai_fixed`/`pr_open` → `merged`/`rejected` |

### Discovery & triage

| Command | What it does |
|---|---|
| `/autofix list [scanner] [--status open]` | Show the queue, sorted by priority |
| `/autofix report` | Cross-scanner summary (counts, top priority, velocity) |
| `/autofix sync` | Alias for `fetch` + `check-prs` |
| `/autofix reject <id> <tag> <reason>` | Existing — rolls back, records pattern |
| `/autofix retry <id>` | Flip `rejected` → `open` |

### Setup / infra (unchanged)

`/autofix setup`, `/autofix config <scanner>`, `/autofix dashboard`.

### Why `fix <id>` / `fix-cluster <id>` are first-class

The user's explicit ask: when a specific high-priority issue needs to jump
the queue, they want a direct path to fix it — not "fetch, find its id
somewhere, hack the priority." Both `fix <id>` and `fix-cluster <id>`
bypass `fix-next`'s prioritization and go straight to the worktree + PR
flow on the specified target.

Flow is identical to `fix-next` once the target is chosen:
- Same worktree creation
- Same status transitions
- Same `complete --pr` path

Only difference: `fix-next` queries for the top-priority target;
`fix <id>` / `fix-cluster <id>` accept it from the user.

## Key design decisions

### One cluster at a time — no batch loop
Dropped the earlier `run --max N` idea. Exploration during a fix (tracing
taint paths, checking dep usage) would otherwise bleed between clusters,
PRs would get bigger and less reviewable, and a mid-batch failure would
leave messy state. Each `fix-next` is a clean unit of work.

### Worktree with absolute paths — user stays in main window
Cascade operates on the worktree via absolute paths (`git -C <wt> ...`,
edit `<wt>/src/foo.js`). The user's Windsurf window never switches. Main
checkout, WIP, file tree view all stay as they were. Review happens at the
PR, not in the local editor.

### Skill permits scoped exploration
SKILL.md explicitly allows reading files beyond `files[]` to understand
the fix. Editing is still bounded to `files[]` unless the fix legitimately
requires a new file. This prevents the "skill ran away with itself"
failure mode without hobbling comprehension.

### On-demand PR polling instead of a watcher
`check-prs` runs when the user types it. No cron, no webhook, no daemon.
Trade-off: statuses lag until the user syncs. Acceptable for a side
project and even for real use — polling matches a human's rhythm.

### Continuation is a prompt, not a loop
After every `fix-next` the skill tells the user what the next cluster
would be. User hits enter (or types the command) to continue. Low
friction, full control, no runaway loops.

## Code changes

### New CLI commands

**`autofix-hub complete <id> --pr`**
- Validates worktree exists and has commits ahead of base
- `git -C <wt> push -u origin <branch>`
- `gh pr create` with body built from issue metadata (description,
  scanner link, Apiiro risk URL, CVE refs, etc.)
- Transition: `in_progress` → `ai_fixed` → `pr_open`
- Writes `fix_pr_url`

**`autofix-hub check-prs [scanner]`**
- Selects all issues with status in (`ai_fixed`, `pr_open`)
- For each, runs `gh pr view <url> --json state,mergedAt,statusCheckRollup`
- Transitions:
  - `MERGED` → `merged` (remove worktree)
  - `CLOSED` and not merged → `rejected`
  - `OPEN` + failing checks → flag in output, leave status
  - `OPEN` + green → no change
- Prints a summary table: N merged, N rejected, N still open, N CI failing

**`autofix-hub retry <id>`**
- Validates current status is `rejected`
- Flip to `open`, clear `fix_branch`, `fix_pr_url`, `fix_worktree`
- Remove worktree if still present

### New module

**`packages/core/src/worktree.js`**
```
createWorktree(branch, basePath) → { path, branch }
removeWorktree(path)
listWorktrees() → [{ path, branch, commit }]
worktreeRoot(projectRoot) → <projectRoot>/.autofix-hub/worktrees/
```
Wraps `git worktree add/remove/list --porcelain`. Unit tests use a temp
git repo so no real checkouts are touched.

### Modified files

- **`packages/core/src/commands/fix.js`**
  - `fixNextCommand`, `fixCommand`, `fixClusterCommand` all create a
    worktree when `AUTOFIX_GIT_MODE=worktree` (else keep current behavior)
  - Return `worktreePath` in the JSON output
  - Record `fix_worktree` on issues/clusters
- **`packages/core/src/setup.js`**
  - `fix_worktree TEXT` column on `issues` and `clusters`
  - `issue_status_history` table (for ROI Track 2 later — schema in
    `HOURS_SAVED_ROI_PLAN.md`)
- **`packages/core/bin/autofix-hub.js`**
  - Wire `complete`, `check-prs`, `retry` subcommands
- **`.agents/skills/autofix-hub/SKILL.md`**
  - Add worktree-aware `fix-next` / `fix <id>` / `fix-cluster <id>` flows
    with absolute-path editing
  - Add `check-prs` section
  - Add the edit-scope rule: "READ anywhere for comprehension, EDIT only
    in `files[]` unless the fix requires a new file"
  - Add the continuation hint at end of every fix flow
  - Document `fix <id>` and `fix-cluster <id>` as the priority-override
    entry points — equal first-class citizens with `fix-next`

### Config

`.env`:
```
AUTOFIX_GIT_MODE=off         # "off" (default) or "worktree"
AUTOFIX_GH_PR=false          # true to let complete open PRs via gh
AUTOFIX_WORKTREE_ROOT=.autofix-hub/worktrees   # relative to project root
```

## Build order

1. `worktree.js` helper module + unit tests against a temp git repo.
2. `AUTOFIX_GIT_MODE=worktree` support in `fix-next`, `fix <id>`,
   `fix-cluster <id>`. Verify worktree appears, task state moves, user's
   main checkout is untouched.
3. `autofix-hub complete <id>` with `--push` but **not** `--pr` yet —
   shake out the git side in isolation.
4. Add `--pr` + `gh` integration to `complete`.
5. `autofix-hub check-prs` + `retry`.
6. SKILL.md rewrite with the new command surface, edit-scope rule, and
   continuation hint.
7. (Later, per ROI plan) `issue_status_history` + `/api/roi` endpoint.

## Risks / open questions

1. **gh auth not verified in setup wizard.** Add `checkGhAuth()` to
   `setup.js` and warn if missing before anyone tries `complete --pr`.
2. **Worktree cleanup on rejection.** `retry` must remove the worktree
   and delete the branch. Don't rely on `git worktree prune`.
3. **PR body content.** Needs a template per-scanner so Apiiro PRs
   include risk URL / CVE refs, AQA PRs include WCAG criteria, Sonar PRs
   include rule link. Use `plugin.prBodyTemplate(issue)` if defined, else
   fall back to a generic body.
4. **What if Cascade's fix fails halfway?** Skill should call
   `autofix-hub reject <id> wrong_approach "cascade failed: <reason>"`
   which rolls back the worktree and returns the issue to `open`.

## Business framing (for the promo case)

Before: autofix-hub identifies issues and generates prompts.
After: autofix-hub runs an end-to-end pipeline — from scan to PR — driven
by a handful of slash commands in the IDE. Scanner findings turn into
reviewable PRs with near-zero developer time between the two.

Metrics to surface on the dashboard:
- **Time from scan to PR-opened** (should drop from hours/days → minutes)
- **Hours saved** (per `HOURS_SAVED_ROI_PLAN.md` — two-track accounting)
- **Acceptance rate** of AI PRs (already tracked)
