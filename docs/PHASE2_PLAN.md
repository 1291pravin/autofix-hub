# Phase 2 Implementation Plan — Auto-Improvement

Builds on a working Phase 1 system. Each step lists exact files to create/modify and dependencies.

**Prerequisite:** All Phase 1 steps complete and functional.

## Step 1: Schema Migration

**Modify this file:**

### `packages/core/src/setup.js`

Add migration support:

- `runMigrations(db)` — check a `schema_version` pragma or metadata table, apply new migrations
- Migration 1 (Phase 2):
  - Add `diff_content` column to `fix_attempts` if not present (Phase 1 may already include it as empty)
  - Create `learning_events` table:
    ```sql
    CREATE TABLE IF NOT EXISTS learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      rule_id TEXT,
      event_type TEXT,          -- 'ai_analysis', 'manual_override', 'pattern_promoted'
      input_summary TEXT,       -- "5 rejected, 3 accepted diffs analyzed"
      output TEXT,              -- JSON: the AI's analysis
      confidence REAL,
      applied INTEGER DEFAULT 0,
      created_at TEXT
    );
    ```
  - Create `pr_analytics` table:
    ```sql
    CREATE TABLE IF NOT EXISTS pr_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT,
      pr_url TEXT,
      created_at TEXT,
      merged_at TEXT,
      review_comments INTEGER,
      additional_commits INTEGER,
      ci_passed INTEGER,
      merge_type TEXT           -- 'clean', 'edited', 'closed'
    );
    ```
  - Create indexes on new tables

- Add `autofix-hub setup --migrate` flag that runs migrations without re-running the full wizard

**CLI update:** In `packages/core/bin/autofix-hub.js`, add `--migrate` flag to setup command.

**Depends on:** Phase 1 complete.

---

## Step 2: Diff Storage in Fix Attempts

**Modify these files:**

### `packages/core/src/commands/approve.js`

Update `approveCommand`:
- After successful approval, capture full diff: `git.getDiffContent(branch)`
- Store in `fix_attempts` row: `diff_content = diffContent`, `status = 'success'`

### `packages/core/src/commands/reject.js`

Update `rejectCommand`:
- Before deleting the branch, capture full diff: `git.getDiffContent(branch)`
- Store in `fix_attempts` row: `diff_content = diffContent`, `status = 'failed'`
- Limit diff storage to first 500 lines if larger (configurable via `MAX_DIFF_LINES=500` in .env)

**Depends on:** Step 1 (schema migration).

---

## Step 3: Rejection Learning — Level 1 (Pattern Counting)

**Modify this file:**

### `packages/core/src/commands/reject.js`

Already upserts `rejection_patterns` in Phase 1. Add:

- After upserting, check if `occurrences >= 3` for this `(source, rule_id, pattern_tag)`
- If threshold reached AND `negative_prompt_clause` is empty:
  - Generate a default clause from the tag: `"Previous fixes for this rule were rejected ${occurrences} times for ${tag}. Avoid: ${tagDescription}."`
  - Tag descriptions map:
    ```js
    {
      wrong_scope: "changing files or code outside the affected area",
      broke_tests: "introducing changes that break existing tests",
      style_mismatch: "not following existing code patterns and style conventions",
      incomplete_fix: "only partially fixing the issue or missing edge cases",
      wrong_approach: "using an incorrect or inappropriate solution strategy",
      other: "issues described in previous rejection reasons"
    }
    ```
- Update `rejection_patterns.negative_prompt_clause`

**Create this file:**

### `packages/core/src/promptEnhancer.js`

Prompt enhancement layer that wraps plugin prompt templates:

- `enhancePrompt(basePrompt, source, ruleId, db)`:
  1. Query `rejection_patterns` WHERE `source=? AND rule_id=? AND occurrences >= 3 AND negative_prompt_clause IS NOT NULL`
  2. For each matching pattern, append to prompt:
     ```
     IMPORTANT: Previous fixes for this rule were rejected ${occurrences} times.
     ${negative_prompt_clause}
     ```
  3. Return enhanced prompt

**Modify this file:**

### `packages/core/src/commands/fix.js`

Update fix-next, fix, and fix-cluster:
- After getting `plugin.promptTemplate(issue)` (or batchPromptTemplate), call `enhancePrompt()` before outputting
- Include `prompt_version` in the output JSON

**Depends on:** Step 1.

