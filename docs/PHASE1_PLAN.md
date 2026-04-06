# Phase 1 Implementation Plan

Step-by-step build order for Claude Code to execute. Each step lists exact files to create/modify, what they should contain, and dependencies.

**Reference repos for scanner details:**
- Apiiro: https://github.com/1291pravin/skills/tree/main/apiiro-fix
- AQA: https://github.com/1291pravin/skills/tree/main/aqa-usablenet (includes full API reference in references/api-reference.md)
- SonarQube: https://github.com/1291pravin/skills/tree/main/sonarqube-fix

## Step 1: Project Skeleton

**Create these files:**

### `package.json` (root)
```json
{
  "name": "autofix-hub",
  "private": true,
  "scripts": {
    "dev": "pnpm --filter @autofix-hub/core run dev",
    "test": "pnpm -r run test"
  }
}
```

### `pnpm-workspace.yaml`
```yaml
packages:
  - 'packages/*'
```

### `packages/core/package.json`
```json
{
  "name": "@autofix-hub/core",
  "version": "0.1.0",
  "bin": {
    "autofix-hub": "./bin/autofix-hub.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "express": "^4.18.0",
    "node-cron": "^3.0.0",
    "dotenv": "^16.0.0",
    "chalk": "^4.1.2",
    "inquirer": "^8.0.0",
    "cli-table3": "^0.6.0"
  }
}
```
Note: Use chalk v4 and inquirer v8 (CommonJS compatible). All code is CommonJS (`require`/`module.exports`).

### `packages/plugin-apiiro/package.json`
```json
{
  "name": "@autofix-hub/plugin-apiiro",
  "version": "0.1.0",
  "main": "src/index.js",
  "dependencies": {
    "@autofix-hub/core": "workspace:*"
  }
}
```

### `packages/plugin-aqa/package.json`
Same pattern, name: `@autofix-hub/plugin-aqa`

### `packages/plugin-sonarqube/package.json`
Same pattern, name: `@autofix-hub/plugin-sonarqube`

### `.env.example`
```env
# Project-specific settings
AQA_SUITE_ID=
AQA_TEST_ID=
SONARQUBE_PROJECT_KEY=

# Feature flags
AUTO_APPROVE_ENABLED=true
AUTO_APPROVE_MAX_LINES=10

# Scheduling (cron expressions)
FETCH_CRON_APIIRO=0 8 * * 1-5
FETCH_CRON_AQA=0 9 * * 1-5
FETCH_CRON_SONARQUBE=0 10 * * 1-5

# Notifications
NOTIFICATION_WEBHOOK_URL=

# CI
CI_WAIT=true

# Dashboard
DASHBOARD_PORT=8000
```

### `.gitignore`
```
node_modules/
.autofix-hub/
.env
*.db
```

**Run:** `pnpm install` from root.

**Depends on:** Nothing.

---

## Step 2: Database Layer

**Create these files:**

### `packages/core/src/db.js`

SQLite layer using better-sqlite3:

- `getDb()` — returns singleton DB connection for current project
  - DB path: `<project-root>/.autofix-hub/issues.db`
  - Detects project root by walking up from cwd looking for `.git/` or `package.json`
  - Creates `.autofix-hub/` directory if missing
  - Enables WAL mode: `PRAGMA journal_mode=WAL`
  - Enables foreign keys: `PRAGMA foreign_keys=ON`
- `closeDb()` — close connection (for clean shutdown)

### `packages/core/src/setup.js`

Idempotent schema creation:

- Creates all tables from the schema in PROJECT.md (issues, issue_metadata, fix_attempts, scan_history, clusters, rejection_patterns, auto_approve_log, locks)
- Uses `CREATE TABLE IF NOT EXISTS` for idempotency
- Creates indexes:
  - `issues`: on `(source, status)`, `(impact_score)`, `(cluster_id)`, `(dedup_group)`
  - `fix_attempts`: on `(issue_id)`
  - `rejection_patterns`: on `(source, rule_id, pattern_tag)` UNIQUE
  - `locks`: on `(expires_at)`

