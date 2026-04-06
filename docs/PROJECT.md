# autofix-hub

A modular, plugin-based CLI platform that fetches issues from security and accessibility scanners, scores and clusters them by business impact, generates AI fix prompts, manages git branches/PRs, and provides a unified dashboard. AI fixes the code, developer reviews, system learns from rejections.

## Vision

Developers waste hours context-switching between scanner dashboards, triaging low-value issues, and manually fixing repetitive problems. autofix-hub turns scanner noise into prioritized, AI-fixed, developer-reviewed PRs — with a feedback loop that improves over time.

**The core loop:**
```
Scan → Score → Cluster → AI Fix → Developer Review → PR → Merge
                                        ↓ (reject)
                                   Learn & Improve
```

## Architecture

### Plugin-based monorepo

Single CLI entry point (`autofix-hub`) with scanner-specific logic in plugins. Core handles everything shared; plugins handle fetch, normalize, and prompt templates.

```
autofix-hub <command>              # shared commands (setup, dashboard, report)
autofix-hub apiiro <command>       # scanner-specific commands
autofix-hub aqa <command>
autofix-hub sonarqube <command>
```

### Monorepo structure

```
autofix-hub/
├── package.json                    # pnpm workspaces root
├── pnpm-workspace.yaml
├── .env.example
├── config/                         # committed to git, team-shared
│   ├── scoring.json                # path importance maps, weight tuning
│   ├── effort-map.json             # effort estimates per rule_id
│   └── rejection-patterns.json    # team-shared learnings (Phase 2)
├── packages/
│   ├── core/                       # shared logic + hub CLI
│   │   ├── package.json
│   │   ├── bin/
│   │   │   └── autofix-hub.js      # CLI entry point
│   │   └── src/
│   │       ├── db.js               # SQLite layer, schema, WAL mode
│   │       ├── setup.js            # idempotent DB + table creation + scanner checks
│   │       ├── scoring.js          # impact scoring engine
│   │       ├── clustering.js       # generic clustering engine (calls plugin.clusterKeys)
│   │       ├── dedup.js            # content/structural dedup
│   │       ├── locks.js            # file-level concurrency control
│   │       ├── git.js              # branch, commit, PR, CI check, rollback
│   │       ├── autoApprove.js      # auto-verify low-risk fixes
│   │       ├── scheduler.js        # node-cron auto-fetch
│   │       ├── notify.js           # webhook notifications
│   │       ├── metrics.js          # MTTF, acceptance rate, velocity
│   │       ├── pluginLoader.js     # discovers + loads installed plugins
│   │       ├── commands/
│   │       │   ├── setup.js        # guided setup wizard
│   │       │   ├── fetch.js        # shared fetch orchestration
│   │       │   ├── fix.js          # fix-next, fix <id>, fix-cluster
│   │       │   ├── approve.js      # approve + PR creation
│   │       │   ├── reject.js       # structured rejection
│   │       │   ├── report.js       # terminal summary
│   │       │   ├── rollback.js     # undo a fix
│   │       │   └── status.js       # status transitions
│   │       └── dashboard/
│   │           ├── server.js       # Express API + static + scheduler start
│   │           └── index.html      # React via CDN, metrics tab
│   ├── plugin-apiiro/              # Apiiro security scanner plugin
│   │   ├── package.json
│   │   └── src/
│   │       └── index.js            # fetch, normalize, clusterKeys, promptTemplates
│   ├── plugin-aqa/                 # UsableNet AQA accessibility plugin
│   │   ├── package.json
│   │   └── src/
│   │       └── index.js
│   └── plugin-sonarqube/           # SonarQube code quality plugin
│       ├── package.json
│       └── src/
│           └── index.js
├── .agents/skills/                 # thin IDE integration (Windsurf/Cascade)
│   ├── apiiro-fixer/SKILL.md
│   ├── aqa-fixer/SKILL.md
│   └── sonarqube-fixer/SKILL.md
└── docs/
    ├── PROJECT.md                  # this file
    ├── PHASE1_SPEC.md
    ├── PHASE2_SPEC.md
    ├── PHASE1_PLAN.md
    └── PHASE2_PLAN.md
```

### Why this structure

