# Phase 2 Specification — Auto-Improvement

Phase 2 builds on the working Phase 1 system to add intelligence that improves over time. The system learns from developer rejections, shares learnings across the team via git, and uses data-driven scoring instead of static configuration.

## Scope

### In Phase 2
- Rejection learning loop (Level 1: pattern counting + negative prompts)
- AI diff analysis (Level 2: compare rejected vs accepted diffs)
- Git-shared config for team-wide learnings
- Git-based blast radius scoring
- Prompt versioning and A/B comparison
- Cost attribution per issue
- PR analytics (review time, merge-with-edits rate)
- Enhanced dashboard metrics

### NOT in Phase 2 (future)
- Real-time LLM-based risk assessment per issue
- Multi-repo aggregated dashboard (central server)
- Custom plugin marketplace
- Automated test generation for fixes

## Feature 1: Rejection Learning Loop

### Level 1 — Pattern Counting (automated)

When a developer rejects a fix:

1. Store rejection in `fix_attempts` with `status=failed`, `diff_content` (the git diff), `prompt_version`
2. Upsert `rejection_patterns` row by `(source, rule_id, pattern_tag)`
3. Increment `occurrences` count, update `last_seen_at`
4. When `occurrences >= 3` for a pattern:
   - Prompt builder auto-appends negative clause to future prompts for that rule_id
   - Format: `"IMPORTANT: Previous fixes for this rule were rejected because [pattern_tag]. Specifically avoid: [negative_prompt_clause]."`
5. Write updated patterns to `config/rejection-patterns.json` (git-shared)

### Level 2 — AI Diff Analysis (triggered)

When a rule_id accumulates 3+ rejected diffs AND 2+ accepted diffs:

1. Collect all `fix_attempts` for that `(source, rule_id)`:
   - Failed attempts: the diffs that developers rejected
   - Successful attempts: the diffs that developers approved
2. Feed both sets to an LLM with this prompt:
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
3. If confidence >= 0.7: auto-update `rejection_patterns.negative_prompt_clause`
4. If confidence < 0.7: flag for human review in dashboard
5. Log the AI analysis in a new `learning_events` table

### When Level 2 triggers

- Batch job: runs after each `fetch` if there are new rejection data
- Manual trigger: `autofix-hub learn` command
- Dashboard button: "Analyze Rejections" per rule_id

### New table: `learning_events`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source TEXT,
rule_id TEXT,
event_type TEXT,          -- 'ai_analysis', 'manual_override', 'pattern_promoted'
input_summary TEXT,       -- "5 rejected, 3 accepted diffs analyzed"
output TEXT,              -- JSON: the AI's analysis
confidence REAL,
applied INTEGER DEFAULT 0,  -- was the suggestion applied to prompts?
created_at TEXT
```

## Feature 2: Git-Shared Config

### How team learning flows through git

```
Developer A rejects fix → local DB updated → config/rejection-patterns.json updated
Developer A commits config/ → git push
Developer B does git pull → their prompt builder reads updated patterns
Developer B's AI fixes are now smarter
```

### config/rejection-patterns.json format

```json
{
  "version": 1,
  "patterns": [
    {
      "source": "apiiro",
      "rule_id": "SECRET_IN_CODE",
      "tag": "wrong_scope",
      "occurrences": 5,
      "negative_clause": "Only modify the line containing the hardcoded secret and the .env file. Do not change imports, variable names, formatting, or any other lines.",
      "confidence": 0.85,
      "generated_by": "ai_analysis",
      "last_updated": "2026-03-15T10:00:00Z"
    },
    {
      "source": "aqa",
      "rule_id": "color-contrast",
      "tag": "style_mismatch",
      "occurrences": 3,
      "negative_clause": "Use colors from the existing design system variables. Do not introduce new color values.",
      "confidence": 1.0,
      "generated_by": "manual",
      "last_updated": "2026-03-20T14:30:00Z"
    }
  ]
}
```

### Merge handling

If two developers modify `rejection-patterns.json` simultaneously:
- Each pattern is identified by `(source, rule_id, tag)` — acts as a composite key
- On merge conflict: higher `occurrences` count wins (more data = more reliable)
- CLI provides `autofix-hub learn merge` to resolve conflicts automatically

## Feature 3: Git-Based Blast Radius Scoring

### What it computes

For every file in the repo, analyze git history to derive:

```js
{
  file_path: 'src/auth/login.js',
  change_frequency: 47,        // commits touching this file in last 6 months
  coupling_score: 8,           // avg number of other files changed in same commits
  contributor_count: 12,       // unique authors
  bug_fix_ratio: 0.6,          // fraction of changes that were bug fixes
  recency: 0.9,                // how recently changed (decays over time)
  computed_criticality: 8.5    // combined score
}
```

### How it integrates with scoring

```
Phase 1 formula:
  impact_score = severity_weight × path_criticality (from config)

Phase 2 formula:
  git_criticality = log(change_frequency) × log(coupling + 1) × contributor_factor × bug_fix_factor
  config_criticality = path_criticality (from config/scoring.json, acts as override)
  effective_criticality = max(git_criticality, config_criticality)
  impact_score = severity_weight × effective_criticality