**Depends on:** Step 1 (package.json for better-sqlite3).

---

## Step 3: Config & Credentials

**Create these files:**

### `config/scoring.json`
Full scoring config as specified in PHASE1_SPEC.md. Include severity_weights, path_criticality, page_importance, type_weights.

### `config/effort-map.json`
```json
{
  "apiiro": {
    "secret": { "level": "small", "minutes": 5 },
    "sca_minor": { "level": "small", "minutes": 5 },
    "sca_major": { "level": "large", "minutes": 30 },
    "sast_injection": { "level": "medium", "minutes": 15 },
    "sast_xss": { "level": "medium", "minutes": 15 },
    "misconfiguration": { "level": "medium", "minutes": 15 },
    "pii": { "level": "medium", "minutes": 15 },
    "__default__": { "level": "medium", "minutes": 15 }
  },
  "aqa": {
    "color-contrast": { "level": "medium", "minutes": 15 },
    "image-alt": { "level": "small", "minutes": 5 },
    "label": { "level": "small", "minutes": 5 },
    "heading-order": { "level": "medium", "minutes": 15 },
    "html-has-lang": { "level": "trivial", "minutes": 2 },
    "tabindex": { "level": "trivial", "minutes": 2 },
    "__default__": { "level": "small", "minutes": 5 }
  },
  "sonarqube": {
    "bug_BLOCKER": { "level": "large", "minutes": 30 },
    "bug_CRITICAL": { "level": "large", "minutes": 30 },
    "vulnerability_CRITICAL": { "level": "large", "minutes": 30 },
    "code_smell_INFO": { "level": "trivial", "minutes": 2 },
    "code_smell_MINOR": { "level": "small", "minutes": 5 },
    "__default__": { "level": "medium", "minutes": 15 }
  }
}
```

### `packages/core/src/config.js`

Config loader:
- `loadCredentials()` — reads `~/.autofix-hub/credentials.json`, returns parsed object
- `saveCredentials(data)` — writes to `~/.autofix-hub/credentials.json`
- `loadProjectEnv()` — reads `.env` from project root via dotenv
- `loadScoringConfig()` — reads `config/scoring.json`
- `loadEffortMap()` — reads `config/effort-map.json`
- `getProjectRoot()` — walks up from cwd looking for `.git/` or `package.json`

**Depends on:** Step 1.

---

## Step 4: Plugin Loader

**Create this file:**

### `packages/core/src/pluginLoader.js`

Plugin discovery and loading:

- `loadPlugins()` — scans for `@autofix-hub/plugin-*` packages
  - In monorepo: reads `pnpm-workspace.yaml`, requires each plugin package
  - Each plugin must export the standard interface (name, fetch, normalize, etc.)
  - Returns `Map<string, Plugin>` keyed by plugin.name
- `getPlugin(name)` — returns specific plugin or throws helpful error
- `listPlugins()` — returns array of `{name, displayName, installed: bool}`