---

## Step 4: Git-Shared Rejection Patterns

**Create this file:**

### `packages/core/src/sharedConfig.js`

Sync between DB `rejection_patterns` and `config/rejection-patterns.json`:

- `exportPatterns(db)`:
  1. Read all `rejection_patterns` where `occurrences >= 3`
  2. Write to `config/rejection-patterns.json` in the format from PHASE2_SPEC
  3. Preserve existing entries not in DB (manual entries by teammates)

- `importPatterns(db)`:
  1. Read `config/rejection-patterns.json`
  2. For each pattern not in local DB: insert with the shared occurrences count
  3. For each pattern in both: use higher occurrences count (more data = more reliable)
  4. Update `negative_prompt_clause` from shared file if local is empty

- `mergeConflicts()`:
  1. Parse conflict markers in `rejection-patterns.json`
  2. For each conflicted pattern: keep the one with higher occurrences
  3. Write resolved file

**Modify this file:**

### `packages/core/src/commands/reject.js`

After updating local DB patterns:
- Call `exportPatterns(db)` to sync to config file
- Print: "Updated config/rejection-patterns.json — commit to share with team"

**Modify this file:**

### `packages/core/src/commands/fetch.js`

At start of fetch:
- Call `importPatterns(db)` to pick up teammates' learnings from config file

**New CLI command in `packages/core/bin/autofix-hub.js`:**

```bash
autofix-hub learn merge   # resolve config/rejection-patterns.json conflicts
```

**Scaffold file:**

### `config/rejection-patterns.json`

```json
{
  "version": 1,
  "patterns": []
}
```

Created during `autofix-hub setup` if missing.

**Depends on:** Step 3 (rejection patterns must exist in DB).

---

## Step 5: Rejection Learning — Level 2 (AI Diff Analysis)

**Create this file:**

### `packages/core/src/learn.js`

AI-powered rejection analysis:

- `analyzeRejections(source, ruleId, db)`:
  1. Query `fix_attempts` for this `(source, rule_id)`:
     - Failed: WHERE `status='failed' AND diff_content IS NOT NULL`
     - Successful: WHERE `status='success' AND diff_content IS NOT NULL`
  2. Need: at least 3 failed AND 2 successful to proceed
  3. Truncate each diff to 200 lines max (keep most relevant parts)
  4. Build analysis prompt (as specified in PHASE2_SPEC):
     ```
     Here are ${failedCount} rejected fix diffs and ${successCount} accepted fix diffs
     for the same type of issue (rule: ${ruleId}, source: ${source}).
     
     REJECTED DIFFS:
     ${rejectedDiffs}
     
     ACCEPTED DIFFS:
     ${acceptedDiffs}
     
     Analyze the patterns:
     1. What do rejected fixes have in common that accepted ones don't?
     2. What do accepted fixes have in common?
     3. Generate a specific, actionable instruction (max 2 sentences) that would
        prevent future rejections for this rule.
     
     Output JSON: { "pattern": "...", "negative_clause": "...", "confidence": 0.0-1.0 }
     ```
  5. Call LLM API (configurable: OpenAI, Anthropic, or local via `LLM_PROVIDER` + `LLM_API_KEY` env vars)
  6. Parse JSON response
  7. If `confidence >= 0.7`:
     - Update `rejection_patterns.negative_prompt_clause` with AI-generated clause
     - Set `generated_by: 'ai_analysis'` in shared config
     - Log to `learning_events`: event_type='ai_analysis', applied=1
  8. If `confidence < 0.7`:
     - Log to `learning_events`: event_type='ai_analysis', applied=0
     - Flag for human review (dashboard shows these)

- `analyzeAllEligible(db)`:
  1. Find all `(source, rule_id)` combos with 3+ failed and 2+ successful attempts
  2. Filter out those already analyzed (check `learning_events` for recent analysis)
  3. Run `analyzeRejections()` for each

- `learnCommand(options)`:
  - CLI handler for `autofix-hub learn`
  - If `--rule <ruleId>` specified: analyze that rule only
  - Otherwise: `analyzeAllEligible()`
  - Print results summary

**Modify this file:**

### `packages/core/src/commands/fetch.js`

After fetch completes:
- Check if any rules are eligible for Level 2 analysis (have new rejection data since last analysis)
- If yes, run analysis in background (non-blocking)
- Print: "Learning: analyzing rejection patterns for {N} rules..."