- **Single CLI, multiple scanners:** `autofix-hub apiiro fetch` vs `autofix-hub aqa fetch`. One tool to learn.
- **Plugins are optional:** Install only the scanner plugins you need. `autofix-hub apiiro` says "plugin not installed" if plugin-apiiro isn't there.
- **Adding a scanner = adding a plugin:** Implement fetch, normalize, clusterKeys, and promptTemplates. Core handles everything else.
- **Shared logic lives in core:** DB, git, scoring, clustering, dashboard, metrics — written once.
- **Plugins are also importable as libraries:** `const apiiro = require('@yourorg/plugin-apiiro')` for CI/programmatic use.

### Multi-repo / Multi-project support

autofix-hub is designed for developers working across multiple repositories:

```
~/.autofix-hub/
  credentials.json              # scanner API keys/tokens (configured once)

<any-repo>/.autofix-hub/        # gitignored, per-project
  issues.db                     # local issue tracking for this repo

<any-repo>/config/              # committed to git, team-shared
  scoring.json                  # project-specific scoring weights
  effort-map.json               # project-specific effort estimates
```

- **Credentials are global:** Enter API keys once during first `autofix-hub setup`. Stored in `~/.autofix-hub/credentials.json`.
- **Issues DB is per-project:** Each repo has its own `.autofix-hub/issues.db`. Issues don't mix across repos.
- **Config is per-project and team-shared:** `config/` directory is committed to git. Team members share scoring weights and (in Phase 2) rejection patterns.
- **First run in a new repo:** `autofix-hub setup` detects no local DB → creates `.autofix-hub/` directory, scaffolds `config/` files if missing, verifies scanner connectivity.

### Plugin interface

Every scanner plugin exports a standard interface:

```js
module.exports = {
  name: 'apiiro',                       // registered subcommand name
  displayName: 'Apiiro Security',       // for dashboard/reports

  // Setup & connectivity
  checkInstalled: async () => {},       // returns {installed: bool, message: string}
  checkAuth: async () => {},            // returns {authenticated: bool, message: string}
  setupPrompts: () => [],               // interactive setup questions

  // Fetch & normalize
  fetch: async (config) => {},          // returns normalized issue objects
  normalize: (rawIssue) => {},          // raw scanner format → common schema

  // Intelligence
  clusterKeys: (issue) => [],           // returns array of cluster key strings
  effortEstimate: (issue) => {},        // returns {level, minutes}
  reviewLevel: (issue) => '',           // returns 'quick' | 'careful' | 'security_review'

  // Prompts
  promptTemplate: (issue) => '',        // returns fix prompt for single issue
  batchPromptTemplate: (issues) => '',  // returns fix prompt for clustered issues

  // Scoring factors (plugin-specific, fed into core scoring engine)
  scoringFactors: (issue) => {},        // returns {severity_weight, blast_radius, path_criticality, ...}
}
```

## Tech Stack

- **Runtime:** Node.js (>=18)
- **Package manager:** pnpm (workspaces)
- **Database:** SQLite (better-sqlite3, WAL mode)
- **CLI framework:** Commander.js
- **Dashboard:** Express + React via CDN
- **Git:** Shelling out to git + gh CLI
- **Scheduling:** node-cron
- **HTTP:** node-fetch or built-in fetch (Node 18+)

## DB Schema

### `issues` table
```sql
id TEXT PRIMARY KEY,           -- prefixed: apiiro-123, aqa-456, sonarqube-789
source TEXT NOT NULL,          -- plugin name: apiiro, aqa, sonarqube
rule_id TEXT,
severity TEXT,                 -- critical, high, medium, low, info
category TEXT,                 -- plugin-defined: secret, sca, sast, contrast, alt-text, bug, vulnerability...
status TEXT DEFAULT 'open',    -- open, in_progress, ai_fixed, verified, merged, closed, rejected
review_level TEXT,             -- quick, careful, security_review
file_path TEXT,
line_number INTEGER,
description TEXT,
fix_prompt TEXT,
fix_branch TEXT,
fix_pr_url TEXT,
reviewed_by TEXT,
rejected_reason TEXT,
created_at TEXT,
updated_at TEXT,
resolved_at TEXT,
impact_score REAL,
estimated_effort TEXT,         -- trivial, small, medium, large
estimated_minutes INTEGER,
cluster_id TEXT,               -- FK to clusters.id, nullable
dedup_group TEXT,              -- nullable
is_duplicate INTEGER DEFAULT 0,
prompt_version TEXT,
scanner_data TEXT              -- JSON blob for scanner-specific fields (wcag_level, selector, etc.)
```