Validation: on load, check that plugin exports all required methods. Warn (don't crash) if optional methods are missing.

**Depends on:** Step 1 (workspace setup).

---

## Step 5: CLI Entry Point + Setup Command

**Create these files:**

### `packages/core/bin/autofix-hub.js`

```js
#!/usr/bin/env node
```

Commander.js CLI setup:
- Load dotenv from project root
- Register shared commands: `setup`, `dashboard`, `report`, `schedule-status`, `status <id> <status>`
- Load plugins via pluginLoader
- For each loaded plugin, register `program.command(plugin.name)` as a sub-group with commands: `fetch`, `fix-next`, `fix <id>`, `fix-cluster <cid>`, `approve <id>`, `reject <id> <tag> <reason>`, `rollback <id>`, `report`
- If user runs `autofix-hub <unknown-source> ...` → check if it matches an uninstalled plugin name → helpful error

### `packages/core/src/commands/setup.js`

Interactive setup wizard using inquirer:

1. Check if `~/.autofix-hub/credentials.json` exists
2. If not: create directory, run scanner setup prompts
3. For each installed plugin:
   - Call `plugin.checkInstalled()` → show green/red
   - If installed, call `plugin.checkAuth()` → show green/red
   - If not auth'd, run `plugin.setupPrompts()` → collect answers → store in credentials.json
   - Offer to skip unconfigured scanners
4. Create `.autofix-hub/` directory in project root if missing
5. Create `.autofix-hub/issues.db` via setup.js schema
6. Scaffold `config/scoring.json` and `config/effort-map.json` if missing (copy defaults)
7. Add `.autofix-hub/` to `.gitignore` if not already there
8. Print summary: N of M scanners configured

**Depends on:** Steps 2, 3, 4.

---

## Step 6: Plugin — Apiiro

**Create this file:**

### `packages/plugin-apiiro/src/index.js`

Full plugin interface implementation:

```js
module.exports = {
  name: 'apiiro',
  displayName: 'Apiiro Security',

  checkInstalled: async () => {
    // try execSync('apiiro --version')
    // return {installed: bool, message: version or 'not found'}
  },

  checkAuth: async () => {
    // try execSync('apiiro risks --repo test --output json --limit 0')
    // if auth error → {authenticated: false, message: 'run apiiro login'}
  },

  setupPrompts: () => [
    // inquirer questions for CLI path override (default: 'apiiro')
  ],

  fetch: async (config) => {
    // Get repo name from git remote get-url origin
    // execSync(`${cliPath} risks --repo ${repoName} --output json`)
    // Parse and return raw issues array
  },

  normalize: (raw) => {
    // Map to common schema:
    // id: apiiro-{raw.id}
    // source: 'apiiro'
    // rule_id, severity (normalized), category, file_path, line_number, description
    // scanner_data: JSON.stringify(raw)
  },

  clusterKeys: (issue) => {
    // Secrets: by secret hash (first/last 4 chars)
    // SCA: by dependency name
    // SAST: by rule_id + directory
    // Default: rule_id + directory
  },

  effortEstimate: (issue) => {
    // Look up in effort-map.json by category
    // Return {level, minutes}
  },

  reviewLevel: (issue) => {
    // All apiiro issues are 'security_review' or 'careful'
    // Secrets, injection, IAM → security_review
    // SCA minor bumps → careful
  },

  scoringFactors: (issue) => {
    // severity_weight from scoring.json
    // blast_radius: count files importing this file (grep for imports)
    // path_criticality: match file_path against config patterns
    // is_secret: category === 'secret'
  },

  promptTemplate: (issue) => {
    // Category-specific templates:
    // secret → replace with env var, add .env.example, note rotation
    // sca → bump version, check changelog
    // sast → parameterized queries, sanitization
    // misconfiguration → fix insecure defaults
    // Always append: "fix only this issue, don't touch unrelated code"
  },

  batchPromptTemplate: (issues) => {
    // List all locations, single instruction set
    // "Fix all N instances of [rule] across these files: ..."
  },
}
```

**Depends on:** Step 4 (plugin interface).

---

## Step 7: Plugin — AQA

**Create this file:**

### `packages/plugin-aqa/src/index.js`

Full plugin interface implementation.

Key AQA-specific details:
- **fetch:** Use the AQA REST API (see api-reference.md in the skill repo)
  - Get latest run for configured test: `GET /a11y/tests/{testId}`
  - Get flow issues: `GET /a11y/tests/runs/{runId}/flows/{flowId}/issues`
  - Get page issues: `GET /a11y/tests/runs/{runId}/pages/{pageId}/issues`
  - Auth: `X-Team: {apiKey}` header
- **normalize:** Map AQA issue format to common schema
  - id: `aqa-{hash(ruleId + selector + flowId/pageId)}`
  - severity: map impact levels (critical→critical, serious→high, moderate→medium, minor→low)
  - category: categorize by ruleId (color-contrast, image-alt, label, heading-order, keyboard, focus, etc.)
  - Store wcag_criteria, selector, html, solutions in issue_metadata
- **clusterKeys:** Group by `(ruleId, flowId/pageId)` and `(ruleId, normalizedSelector)`
- **effortEstimate:** Look up by ruleId in effort-map
- **reviewLevel:** 
  - quick: html-has-lang, decorative alt, tabindex
  - careful: content alt text, contrast, labels, headings
  - security_review: never (AQA is accessibility, not security)
- **promptTemplate:** 
  - Missing alt → infer from context, write descriptive text
  - Contrast → adjust to WCAG AA ratios, use existing palette
  - Missing labels → associate or add aria-label
  - Heading order → restructure levels
  - Always: "preserve visual appearance, follow existing component patterns"
- **setupPrompts:** Ask for team_slug, api_key, then test connection by listing suites, let user pick suite and test

**Depends on:** Step 4.

---

## Step 8: Plugin — SonarQube

**Create this file:**

### `packages/plugin-sonarqube/src/index.js`

Full plugin interface implementation.

Key SonarQube-specific details:
- **checkInstalled:** Try `sonar-scanner --version`. Also test API connectivity.
- **checkAuth:** Test `GET {serverUrl}/api/system/status` with Bearer token
- **fetch:** Paginated `GET /api/issues/search?componentKeys={projectKey}&statuses=OPEN&ps=500`
- **normalize:**
  - id: `sonarqube-{raw.key}`
  - severity: BLOCKER→critical, CRITICAL→high, MAJOR→medium, MINOR→low, INFO→info
  - category: BUG→bug, VULNERABILITY→vulnerability, SECURITY_HOTSPOT→security_hotspot, CODE_SMELL→code_smell
  - file_path: extract from component key (split on `:`, take last segment)
  - Store rule details, tags, effort in issue_metadata
- **clusterKeys:** `(rule + directory)` and `(rule + category)`
- **effortEstimate:** Combine SonarQube's own effort estimate with effort-map config
- **reviewLevel:**
  - quick: INFO code smells
  - careful: MINOR/MAJOR code smells, MINOR bugs
  - security_review: vulnerabilities, security hotspots, BLOCKER/CRITICAL bugs
- **promptTemplate:**
  - Bugs → fix logic error, add null checks
  - Vulnerabilities → OWASP remediation
  - Security hotspots → secure pattern
  - Code smells → refactor per suggestion
  - Always: "minimal change, follow existing code style"
- **setupPrompts:** Ask for server_url, token, project_key. Test connection.

**Depends on:** Step 4.

---

## Step 9: Scoring Engine

**Create this file:**

### `packages/core/src/scoring.js`

- `scoreIssue(issue, plugin, scoringConfig)`:
  1. Get `severity_weight` from `scoringConfig.severity_weights[issue.severity]`
  2. Get source-specific factors from `plugin.scoringFactors(issue)`
  3. Compute: `impact_score = severity_weight * source_factor`
  4. Return `impact_score`
- `computePriority(issue)`:
  - `priority = impact_score / estimated_minutes`
  - Used by fix-next for ordering

**Depends on:** Steps 3, 6-8 (config + plugins provide scoring factors).

---

## Step 10: Clustering Engine

**Create this file:**

### `packages/core/src/clustering.js`

- `clusterIssues(issues, plugin, db)`:
  1. For each issue, call `plugin.clusterKeys(issue)` → get array of keys
  2. For each key, compute `cluster_id = hash(source + key)`
  3. Group issues by cluster_id
  4. For clusters with 2+ issues:
     - Upsert `clusters` row: id, source, cluster_key, issue_count, status='open'
     - Update each issue's `cluster_id` in DB
  5. For single-issue "clusters": leave cluster_id as null (treated as individual issues)
  6. Deterministic hashing ensures re-runs don't create duplicate clusters

**Depends on:** Steps 2, 6-8 (DB + plugins).

---

## Step 11: Dedup Engine

**Create this file:**

### `packages/core/src/dedup.js`

- `dedupIssues(issues, plugin, db)`:
  1. **ID-based dedup:** Skip issues whose `id` already exists in DB
  2. **Content-based dedup:** Hash `(rule_id, normalized_description, file_directory)` → check for existing issues with same hash
  3. If duplicate found:
     - Set `dedup_group` on both issues (primary = highest severity)
     - Mark lower severity as `is_duplicate=true`
  4. Return only non-duplicate new issues for insertion

**Depends on:** Steps 2, 6-8.

---

## Step 12: Git Operations

**Create this file:**

### `packages/core/src/git.js`

All functions shell out to `git` and `gh` CLI:

- `getRepoName()` — parse `git remote get-url origin` → `org/repo`
- `getCurrentBranch()` — `git branch --show-current`
- `createFixBranch(issueId)` — `git checkout -b autofix/{issueId}`
- `createClusterBranch(clusterId)` — `git checkout -b autofix/cluster-{clusterId}`
- `commitFix(issueId, message)` — `git add -A && git commit -m "{message}"`
  - Conventional commit format: `fix(security): rotate secret [apiiro-123]`
- `pushAndCreatePR(issueId, title, body)`:
  - `git push -u origin {branch}`
  - `gh pr create --title "{title}" --body "{body}"`
  - Return PR URL
- `checkCIStatus(prUrl)`:
  - Poll `gh pr checks {prUrl}` until all complete or timeout
  - Return {passed: bool, details: string}
- `rollbackFix(issueId)`:
  - `git checkout main -- {affected_files}`
  - `git checkout main`
  - `git branch -D autofix/{issueId}`
- `getDiffStat(branch)` — `git diff --stat main...{branch}`
- `getDiffContent(branch)` — `git diff main...{branch}` (for storing in fix_attempts)

**Depends on:** Step 1.

---

## Step 13: File Locks

**Create this file:**

### `packages/core/src/locks.js`

- `acquireLock(filePath, issueId, expiryMinutes=30)`:
  - Check if file already locked (and not expired)
  - If locked by different issue → return false
  - If expired → delete old lock
  - Insert new lock → return true
- `releaseLock(filePath)` — delete lock row
- `releaseLocksForIssue(issueId)` — delete all locks where `locked_by = issueId`
- `isLocked(filePath)` — check if locked (and not expired)
- `cleanExpiredLocks()` — delete all expired locks

**Depends on:** Step 2 (DB).

---

## Step 14: CLI Commands — Fetch

**Create this file:**

### `packages/core/src/commands/fetch.js`

`fetchCommand(source)`:
1. Load plugin for source
2. Load credentials + project config
3. Call `plugin.fetch(config)` → raw issues
4. For each raw issue: `plugin.normalize(raw)` → normalized
5. `dedupIssues(normalized, plugin, db)` → new issues only
6. For each new issue:
   - `scoreIssue(issue, plugin, scoringConfig)` → set impact_score
   - `plugin.effortEstimate(issue)` → set estimated_effort, estimated_minutes
   - `plugin.reviewLevel(issue)` → set review_level
   - `plugin.promptTemplate(issue)` → set fix_prompt
7. Insert new issues into DB
8. Store scanner-specific fields in `issue_metadata`
9. `clusterIssues(newIssues, plugin, db)` → update clusters
10. Reopen check: query merged issues, check if they appear in fresh scan results
11. Insert `scan_history` row
12. Call notify if configured
13. Print summary: "Found X issues, Y new, Z reopened"

**Depends on:** Steps 2-11 (everything up to this point).

---

## Step 15: CLI Commands — Fix

**Create this file:**

### `packages/core/src/commands/fix.js`

Three commands:

`fixNextCommand(source)`:
1. Query DB: top open issue/cluster by `impact_score / estimated_minutes DESC`
   - Prefer clusters (batch value)
   - Skip issues with locked files
   - Skip `is_duplicate=true` issues
2. Atomic status transition: `UPDATE issues SET status='in_progress' WHERE id=? AND status='open'`
3. Create git branch: `autofix/{id}` or `autofix/cluster-{cid}`
4. Acquire file locks
5. If cluster: generate batch prompt via `plugin.batchPromptTemplate(clusterIssues)`
6. Output JSON to stdout:
   ```json
   {
     "issueId": "apiiro-123",
     "branch": "autofix/apiiro-123",
     "files": ["src/config/db.js"],
     "fixPrompt": "...",
     "clusterInfo": null,
     "reviewLevel": "security_review",
     "estimatedEffort": "small"
   }
   ```

`fixCommand(source, id)`:
- Same as fix-next but for a specific issue ID

`fixClusterCommand(source, clusterId)`:
- Same as fix-next but for a specific cluster

**Depends on:** Steps 2, 12, 13 (DB, git, locks).

---

## Step 16: CLI Commands — Status, Approve, Reject, Rollback

**Create these files:**

### `packages/core/src/commands/status.js`

`statusCommand(id, newStatus)`:
- Validate status transition (open→in_progress→ai_fixed→verified→merged→closed, or →rejected)
- Update issue in DB
- Set `updated_at`, and `resolved_at` if terminal status
- If `ai_fixed`: trigger auto-approve check

### `packages/core/src/commands/approve.js`

`approveCommand(source, id)`:
1. Verify issue status is `ai_fixed` or `verified`
2. Push branch: `git.pushAndCreatePR(id, title, body)`
   - Auto-generate PR title from issue description
   - Auto-generate PR body with issue details, fix prompt, cluster info
3. If `CI_WAIT=true`: poll CI status via `git.checkCIStatus(prUrl)`
   - If CI fails: auto-reject with CI failure logs
4. Set status → `verified`, store `reviewed_by`
5. Log `fix_attempt` as success with `diff_content` from `git.getDiffContent()`
6. Release file locks
7. Check if fix resolves duplicate issues → auto-close duplicates

### `packages/core/src/commands/reject.js`

`rejectCommand(source, id, tag, reason)`:
1. Validate tag is one of: wrong_scope, broke_tests, style_mismatch, incomplete_fix, wrong_approach, other
2. Store `rejected_reason` and tag on issue
3. Upsert `rejection_patterns` row: increment occurrences, update last_seen_at
4. Set status → rejected
5. Log `fix_attempt` as failed with `diff_content`
6. Delete fix branch: `git.rollbackFix(id)`
7. Release file locks

### `packages/core/src/commands/rollback.js`

`rollbackCommand(source, id)`:
1. Checkout main versions of affected files
2. Delete fix branch
3. Set status → open
4. Release file locks

**Depends on:** Steps 2, 12, 13 (DB, git, locks).

---

## Step 17: Auto-Approve

**Create this file:**

### `packages/core/src/autoApprove.js`

`checkAutoApprove(issue, db)`:
1. If `AUTO_APPROVE_ENABLED !== 'true'` → skip
2. If `issue.review_level !== 'quick'` → skip
3. If `issue.source === 'apiiro'` → NEVER auto-approve, skip
4. Get diff stats: `git.getDiffStat(issue.fix_branch)`
5. Parse: count files changed, total lines
6. If total lines > `AUTO_APPROVE_MAX_LINES` → block
7. If unexpected files touched → block
8. If all checks pass:
   - Set status → `verified`
   - Set `reviewed_by: 'auto-approve'`
   - Log in `auto_approve_log`: decision=approved, reason, diff_stats
9. If blocked:
   - Log in `auto_approve_log`: decision=blocked, reason, diff_stats
   - Leave status as `ai_fixed` for manual review

Called automatically when status transitions to `ai_fixed` (from status.js).

**Depends on:** Steps 2, 12 (DB, git).

---

## Step 18: Report Command

**Create this file:**

### `packages/core/src/commands/report.js`

`reportCommand(source=null)`:
- If source specified: show source-specific report
- If no source: show cross-source summary

Terminal output using chalk + cli-table3:

```
╔═══════════════════════════════════════════════╗
║         autofix-hub Report                    ║
╠═══════════════════════════════════════════════╣
║ Source     │ Open │ In Progress │ Fixed │ ...  ║
║ Apiiro     │  12  │     2       │   8   │      ║
║ AQA        │  45  │     3       │  22   │      ║
║ SonarQube  │  78  │     1       │  15   │      ║
╠═══════════════════════════════════════════════╣
║ Top 5 Issues by Priority                      ║
║ 1. apiiro-123 [CRITICAL] Secret in db.js      ║
║ 2. ...                                        ║
╚═══════════════════════════════════════════════╝
```

**Depends on:** Step 2 (DB).

---

## Step 19: Metrics

**Create this file:**

### `packages/core/src/metrics.js`

- `getMTTF(filters)` — `AVG(resolved_at - created_at)` by source, severity, rule_id
- `getAcceptanceRate(filters)` — `COUNT(verified) / COUNT(ai_fixed)` by rule_id
- `getVelocity(period)` — issues fixed per day/week, with trend direction
- `getQueueHealth()` — open count, estimated time to clear, aging issues >7 days
- `getRejectionsByCategory()` — which categories have highest rejection rates
- `getStats(source)` — summary numbers for dashboard cards

All functions query the DB directly using SQL aggregations.

**Depends on:** Step 2 (DB).

---

## Step 20: Scheduler & Notifications

**Create these files:**

### `packages/core/src/scheduler.js`

- `startScheduler(plugins)`:
  - For each configured plugin with a cron expression in .env:
    - Register `node-cron` job that calls `fetchCommand(plugin.name)`
  - Log next scheduled run times
- `getScheduleStatus()` — return array of `{source, cronExpr, nextRun}`

### `packages/core/src/notify.js`

- `sendNotification(payload)`:
  - If `NOTIFICATION_WEBHOOK_URL` not set → skip
  - POST JSON to webhook URL
  - Payload: `{source, new_issues, total_open, critical_count, timestamp}`
  - Support Slack/Teams/Discord webhook formats (auto-detect from URL)

**Depends on:** Steps 3, 14 (config, fetch).

---

## Step 21: Dashboard — API Server

**Create this file:**

### `packages/core/src/dashboard/server.js`

Express server:

- Static file serving for `index.html`
- Start scheduler on server start
- API routes (all return JSON):

```
GET  /api/issues?source=&status=&severity=&cluster=&page=&limit=
GET  /api/issues/:id
GET  /api/issues/next?source=
POST /api/issues/:id/status    body: {status, reviewed_by, rejected_reason, rejection_tag}
GET  /api/stats?source=
GET  /api/clusters?source=
GET  /api/metrics/mttf?source=&severity=
GET  /api/metrics/acceptance?source=
GET  /api/metrics/velocity?period=day|week
GET  /api/scanners
POST /api/scanners/:source/test
POST /api/scanners/:source/config
GET  /api/schedule-status
```

Dashboard command in CLI: `autofix-hub dashboard` → starts Express on configured port, opens browser.

**Depends on:** Steps 2, 4, 19, 20 (DB, plugins, metrics, scheduler).

---

## Step 22: Dashboard — Frontend

**Create this file:**

### `packages/core/src/dashboard/index.html`

Single-page React app via CDN (React 18 + ReactDOM + Babel standalone for JSX):

**Layout:**
- Header: "autofix-hub" title, Last Scan indicators per source, "Fetch All" + "Fix Next" buttons
- Tab bar: All | {dynamic per installed plugin} | Metrics | Settings
- Main content area

**Summary cards section:**
- Open Issues (total + per source)
- AI Fixed (awaiting review)
- Verified (ready to merge)
- Acceptance Rate %
- Auto-Approved count

**Issues table:**
- Columns: ID, Source, Severity, Impact, Effort, Description, Status, Review Level, Cluster, Actions
- All columns sortable
- Severity badges: color-coded (critical=red, high=orange, medium=yellow, low=blue, info=gray)
- Status badges: color-coded
- Effort badges: trivial=green, small=blue, medium=yellow, large=red
- Cluster indicator: icon + cluster ID if part of cluster
- Actions column: View Diff, Approve, Reject (dropdown with tag selector), Copy Prompt, Rollback
- Pagination

**Metrics tab:**
- MTTF by source (bar chart, simple canvas-based or table)
- Acceptance rate by category (bar chart)
- Velocity trend (line chart or table)
- Queue health (cards: total open, est. time to clear, aging count)
- Issues found vs fixed over time

**Settings tab:**
- Scanner status cards (green/red per scanner)
- Config forms (non-sensitive — suite selection, project key, cron expressions)
- Test connection buttons
- Auto-approve toggle

**Design:** Clean, modern, dark/light theme. CSS custom properties for theming. No CSS framework — hand-written minimal CSS. Monospace font for data.

**Depends on:** Step 21 (API server).

---

## Step 23: IDE Skills

**Create these files:**

### `.agents/skills/apiiro-fixer/SKILL.md`

Thin wrapper that instructs Cascade:
- `/apiiro-fetch` → run `autofix-hub apiiro fetch`, show results
- `/apiiro-fix-next` → run `autofix-hub apiiro fix-next`, parse JSON, open files, apply fix using prompt, run `autofix-hub status <id> ai_fixed`
- `/apiiro-approve <id>` → run `autofix-hub apiiro approve <id>`
- `/apiiro-reject <id> <tag> <reason>` → run `autofix-hub apiiro reject ...`
- `/apiiro-report` → run `autofix-hub apiiro report`

### `.agents/skills/aqa-fixer/SKILL.md`
Same pattern for AQA.

### `.agents/skills/sonarqube-fixer/SKILL.md`
Same pattern for SonarQube.

### `.agents/skills/autofix-shared/SKILL.md`
- `/autofix-setup` → `autofix-hub setup`
- `/autofix-dashboard` → `autofix-hub dashboard`
- `/autofix-report` → `autofix-hub report`

**Depends on:** All previous steps (CLI must be functional).

---

## Build & Test Checklist

After all steps are complete:

1. `pnpm install` from root — all packages resolve
2. `node packages/core/bin/autofix-hub.js setup` — wizard runs, creates DB
3. `node packages/core/bin/autofix-hub.js apiiro fetch` — fetches issues (requires Apiiro CLI)
4. `node packages/core/bin/autofix-hub.js aqa fetch` — fetches issues (requires AQA API key)
5. `node packages/core/bin/autofix-hub.js sonarqube fetch` — fetches issues (requires SonarQube)
6. `node packages/core/bin/autofix-hub.js apiiro fix-next` — outputs JSON
7. `node packages/core/bin/autofix-hub.js status <id> ai_fixed` — transitions status
8. `node packages/core/bin/autofix-hub.js apiiro approve <id>` — creates PR
9. `node packages/core/bin/autofix-hub.js apiiro reject <id> wrong_scope "touched unrelated files"` — logs rejection
10. `node packages/core/bin/autofix-hub.js report` — shows terminal report
11. `node packages/core/bin/autofix-hub.js dashboard` — opens dashboard on localhost:8000
12. Dashboard shows issues, metrics, scanner status
