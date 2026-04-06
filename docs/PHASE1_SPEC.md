# Phase 1 Specification

Everything needed to go from zero to a working CLI that fetches issues, clusters them, generates fix prompts, manages git branches/PRs, and shows a unified dashboard. No auto-improvement or rejection learning — that's Phase 2.

## Scope

### In Phase 1
- Project skeleton (pnpm monorepo, package.json files)
- Core DB layer (SQLite, WAL mode, full schema)
- Setup wizard (CLI interactive + dashboard settings page)
- Plugin loader + plugin interface
- All 3 plugins: Apiiro, AQA, SonarQube (fetch, normalize, prompts)
- Impact scoring engine
- Clustering engine (plugin-defined cluster keys)
- Dedup intelligence
- All CLI commands (fetch, fix-next, fix, approve, reject, rollback, report, status)
- Git operations (branch, commit, PR, CI check, rollback)
- File locking (concurrency control)
- Auto-approve for low-risk fixes
- Scheduled auto-fetch (node-cron)
- Webhook notifications
- Operational metrics
- Unified dashboard (Express + React)
- IDE skill files (Windsurf/Cascade)
- Multi-repo support (global credentials, per-project DB)

### NOT in Phase 1
- Rejection learning loop (pattern counting + negative prompt generation)
- AI diff analysis (comparing rejected vs accepted diffs)
- Git-shared rejection patterns config
- Git-based blast radius scoring
- Prompt versioning and A/B comparison
- Cost attribution per issue

## CLI Commands

### Shared commands (no source prefix)

```bash
autofix-hub setup                     # Interactive setup wizard
autofix-hub dashboard                 # Start dashboard server (localhost:8000)
autofix-hub report                    # Cross-source terminal summary
autofix-hub schedule-status           # Show scheduled fetch times
autofix-hub status <id> <status>      # Transition issue status
```

### Source-specific commands

```bash
autofix-hub <source> fetch            # Fetch + score + cluster + dedup
autofix-hub <source> fix-next         # Get next issue/cluster to fix (JSON)
autofix-hub <source> fix <id>         # Get specific issue to fix (JSON)
autofix-hub <source> fix-cluster <cid> # Get cluster to fix (JSON)
autofix-hub <source> approve <id>     # Push + PR + CI check
autofix-hub <source> reject <id> <tag> "<reason>"
autofix-hub <source> rollback <id>    # Undo fix, delete branch
autofix-hub <source> report           # Source-specific terminal summary
```

Where `<source>` is `apiiro`, `aqa`, or `sonarqube`.

## Setup Wizard

### First-time global setup (`~/.autofix-hub/` doesn't exist)

Interactive CLI wizard:

```
$ autofix-hub setup

Welcome to autofix-hub!

Checking installed scanners...

[1/3] Apiiro CLI
  Checking... ✗ Not found
  Install from: https://docs.apiiro.com/cli/install
  Skip for now? (y/n): y
  → Skipped. Run 'autofix-hub setup' again after installing.

[2/3] UsableNet AQA API
  Checking... ✗ No API key configured
  Enter your team slug: acme
  Enter your API key: ********
  Testing connection... ✓ Connected (3 suites found)
  Select suite for this project: 
    1. example.com (TS612)
    2. staging.example.com (TS620)
  → Selected: example.com (TS612)
  Select test: 
    1. aqa-scan-2025-03-26 (A3687-0)
  → Selected: A3687-0

[3/3] SonarQube
  Enter server URL: https://sonarqube.internal.com
  Enter auth token: ********
  Enter project key: my-project
  Testing connection... ✓ Connected (SonarQube 10.2)

Saving credentials to ~/.autofix-hub/credentials.json

Creating project database... ✓ .autofix-hub/issues.db
Scaffolding config files... ✓ config/scoring.json, config/effort-map.json

Setup complete! 2 of 3 scanners configured.
Run 'autofix-hub <source> fetch' to pull issues.
```

### Re-run in existing project

If `~/.autofix-hub/credentials.json` exists, skip global creds. Only do per-project setup (DB creation, config scaffolding, scanner connectivity check).

### Dashboard settings page

Dashboard shows a "Settings" tab:
- Green/red status per scanner (installed, authenticated, last fetch)
- Forms to update credentials
- Test connection buttons
- Project-specific config (suite/test selection for AQA, project key for SonarQube)

### Credentials storage