**New CLI command in `packages/core/bin/autofix-hub.js`:**

```bash
autofix-hub learn                    # analyze all eligible rules
autofix-hub learn --rule SECRET_IN_CODE   # analyze specific rule
```

**New .env variables:**

```env
# LLM for rejection analysis (Phase 2)
LLM_PROVIDER=anthropic              # anthropic, openai
LLM_API_KEY=
LLM_MODEL=claude-sonnet-4-6        # or gpt-4o
```

**Depends on:** Steps 2, 3, 4 (diffs stored, patterns exist, shared config works).

---

## Step 6: Git-Based Blast Radius Scoring

**Create this file:**

### `packages/core/src/gitAnalysis.js`

Git history analysis for data-driven scoring:

- `analyzeRepo(options)`:
  1. Run `git log --numstat --since="6 months ago" --format="%H %ae %s"` — parse all commits
  2. For each file, compute:
     - `change_frequency`: number of commits touching this file
     - `coupling_score`: for each commit touching this file, count other files in same commit. Average.
     - `contributor_count`: unique commit authors for this file
     - `bug_fix_ratio`: fraction of commits whose message matches `fix|bug|patch|hotfix` (regex)
     - `recency`: weighted by commit date (recent changes score higher, exponential decay)
  3. Combine into `computed_criticality`:
     ```
     computed_criticality = log(change_frequency + 1) 
                          × log(coupling_score + 1) 
                          × log(contributor_count + 1) 
                          × (1 + bug_fix_ratio) 
                          × recency
     ```
  4. Normalize to 1-10 scale
  5. Cache results in `.autofix-hub/git-analysis.json`:
     ```json
     {
       "computed_at": "2026-04-05T10:00:00Z",
       "files": {
         "src/auth/login.js": {
           "change_frequency": 47,
           "coupling_score": 8,
           "contributor_count": 12,
           "bug_fix_ratio": 0.6,
           "recency": 0.9,
           "computed_criticality": 8.5
         }
       }
     }
     ```

- `getFileCriticality(filePath)`:
  1. Check if cache exists and is fresh (< 24 hours)
  2. If stale: re-run analysis (or run incrementally)
  3. Return `computed_criticality` for file, or default (3) if not in cache

- `analyzeRepoCommand(options)`:
  - CLI handler for `autofix-hub analyze-repo`
  - If `--verbose`: print top 20 files by criticality in a table

**Modify this file:**

### `packages/core/src/scoring.js`

Update `scoreIssue()`:

```js
// Phase 1 (unchanged):
const config_criticality = getPathCriticality(issue.file_path, scoringConfig);

// Phase 2 (new):
const git_criticality = gitAnalysis.getFileCriticality(issue.file_path);
const effective_criticality = Math.max(git_criticality, config_criticality);

// Use effective_criticality instead of config_criticality
impact_score = severity_weight * effective_criticality * source_factor;
```

Manual config overrides git when higher (new critical file with no history).
Git overrides config when higher (hot file not manually configured).

**New CLI command in `packages/core/bin/autofix-hub.js`:**

```bash
autofix-hub analyze-repo              # run analysis
autofix-hub analyze-repo --verbose    # show top files
```

**Modify this file:**

### `packages/core/src/commands/fetch.js`

At start of fetch, before scoring:
- Check if git-analysis cache is stale (> 24 hours)
- If stale: run `analyzeRepo()` (incremental)

**Depends on:** Phase 1 scoring engine.

---

## Step 7: Prompt Versioning & A/B Comparison

**Modify this file:**

### `packages/core/src/promptEnhancer.js`

Add versioning:

- `getPromptVersion(source, ruleId, db)`:
  1. Query current negative clauses count for this rule
  2. Version format: `"{source}-{ruleId}-v{n}"` where n = number of active rejection pattern clauses + 1
  3. When a new rejection pattern clause is added → version increments automatically

- Update `enhancePrompt()` to return `{prompt, version}` instead of just the prompt string

**Modify this file:**

### `packages/core/src/commands/fix.js`

- Store `prompt_version` on the `fix_attempts` row when creating it
- Include `prompt_version` in output JSON

**Create this file:**

### `packages/core/src/promptMetrics.js`

A/B comparison logic:

- `getPromptPerformance(source, ruleId, db)`:
  ```sql
  SELECT prompt_version,
         COUNT(*) as total_attempts,
         COUNT(CASE WHEN status='success' THEN 1 END) as successes,
         COUNT(CASE WHEN status='success' THEN 1 END) * 100.0 / COUNT(*) as acceptance_rate
  FROM fix_attempts
  WHERE source=? AND rule_id=?
  GROUP BY prompt_version
  ORDER BY prompt_version DESC
  ```
  Returns array of `{version, total, successes, acceptance_rate}`

- `checkForPromotion(source, ruleId, db)`:
  1. Get performance for all versions
  2. If latest version has 5+ attempts AND acceptance rate 10+ points higher than previous → promote
  3. Log to `learning_events`: event_type='pattern_promoted'
  4. Return promotion info for display

Called after each approve/reject in the respective commands.

**Depends on:** Steps 3, 5 (prompt enhancement, learning).

---

## Step 8: Cost Attribution

**Create these files:**

### `config/cost-model.json`

```json
{
  "compliance_penalties": {
    "wcag_a": { "min": 50000, "max": 500000, "label": "ADA/Section 508 compliance" },
    "wcag_aa": { "min": 25000, "max": 250000, "label": "WCAG AA compliance" },
    "secret_exposed": { "min": 100000, "max": 1000000, "label": "Data breach risk" },
    "critical_vulnerability": { "min": 25000, "max": 250000, "label": "Security incident" },
    "high_vulnerability": { "min": 10000, "max": 100000, "label": "Security risk" },
    "blocker_bug": { "min": 5000, "max": 50000, "label": "Production incident" }
  },
  "sla_hours": {
    "critical": 24,
    "high": 72,
    "medium": 168,
    "low": 720,
    "info": 2160
  }
}
```

### `packages/core/src/costAttribution.js`

- `computeIssueCost(issue, costModel)`:
  1. Map issue to a cost category based on `(source, category, severity)`
  2. Return `{compliance_risk, estimated_penalty_range, sla_hours, sla_deadline, sla_status}`
  3. SLA status: green (>50% time remaining), yellow (10-50%), red (<10%), overdue

- `getCostReport(db, costModel)`:
  1. Query all open issues
  2. Compute cost for each
  3. Aggregate: total estimated risk exposure, count by SLA status, top 5 costliest issues
  4. Return report data

- `costReportCommand()`:
  - CLI handler for `autofix-hub cost-report`
  - Print formatted terminal report

**New CLI command in `packages/core/bin/autofix-hub.js`:**

```bash
autofix-hub cost-report
```

**Depends on:** Phase 1 DB with issues.

---

## Step 9: PR Analytics

**Modify this file:**

### `packages/core/src/commands/approve.js`

After creating PR:
- Insert `pr_analytics` row: `issue_id, pr_url, created_at`

**Create this file:**

### `packages/core/src/prAnalytics.js`

- `checkPRStatus(issueId, db)`:
  1. Get PR URL from `pr_analytics`
  2. Run `gh pr view {prUrl} --json state,mergedAt,reviews,commits`
  3. Parse response:
     - If merged: set `merged_at`, compute `additional_commits` (commits after creation), `review_comments`, `merge_type` (clean if 0 additional commits, edited if >0)
     - If closed: set `merge_type='closed'`
     - If open: check CI status, set `ci_passed`
  4. Update `pr_analytics` row

- `updateAllPRs(db)`:
  1. Query `pr_analytics` WHERE `merged_at IS NULL AND merge_type IS NULL`
  2. Run `checkPRStatus()` for each

- `getPRMetrics(db)`:
  - Trust score: % clean merges
  - Average review time: `AVG(merged_at - created_at)`
  - CI reliability: % with `ci_passed=true`

- `prStatusCommand(issueId)`:
  - CLI handler for `autofix-hub pr-status <id>`

**New CLI commands in `packages/core/bin/autofix-hub.js`:**

```bash
autofix-hub pr-status <id>         # check single PR
autofix-hub pr-status --all        # update all open PRs
```

**Modify this file:**

### `packages/core/src/scheduler.js`

Add a scheduled job to run `updateAllPRs()` every hour (or configurable).

**Depends on:** Step 1 (pr_analytics table), Phase 1 approve command.

---

## Step 10: Enhanced Dashboard — API Extensions

**Modify this file:**

### `packages/core/src/dashboard/server.js`

Add new API routes:

```
GET  /api/metrics/prompt-performance?source=&rule_id=   # prompt version A/B data
GET  /api/metrics/cost-report?source=                    # cost attribution data
GET  /api/metrics/pr-analytics?source=                   # PR trust/review metrics
GET  /api/learning/patterns                              # all rejection patterns
GET  /api/learning/events?source=&rule_id=               # learning events log
POST /api/learning/analyze?rule_id=                      # trigger Level 2 analysis
POST /api/learning/patterns/:id                          # edit pattern manually
GET  /api/git-analysis                                   # top files by criticality
GET  /api/git-analysis/:file_path                        # single file analysis
```

**Depends on:** Steps 5-9 (all Phase 2 features).

---

## Step 11: Enhanced Dashboard — Frontend Updates

**Modify this file:**

### `packages/core/src/dashboard/index.html`

Add new dashboard sections:

**Metrics tab additions:**

- **Prompt Evolution section:**
  - Table: rule_id | version | attempts | acceptance rate | status (active/retired)
  - Visual: bar chart comparing versions

- **Cost Dashboard section:**
  - Summary card: "Total estimated risk exposure: $X"
  - SLA status badges breakdown (green/yellow/red/overdue counts)
  - Top 5 costliest open issues table
  - Cost by category pie/bar chart

- **PR Trust section:**
  - Trust score % (clean merges)
  - Average review time
  - CI reliability %
  - Trend line over time

- **Git Analysis section:**
  - Top 20 critical files table (file, criticality score, change frequency, coupling)
  - Highlight files that have open issues

**New "Learning" tab:**

- **Rejection Patterns panel:**
  - Table: source | rule_id | tag | occurrences | clause | confidence | generated_by
  - Edit button: inline edit of negative_prompt_clause
  - "Analyze" button per rule: triggers Level 2 AI analysis
  - Status indicator: pattern pending review (confidence < 0.7) vs applied

- **Learning Events log:**
  - Chronological list of AI analyses, manual overrides, promotions
  - Filterable by source, rule_id, event_type
  - Expandable rows showing full AI analysis output

- **Prompt Version History:**
  - Timeline view: version changes with acceptance rate at each point
  - Promotion events highlighted

**Settings tab additions:**

- LLM configuration (provider, model — not the API key, that stays in .env)
- Git analysis controls (re-run button, cache age display)
- Cost model editor (edit SLA hours, penalty ranges)

**Depends on:** Step 10 (API routes).

---

## Step 12: Updated IDE Skills

**Modify these files:**

### `.agents/skills/autofix-shared/SKILL.md`

Add new Phase 2 commands:
- `/autofix-learn` → `autofix-hub learn`
- `/autofix-analyze-repo` → `autofix-hub analyze-repo --verbose`
- `/autofix-cost-report` → `autofix-hub cost-report`
- `/autofix-pr-status <id>` → `autofix-hub pr-status <id>`

### Per-source SKILL.md files

No changes needed — Phase 2 features are source-agnostic and go through shared commands.

**Depends on:** All previous Phase 2 steps.

---

## Migration Checklist

When upgrading from Phase 1 to Phase 2:

1. `autofix-hub setup --migrate` — adds new tables, preserves all data
2. Add new .env variables: `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`
3. Scaffold `config/rejection-patterns.json` and `config/cost-model.json`
4. Run `autofix-hub analyze-repo` — initial git analysis
5. Existing fix_attempts without diff_content will have NULL — that's fine, Level 2 analysis will only use attempts made after Phase 2 is deployed

## Build & Test Checklist

After all Phase 2 steps are complete:

1. `autofix-hub setup --migrate` — adds new tables without errors
2. `autofix-hub apiiro reject <id> wrong_scope "touched unrelated files"` — rejection stored + pattern updated + config file written
3. Reject same rule 3 more times → next `fix-next` prompt includes negative clause
4. `autofix-hub learn` — runs AI analysis (requires LLM_API_KEY)
5. `autofix-hub analyze-repo --verbose` — shows top critical files
6. `autofix-hub cost-report` — shows risk exposure
7. `autofix-hub pr-status --all` — updates PR analytics
8. Dashboard Learning tab shows rejection patterns + events
9. Dashboard Metrics tab shows prompt versions, cost, PR trust, git analysis
10. Edit a rejection pattern in dashboard → saved to DB + config file
11. `git pull` in another developer's clone → their prompts include shared patterns