### `issue_metadata` table
```sql
issue_id TEXT NOT NULL,        -- FK to issues.id
key TEXT NOT NULL,             -- e.g., wcag_level, wcag_rule, selector, error_count, cloud_resource
value TEXT,
PRIMARY KEY (issue_id, key)
```

### `fix_attempts` table
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
issue_id TEXT NOT NULL,        -- FK to issues.id
attempt_number INTEGER,
status TEXT,                   -- success, failed
diff_content TEXT,             -- git diff of the fix attempt (Phase 2: used for rejection analysis)
error_log TEXT,
attempted_by TEXT,
attempted_at TEXT,
prompt_version TEXT
```

### `scan_history` table
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source TEXT,
ran_at TEXT,
issues_found INTEGER,
new_issues INTEGER,
reopened INTEGER
```

### `clusters` table
```sql
id TEXT PRIMARY KEY,
source TEXT,
cluster_key TEXT,
root_cause TEXT,
issue_count INTEGER,
status TEXT,
fix_branch TEXT,
created_at TEXT
```

### `rejection_patterns` table
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
source TEXT,
rule_id TEXT,
pattern_tag TEXT,              -- wrong_scope, broke_tests, style_mismatch, incomplete_fix, wrong_approach, other
description TEXT,
occurrences INTEGER DEFAULT 0,
last_seen_at TEXT,
negative_prompt_clause TEXT
```

### `auto_approve_log` table
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
issue_id TEXT,
decision TEXT,                 -- approved, blocked
reason TEXT,
diff_stats TEXT,
decided_at TEXT
```

### `locks` table
```sql
file_path TEXT PRIMARY KEY,
locked_by TEXT,                -- issue_id
locked_at TEXT,
expires_at TEXT
```

## Status Flow

```
open → in_progress → ai_fixed → verified → merged → closed
                          ↓
                      rejected (bad AI fix, needs manual)

On next fetch: if a "merged" issue still appears in scan → reopen it
```

## Review Levels

- **quick:** Low risk (decorative alt text, missing lang attr, tabindex, simple dep bumps, info-level code smells)
- **careful:** Medium risk (content alt text, contrast, form labels, medium severity vulnerabilities)
- **security_review:** High risk (secrets, injection, IAM, blocker/critical vulnerabilities). NEVER auto-approved.

## Scanners Reference

### Apiiro
- **CLI:** `apiiro risks --repo <org/repo> --output json`
- **Auth:** `apiiro login` (interactive)
- **Detection:** `apiiro --version`
- **Categories:** Secrets, SCA (vulnerable dependencies), SAST (code vulnerabilities), Misconfigurations, PII, Supply Chain
- **Priority:** Secrets always highest (need rotation)
- **Reference:** https://github.com/1291pravin/skills/tree/main/apiiro-fix

### AQA (UsableNet)
- **API:** `https://api-aqa.usablenet.com/v3.1/{teamSlug}`
- **Auth:** `X-Team: {API_KEY}` header
- **Detection:** Test API call to list suites
- **Issue flow:** List suites → get tests → trigger/get run → get flow/page issues
- **Issue fields:** ruleId, ruleTitle, impact (critical/serious/moderate/minor), selectors, html, solutions, wcagCriteria
- **Reference:** https://github.com/1291pravin/skills/tree/main/aqa-usablenet

### SonarQube
- **CLI:** `sonar-scanner` (Homebrew or manual install)
- **API:** `{SONARQUBE_URL}/api/issues/search?componentKeys={projectKey}&statuses=OPEN`
- **Auth:** Bearer token via `SONARQUBE_TOKEN`
- **Detection:** `sonar-scanner --version` + API `/api/system/status`
- **Categories:** Bugs, Vulnerabilities, Security Hotspots, Code Smells
- **Severity:** BLOCKER, CRITICAL, MAJOR, MINOR, INFO
- **Reference:** https://github.com/1291pravin/skills/tree/main/sonarqube-fix

## Phases

- **Phase 1:** Core CLI + plugins + clustering + dashboard + setup wizard + git/PR workflow + IDE skills
- **Phase 2:** Rejection learning loop, AI diff analysis, git-shared config, git-based scoring, auto-improvement

See `PHASE1_SPEC.md` and `PHASE2_SPEC.md` for detailed specifications.
See `PHASE1_PLAN.md` and `PHASE2_PLAN.md` for implementation plans.