`~/.autofix-hub/credentials.json`:
```json
{
  "apiiro": {
    "cli_path": "apiiro",
    "configured": true
  },
  "aqa": {
    "api_url": "https://api-aqa.usablenet.com/v3.1",
    "team_slug": "acme",
    "api_key": "encrypted_or_plain_key"
  },
  "sonarqube": {
    "server_url": "https://sonarqube.internal.com",
    "token": "encrypted_or_plain_token"
  }
}
```

Per-project `.env` (gitignored) for project-specific overrides:
```env
# Project-specific settings
AQA_SUITE_ID=TS612
AQA_TEST_ID=A3687-0
SONARQUBE_PROJECT_KEY=my-project

# Overrides (optional, takes precedence over global credentials)
# AQA_API_KEY=project_specific_key

# Feature flags
AUTO_APPROVE_ENABLED=true
AUTO_APPROVE_MAX_LINES=10

# Scheduling
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

## Plugin Loader

`pluginLoader.js` discovers installed plugins:

1. Look for `@yourorg/plugin-*` packages in node_modules
2. Each plugin exports the standard interface (see PROJECT.md)
3. Register the plugin's `name` as a valid subcommand
4. If user runs `autofix-hub apiiro fetch` but plugin-apiiro isn't installed → helpful error: "Apiiro plugin not installed. Run `pnpm add @yourorg/plugin-apiiro`"

For monorepo development: plugins are linked via pnpm workspaces, so they're always available.

## Fetch Behavior

When `autofix-hub <source> fetch` runs:

1. **Load plugin** for the given source
2. **Call `plugin.fetch(config)`** — plugin handles API/CLI calls, returns raw issues
3. **Normalize** each issue via `plugin.normalize(rawIssue)` → common schema
4. **Dedup** — ID-based (skip existing) + content-based (hash of rule_id + normalized_description + file_directory)
5. **Score** each new issue:
   - Get plugin-specific factors via `plugin.scoringFactors(issue)`
   - Apply core scoring formula with weights from `config/scoring.json`
6. **Estimate effort** via `plugin.effortEstimate(issue)`
7. **Assign review level** via `plugin.reviewLevel(issue)`
8. **Cluster** — call `plugin.clusterKeys(issue)` for each new issue, group by matching keys
9. **Generate fix prompts** via `plugin.promptTemplate(issue)` for each new issue
10. **Reopen check** — for issues with status "merged", if they appear in fresh scan results → reopen
11. **Insert** new issues into DB
12. **Log** to `scan_history` table
13. **Notify** via webhook if configured

### Apiiro fetch specifics

```js
// plugin-apiiro/src/index.js
fetch: async (config) => {
  const repoName = await getRepoName();  // from git remote
  const output = execSync(`${config.cli_path} risks --repo ${repoName} --output json`);
  return JSON.parse(output);
},

normalize: (raw) => ({
  id: `apiiro-${raw.id}`,
  source: 'apiiro',
  rule_id: raw.ruleId || raw.type,
  severity: mapSeverity(raw.severity),  // normalize to critical/high/medium/low/info
  category: categorize(raw),            // secret, sca, sast, misconfiguration, pii, supply_chain
  file_path: raw.filePath,
  line_number: raw.lineNumber,
  description: raw.description,
  scanner_data: JSON.stringify(raw),    // preserve full original data
}),

clusterKeys: (issue) => {
  if (issue.category === 'secret') {
    const hash = hashSecretEnds(issue.scanner_data);
    return [`${issue.rule_id}:secret:${hash}`];
  }
  if (issue.category === 'sca') {
    const dep = extractDepName(issue.scanner_data);
    return [`${issue.rule_id}:dep:${dep}`];
  }
  return [`${issue.rule_id}:${path.dirname(issue.file_path)}`];
},
```

### AQA fetch specifics

```js
// plugin-aqa/src/index.js
fetch: async (config) => {
  // 1. Get latest run for configured test
  const test = await apiGet(`/a11y/tests/${config.test_id}`);
  const latestRun = test.runs?.sort((a, b) => b.epoch - a.epoch)[0];
  if (!latestRun || latestRun.status !== 'ready') {
    // Optionally trigger a new run
    throw new Error('No completed run found. Trigger a scan first.');
  }

  // 2. Get all flow issues
  const flows = await apiGet(`/a11y/tests/runs/${latestRun.id}/flows`);
  const allIssues = [];
  for (const flow of flows) {
    const issues = await apiGet(
      `/a11y/tests/runs/${latestRun.id}/flows/${flow.id}/issues`
    );
    allIssues.push(...issues.issuesData.issues.map(i => ({...i, flowId: flow.id, flowName: flow.name})));
  }

  // 3. Get all page issues (crawler results)
  const pages = await apiGet(`/a11y/tests/runs/${latestRun.id}/pages`);
  for (const page of pages) {
    const issues = await apiGet(
      `/a11y/tests/runs/${latestRun.id}/pages/${page.id}/issues`
    );
    allIssues.push(...issues.issuesData.issues.map(i => ({...i, pageId: page.id, pageUrl: page.url})));
  }

  return allIssues;
},