```

Manual config overrides git-based scoring when configured (e.g., for new files that lack git history but are known-critical).

### Computation

- `autofix-hub analyze-repo` — runs git log analysis, caches results in `.autofix-hub/git-analysis.json`
- Auto-runs during `fetch` if cache is older than 24 hours
- Incremental: only re-analyzes files changed since last run
- Not committed to git (repo-specific, derivable from git history)

### New CLI command

```bash
autofix-hub analyze-repo              # run git analysis
autofix-hub analyze-repo --verbose    # show top files by criticality
```

## Feature 4: Prompt Versioning & A/B Comparison

### How it works

1. Every generated prompt gets a `prompt_version` string: `"{source}-{rule_id}-v{n}"`
2. When rejection learning updates a prompt template, version increments
3. `fix_attempts` table records which `prompt_version` was used
4. Metrics compute acceptance rate per prompt_version:
   ```sql
   SELECT prompt_version, 
          COUNT(CASE WHEN status='success' THEN 1 END) * 100.0 / COUNT(*) as acceptance_rate
   FROM fix_attempts
   GROUP BY prompt_version
   ```
5. Dashboard shows: "v2 prompt for SECRET_IN_CODE has 78% acceptance vs v1's 42%"

### Auto-promotion

When a new prompt version has 5+ attempts and a higher acceptance rate than the previous version by 10+ percentage points → mark as "promoted" in `learning_events`. The old version is retired.

## Feature 5: Cost Attribution

### What it computes

Each issue gets an estimated cost-of-delay:

```js
{
  compliance_risk: 'high',           // WCAG A violations on public pages
  estimated_penalty: '$50k-500k',    // configurable per rule category
  revenue_impact: 'medium',          // based on page importance
  sla_hours_remaining: 48,           // from configured SLA per severity
}
```

### Configuration

`config/cost-model.json`:
```json
{
  "compliance_penalties": {
    "wcag_a": { "min": 50000, "max": 500000, "label": "ADA/Section 508" },
    "secret_exposed": { "min": 100000, "max": 1000000, "label": "Data breach" },
    "critical_vulnerability": { "min": 25000, "max": 250000, "label": "Security incident" }
  },
  "sla_hours": {
    "critical": 24,
    "high": 72,
    "medium": 168,
    "low": 720
  }
}
```

### Dashboard integration

- Cost column in issues table (sortable)
- Summary card: "Estimated risk exposure: $X across Y open issues"
- SLA countdown badges (green/yellow/red)

## Feature 6: PR Analytics

### What it tracks

After a PR is created via `approve`:

1. Poll PR status periodically (or on `autofix-hub pr-status <id>`)
2. Track:
   - Time from PR creation to merge
   - Whether PR was merged as-is or with additional commits (developer edits)
   - Number of review comments
   - CI pass/fail rate

### New table: `pr_analytics`

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
issue_id TEXT,
pr_url TEXT,
created_at TEXT,
merged_at TEXT,
review_comments INTEGER,
additional_commits INTEGER,  -- commits after PR creation (developer edits)
ci_passed INTEGER,
merge_type TEXT             -- 'clean' (no edits), 'edited' (developer modified), 'closed' (abandoned)
```

### Metrics

- **Trust score:** % of PRs merged without edits (system getting better = higher trust)
- **Review time:** Average time from PR creation to merge
- **CI reliability:** % of auto-generated PRs that pass CI on first try

## Enhanced Dashboard (Phase 2 additions)

### New metrics tab sections

- **Learning Progress:** How many rejection patterns exist, when last updated, confidence distribution
- **Prompt Evolution:** Acceptance rate over time per prompt version (line chart)
- **Git Analysis:** Top 20 critical files by computed score, coupling graph
- **Cost Dashboard:** Total risk exposure, SLA status, cost by category
- **PR Trust Trend:** Trust score over time, review time trend
- **Top Rejection Reasons:** Bar chart by tag + rule_id

### Learning management panel

- View all rejection patterns
- Edit negative clauses manually
- Trigger AI analysis per rule_id
- View learning events log
- Promote/demote prompt versions

## New CLI Commands (Phase 2)

```bash
autofix-hub learn                     # trigger AI diff analysis for all eligible rules
autofix-hub learn --rule <rule_id>    # analyze specific rule
autofix-hub learn merge               # resolve rejection-patterns.json merge conflicts
autofix-hub analyze-repo              # run git-based blast radius analysis
autofix-hub analyze-repo --verbose    # show top critical files
autofix-hub pr-status <id>            # check PR analytics for an issue
autofix-hub cost-report               # terminal cost/risk summary
```

## Migration from Phase 1

Phase 2 changes are additive. No breaking changes to Phase 1:

1. **Schema additions:** New `learning_events` and `pr_analytics` tables. `fix_attempts` gets `diff_content` column (if not already added in Phase 1 preparation).
2. **Config additions:** New `config/rejection-patterns.json` and `config/cost-model.json` files.
3. **Scoring integration:** Git-based scoring supplements but doesn't replace config-based scoring.
4. **Prompt builder:** Reads rejection-patterns.json in addition to existing prompt templates.

Migration command: `autofix-hub setup --migrate` adds new tables and config files without touching existing data.