normalize: (raw) => ({
  id: `aqa-${hashIssue(raw)}`,  // hash of ruleId + selector + flow/page
  source: 'aqa',
  rule_id: raw.ruleId,
  severity: mapImpact(raw.impact),   // serious→high, moderate→medium, minor→low
  category: categorizeA11y(raw),     // contrast, alt-text, labels, heading, keyboard, focus, other
  file_path: null,                   // AQA issues are URL-based, not file-based
  line_number: null,
  description: `${raw.ruleTitle}: ${raw.needFixTitle}`,
  scanner_data: JSON.stringify(raw),
}),

clusterKeys: (issue) => {
  const data = JSON.parse(issue.scanner_data);
  const selectorPattern = normalizeSelector(data.selectors?.[0]);
  return [
    `${issue.rule_id}:${data.flowId || data.pageId}`,     // same rule, same page
    `${issue.rule_id}:selector:${selectorPattern}`,        // same rule, same component pattern
  ];
},
```

### SonarQube fetch specifics

```js
// plugin-sonarqube/src/index.js
fetch: async (config) => {
  let page = 1;
  const allIssues = [];
  while (true) {
    const resp = await fetch(
      `${config.server_url}/api/issues/search?componentKeys=${config.project_key}&statuses=OPEN&p=${page}&ps=500`,
      { headers: { Authorization: `Bearer ${config.token}` } }
    );
    const data = await resp.json();
    allIssues.push(...data.issues);
    if (allIssues.length >= data.total) break;
    page++;
  }
  return allIssues;
},

normalize: (raw) => ({
  id: `sonarqube-${raw.key}`,
  source: 'sonarqube',
  rule_id: raw.rule,
  severity: mapSeverity(raw.severity), // BLOCKER→critical, CRITICAL→high, MAJOR→medium, MINOR→low, INFO→info
  category: mapType(raw.type),         // BUG→bug, VULNERABILITY→vulnerability, SECURITY_HOTSPOT→security_hotspot, CODE_SMELL→code_smell
  file_path: raw.component?.split(':').pop(),  // extract file path from component key
  line_number: raw.line || raw.textRange?.startLine,
  description: raw.message,
  scanner_data: JSON.stringify(raw),
}),

clusterKeys: (issue) => {
  return [
    `${issue.rule_id}:${path.dirname(issue.file_path)}`,  // same rule, same directory
    `${issue.rule_id}:${issue.category}`,                   // same rule, same type
  ];
},
```

## Impact Scoring

Computed during fetch in `core/src/scoring.js` using `config/scoring.json`:

### Scoring formula

```
impact_score = severity_weight × source_factor

source_factor (from plugin.scoringFactors):
  Apiiro:     blast_radius_log × path_criticality × (is_secret ? 10 : 1)
  AQA:        page_importance × log(affected_count + 1)
  SonarQube:  blast_radius_log × type_weight

priority = impact_score / estimated_minutes   (bang for buck)
```

### config/scoring.json

```json
{
  "severity_weights": {
    "critical": 100,
    "high": 70,
    "medium": 40,
    "low": 15,
    "info": 5
  },
  "path_criticality": {
    "src/auth/*": 10,
    "src/payment/*": 10,
    "src/api/*": 7,
    "src/middleware/*": 6,
    "src/components/*": 4,
    "src/utils/*": 2,
    "src/tests/*": 1,
    "__default__": 3
  },
  "page_importance": {
    "/checkout*": 10,
    "/login*": 10,
    "/signup*": 8,
    "/dashboard*": 6,
    "/*": 3
  },
  "type_weights": {
    "bug": 8,
    "vulnerability": 10,
    "security_hotspot": 7,
    "code_smell": 3
  }
}
```

### Effort estimation

Plugin-defined via `plugin.effortEstimate(issue)`. Returns `{level, minutes}`:

| Level | Minutes | Examples |
|-------|---------|----------|
| trivial | 2 | lang attr, decorative alt, tabindex, info code smells |
| small | 5 | content alt text, form labels, env var extraction, minor dep bumps |
| medium | 15 | contrast fixes, injection fixes, heading restructure, major code smells |
| large | 30 | IAM policy, major dep upgrades, architectural fixes, blocker bugs |

## Clustering & Batch Fixing

### How clustering works

1. During fetch, core calls `plugin.clusterKeys(issue)` for each new issue
2. Each issue can return multiple cluster keys (e.g., by page AND by selector pattern)
3. Core hashes each key deterministically: `cluster_id = hash(source + cluster_key)`
4. Issues sharing a cluster_id are grouped together
5. Re-runs don't duplicate clusters (deterministic hash)

### fix-next picks clusters

When `fix-next` runs:
1. Query clusters ordered by sum of impact_scores DESC
2. Pick top cluster (or top single issue if no clusters)
3. Generate batch prompt via `plugin.batchPromptTemplate(issues)`
4. Single branch + single PR for entire cluster

## Dedup Intelligence

Beyond ID-based dedup:

### Content-based dedup
Hash `(rule_id, normalized_description, file_directory)` to find near-duplicates across fetches.

### Scanner-specific dedup (in plugins)
- **Apiiro secrets:** Hash first/last 4 chars of detected secret to group same-secret issues
- **AQA structural:** Normalize CSS selectors to detect same component pattern across pages
- **SonarQube:** Same rule + same file + same line range = duplicate

### Dedup behavior
- Mark duplicates with `dedup_group`. Primary = highest severity.
- Others get `is_duplicate=true`, status stays `open` but they're deprioritized in fix-next
- On approve of primary: check if fix also resolves duplicates → auto-close if yes

## Git Operations

`core/src/git.js`:

```js
createFixBranch(issueId)     // creates autofix/{id} from current branch
commitFix(issueId, message)  // conventional commit: fix(security): rotate secret [apiiro-123]
pushAndCreatePR(issueId, title, body)  // uses gh pr create
checkCIStatus(prUrl)         // polls gh pr checks, auto-rejects on CI failure
rollbackFix(issueId)         // checkout main files, delete branch, status → open
```

For clusters: single branch `autofix/cluster-{cid}`, single PR referencing all issue IDs in body.

## Concurrency Control

- SQLite WAL mode enabled in setup
- File-level locks table with 30min expiry (configurable)
- `fix-next` uses atomic SQL: `UPDATE issues SET status='in_progress' WHERE id=? AND status='open'`
- Before applying fix: check file locks, skip to next if locked
- Locks released on approve, reject, or rollback

## Auto-Approve for Low-Risk Fixes

After status = `ai_fixed`, if `review_level === 'quick'`:
1. Check `git diff --stat`: only expected files touched, total lines <= threshold (default 10)
2. If passes: auto-set `verified`, log `reviewed_by: 'auto-approve'`
3. **Hard rule: NEVER auto-approve any `security_review` level issues**
4. All decisions logged in `auto_approve_log` table
5. Config: `AUTO_APPROVE_ENABLED=true|false`, `AUTO_APPROVE_MAX_LINES=10`

Auto-approve candidates:
- AQA: missing lang, decorative alt="", tabindex fixes
- SonarQube: info-level code smells, simple formatting issues
- Apiiro: NEVER (all security issues require human review)

## Scheduled Auto-Fetch

`core/src/scheduler.js` using `node-cron`, runs inside dashboard server process:

```
FETCH_CRON_APIIRO=0 8 * * 1-5      (weekdays at 8am)
FETCH_CRON_AQA=0 9 * * 1-5         (weekdays at 9am)
FETCH_CRON_SONARQUBE=0 10 * * 1-5  (weekdays at 10am)
```

## Webhook Notifications

`core/src/notify.js`:
- Posts to `NOTIFICATION_WEBHOOK_URL` (Slack/Teams/Discord)
- Payload: `{source, new_issues, total_open, critical_count}`
- Dashboard header shows "Last Scan" time per source

## Prompt Builder Logic

### Apiiro prompts

```
Secrets → replace with env var, add to .env.example, note rotation needed
SCA → bump version, check for breaking changes in changelog
SAST → add parameterized queries, input sanitization, output encoding
Misconfigurations → fix insecure defaults, add security headers
Always: "fix only this issue, don't touch unrelated code, follow existing patterns"
Batch mode: list all files/locations for clustered issues in one prompt
```

### AQA prompts

```
Missing alt → infer meaning from context, write real descriptive text
Contrast → adjust to meet WCAG AA ratio (4.5:1 text, 3:1 large), use closest color from existing palette
Missing labels → associate existing text or add aria-label
Heading order → restructure heading levels
Always: "preserve visual appearance, follow existing component patterns"
Batch mode: list all instances for clustered issues in one prompt
```

### SonarQube prompts

```
Bugs → fix the specific bug, add null checks, fix logic errors
Vulnerabilities → apply OWASP remediation (parameterized queries, encoding, auth checks)
Security hotspots → assess risk, apply recommended secure pattern
Code smells → refactor per SonarQube suggestion, maintain behavior
Always: "minimal change, follow existing code style, don't break tests"
Batch mode: list all locations for same-rule issues in one prompt
```

## Dashboard

Express server on localhost:8000. Single index.html with React via CDN.

### API endpoints

```
GET  /api/issues                    # filterable by source, status, severity, cluster
GET  /api/issues/:id                # single issue + prompt + metadata
GET  /api/issues/next?source=       # next unfixed issue/cluster
POST /api/issues/:id/status         # body: {status, reviewed_by, rejected_reason, rejection_tag}
GET  /api/stats                     # summary numbers per source
GET  /api/clusters                  # cluster list with issue counts
GET  /api/metrics/mttf              # mean time to fix
GET  /api/metrics/acceptance        # fix acceptance rate by rule_id
GET  /api/metrics/velocity          # issues fixed per day/week
GET  /api/scanners                  # installed plugins + status
POST /api/scanners/:source/test     # test scanner connectivity
POST /api/scanners/:source/config   # update scanner config
```

### Dashboard UI

**Layout:**
- Tabs: All | Apiiro | AQA | SonarQube (dynamically generated from installed plugins)
- Settings tab: scanner status, config forms, test buttons

**Summary cards:**
- Open count (per source + total)
- AI Fixed (awaiting review)
- Verified (ready to merge)
- Fix acceptance rate %
- Auto-approved count

**Issues table:**
- Sortable by: impact score, severity, effort, age, status, source
- Each row: issue ID, source badge, severity badge, impact score, effort badge, description, status badge, review_level indicator, cluster indicator
- Row actions: View Diff, Approve, Reject (with tag selector), Copy Prompt, Rollback

**Metrics tab:**
- MTTF chart (by source, severity)
- Acceptance rate by category
- Velocity trend (issues fixed per day/week)
- Queue health (open count, estimated time to clear, aging issues >7 days)
- Issues found vs fixed over time (line chart)
- Breakdown by severity (bar chart)

**Header:**
- Last Scan indicator per source
- Quick actions: Fetch All, Fix Next

**Design:** Clean, modern. No heavy frameworks — React via CDN, minimal CSS.

## IDE Skills (Windsurf/Cascade)

Thin SKILL.md wrappers that instruct Cascade when to shell out to CLI vs use its own AI:

### Per-source skills

```
/apiiro-fetch        → autofix-hub apiiro fetch
/apiiro-fix-next     → autofix-hub apiiro fix-next → Cascade applies fix
/apiiro-fix <id>     → autofix-hub apiiro fix <id> → Cascade applies fix
/apiiro-approve <id> → autofix-hub apiiro approve <id>
/apiiro-reject <id> <tag> <reason> → autofix-hub apiiro reject ...
/apiiro-report       → autofix-hub apiiro report
```

Same pattern for `/aqa-*` and `/sonarqube-*`.

### Shared skills

```
/autofix-setup       → autofix-hub setup
/autofix-dashboard   → autofix-hub dashboard
/autofix-report      → autofix-hub report
```

### Fix flow (what the SKILL.md instructs Cascade to do)

1. Run `autofix-hub <source> fix-next`
2. CLI returns JSON: `{issueId, branch, files, fixPrompt, clusterInfo}`
3. Cascade opens the affected files
4. Cascade applies the AI fix using the prompt
5. Cascade runs `autofix-hub status <id> ai_fixed`
6. Auto-approve check runs
7. Tell developer: "Review the changes, then /approve or /reject"

## Operational Metrics

Computed from existing data in `core/src/metrics.js`:

- **MTTF (Mean Time to Fix):** `AVG(resolved_at - created_at)` by source, severity, rule_id
- **Fix Acceptance Rate:** `COUNT(verified) / COUNT(ai_fixed)` by rule_id
- **Velocity:** Issues fixed per day/week, trending up or down
- **Queue Health:** Open count, estimated time to clear (using effort estimates), aging issues >7 days
- **Rejection Rate by Category:** Which categories need better prompts or manual attention
