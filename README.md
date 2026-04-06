# autofix-hub

A modular, plugin-based CLI that fetches issues from security and accessibility scanners, scores and clusters them by business impact, generates AI fix prompts, and manages git branches/PRs.

**Core loop:** Scan → Score → Cluster → AI Fix → Developer Review → PR → Merge

## Features

- **Multi-scanner support** — Apiiro (security), UsableNet AQA (accessibility), SonarQube (code quality)
- **Smart scoring** — severity weights, path criticality, page importance
- **Issue clustering** — groups related issues to reduce noise (min 2 per cluster)
- **AI fix prompts** — generates context-rich prompts per scanner type
- **Git workflow** — automated branch creation (`autofix/<issueId>`), PR management via `gh` CLI
- **Auto-approve** — small, low-risk fixes can bypass manual review
- **Dashboard** — unified web view of all issues across scanners
- **Setup wizard** — interactive configuration for all scanners
- **File locking** — prevents concurrent fixes on the same file
- **Deduplication** — detects and marks duplicate issues across scans

## Prerequisites

- **Node.js >= 18**
- **pnpm** — install via `npm install -g pnpm`
- **git** — [git-scm.com](https://git-scm.com/)
- **GitHub CLI (`gh`)** — [cli.github.com](https://cli.github.com/) — required for PR creation and CI polling
- **Scanner access** (at least one):
  - **Apiiro** — `apiiro` CLI installed and authenticated
  - **UsableNet AQA** — HTTP API access with a suite ID and test ID
  - **SonarQube** — `sonar-scanner` CLI installed, project key configured

## Installation

### From npm (after publishing)

```bash
# Install globally — gives you the `autofix-hub` command
npm install -g @autofix-hub/core

# Install the scanner plugins you need
npm install -g @autofix-hub/plugin-apiiro
npm install -g @autofix-hub/plugin-aqa
npm install -g @autofix-hub/plugin-sonarqube
```

### From source

```bash
git clone https://github.com/user/autofix-hub.git
cd autofix-hub
pnpm install

# Run directly
node packages/core/bin/autofix-hub.js --help

# Or link globally for development
cd packages/core && pnpm link --global
```

## Getting Started

### 1. Run the setup wizard

```bash
autofix-hub setup
```

This walks you through configuring each scanner interactively. It will:
- Detect which scanner plugins are installed
- Prompt for credentials and project-specific IDs
- Save credentials to `~/.autofix-hub/credentials.json` (global, gitignored)
- Create a `.env` file in your project root

### 2. Configure environment variables

Copy the example and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description | Example |
|----------|-------------|---------|
| `AQA_SUITE_ID` | UsableNet AQA suite identifier | `suite-abc123` |
| `AQA_TEST_ID` | UsableNet AQA test identifier | `test-xyz789` |
| `SONARQUBE_PROJECT_KEY` | SonarQube project key | `my-org:my-project` |
| `AUTO_APPROVE_ENABLED` | Enable auto-approval for small fixes | `true` |
| `AUTO_APPROVE_MAX_LINES` | Max diff lines for auto-approval | `10` |
| `FETCH_CRON_APIIRO` | Cron schedule for Apiiro fetches | `0 8 * * 1-5` (weekdays 8am) |
| `FETCH_CRON_AQA` | Cron schedule for AQA fetches | `0 9 * * 1-5` |
| `FETCH_CRON_SONARQUBE` | Cron schedule for SonarQube fetches | `0 10 * * 1-5` |
| `NOTIFICATION_WEBHOOK_URL` | Webhook URL for notifications (Slack, etc.) | `https://hooks.slack.com/...` |
| `CI_WAIT` | Wait for CI checks before completing approval | `true` |
| `DASHBOARD_PORT` | Port for the web dashboard | `8000` |

### 3. Fetch issues

```bash
# Fetch from a specific scanner
autofix-hub apiiro fetch
autofix-hub aqa fetch
autofix-hub sonarqube fetch
```

Issues are stored in a local SQLite database at `.autofix-hub/issues.db` in your project root (gitignored automatically).

### 4. Get fix prompts

```bash
# Get the highest-priority issue or cluster to fix (JSON output)
autofix-hub apiiro fix-next

# Get a specific issue by ID
autofix-hub apiiro fix apiiro-abc123

# Get an entire cluster of related issues
autofix-hub apiiro fix-cluster cluster-456
```

The output is JSON designed for consumption by AI coding agents or IDEs. It includes the issue details, file paths, and a generated prompt template.

### 5. Review and approve

```bash
# Approve: pushes the fix branch, creates a PR, polls CI
autofix-hub apiiro approve apiiro-abc123

# Reject with a categorized tag and reason
autofix-hub apiiro reject apiiro-abc123 wrong_scope "Fix changes unrelated files"

# Rollback: restores files from main, deletes branch, resets to open
autofix-hub apiiro rollback apiiro-abc123
```

**Rejection tags:** `wrong_scope`, `broke_tests`, `style_mismatch`, `incomplete_fix`, `wrong_approach`, `other`

### 6. Monitor

```bash
# Cross-source terminal report
autofix-hub report

# Per-scanner report
autofix-hub apiiro report

# View scheduled fetch times
autofix-hub schedule-status

# Launch the web dashboard
autofix-hub dashboard
```

## Command Reference

### Global commands

| Command | Description |
|---------|-------------|
| `autofix-hub setup` | Interactive setup wizard |
| `autofix-hub dashboard` | Start the web dashboard (default port 8000) |
| `autofix-hub report` | Cross-source summary report in terminal |
| `autofix-hub schedule-status` | Show scheduled fetch cron times |
| `autofix-hub status <id> <newStatus>` | Manually transition an issue's status |

### Per-scanner commands

Replace `<source>` with `apiiro`, `aqa`, or `sonarqube`:

| Command | Description |
|---------|-------------|
| `autofix-hub <source> fetch` | Fetch issues from the scanner |
| `autofix-hub <source> fix-next` | Get the next highest-priority fix (JSON) |
| `autofix-hub <source> fix <id>` | Get a specific issue fix prompt (JSON) |
| `autofix-hub <source> fix-cluster <clusterId>` | Get a cluster of issues to fix (JSON) |
| `autofix-hub <source> approve <id>` | Push branch, create PR, check CI |
| `autofix-hub <source> reject <id> <tag> <reason>` | Reject a fix with categorized feedback |
| `autofix-hub <source> rollback <id>` | Undo a fix — restore files, delete branch |
| `autofix-hub <source> report` | Scanner-specific summary report |

## Issue Status Flow

```
open → in_progress → ai_fixed → verified → merged → closed
                        │
                        └→ rejected → open (reopen)
```

**Valid transitions:**

| From | To |
|------|----|
| `open` | `in_progress` |
| `in_progress` | `ai_fixed`, `open`, `rejected` |
| `ai_fixed` | `verified`, `rejected`, `open` |
| `verified` | `merged`, `rejected`, `open` |
| `merged` | `closed`, `open` (reopen) |
| `closed` | `open` (reopen) |
| `rejected` | `open` (reopen) |

## Configuration

### Scoring (`config/scoring.json`)

Controls how issues are prioritized. Higher scores = fixed first.

```jsonc
{
  // Base score by severity level
  "severity_weights": {
    "critical": 100,
    "high": 70,
    "medium": 40,
    "low": 15,
    "info": 5
  },
  // Multiplier based on file path (glob patterns)
  "path_criticality": {
    "src/auth/*": 10,      // auth code = highest priority
    "src/payment/*": 10,
    "src/api/*": 7,
    "src/tests/*": 1,      // test files = lowest
    "__default__": 3
  },
  // Multiplier based on page URL (AQA accessibility issues)
  "page_importance": {
    "/checkout*": 10,
    "/login*": 10,
    "/*": 3
  },
  // Multiplier based on issue type (SonarQube)
  "type_weights": {
    "vulnerability": 10,
    "bug": 8,
    "security_hotspot": 7,
    "code_smell": 3
  }
}
```

Customize these to match your project's priorities. For example, if your payment flow is more critical than auth, increase `src/payment/*` and decrease `src/auth/*`.

### Effort estimates (`config/effort-map.json`)

Maps scanner-specific issue categories to effort levels. Used for scheduling and prioritization (impact score / estimated minutes = fix ROI).

```jsonc
{
  "apiiro": {
    "secret": { "level": "small", "minutes": 5 },
    "sca_major": { "level": "large", "minutes": 30 },
    "sast_injection": { "level": "medium", "minutes": 15 },
    "__default__": { "level": "medium", "minutes": 15 }
  },
  "aqa": {
    "image-alt": { "level": "small", "minutes": 5 },
    "color-contrast": { "level": "medium", "minutes": 15 },
    "__default__": { "level": "small", "minutes": 5 }
  },
  "sonarqube": {
    "bug_BLOCKER": { "level": "large", "minutes": 30 },
    "code_smell_INFO": { "level": "trivial", "minutes": 2 },
    "__default__": { "level": "medium", "minutes": 15 }
  }
}
```

Effort levels: `trivial` (< 5 min), `small` (5 min), `medium` (15 min), `large` (30+ min).

### Auto-approve rules

When `AUTO_APPROVE_ENABLED=true`, fixes are auto-approved if **all** of these are true:
- Review level is `quick` (determined by the plugin)
- Diff is under `AUTO_APPROVE_MAX_LINES` lines changed
- Source is **not** Apiiro (security issues always require manual review)

## Architecture

pnpm monorepo with four packages:

| Package | npm name | Description |
|---------|----------|-------------|
| `packages/core` | `@autofix-hub/core` | CLI entry point, shared logic (DB, git, scoring, clustering, dashboard, scheduler) |
| `packages/plugin-apiiro` | `@autofix-hub/plugin-apiiro` | Apiiro security scanner plugin |
| `packages/plugin-aqa` | `@autofix-hub/plugin-aqa` | UsableNet AQA accessibility plugin |
| `packages/plugin-sonarqube` | `@autofix-hub/plugin-sonarqube` | SonarQube code quality plugin |

### Plugin system

Plugins are auto-discovered by scanning `packages/plugin-*` (from source) or globally installed `@autofix-hub/plugin-*` packages. Each plugin exports:

**Required:** `name`, `fetch`, `normalize`, `clusterKeys`, `effortEstimate`, `reviewLevel`, `promptTemplate`

**Optional:** `displayName`, `checkInstalled`, `checkAuth`, `setupPrompts`, `batchPromptTemplate`, `scoringFactors`

### Data flow

```
Scanner CLI/API → fetch() → normalize() → score() → cluster() → promptTemplate() → git branch/PR
```

### Storage

| Location | Purpose |
|----------|---------|
| `.autofix-hub/issues.db` | SQLite database (per project, gitignored) |
| `~/.autofix-hub/credentials.json` | Global scanner credentials |
| `config/scoring.json` | Scoring weights (committed to git, team-shared) |
| `config/effort-map.json` | Effort estimates (committed to git, team-shared) |

## Troubleshooting

**"Plugin 'apiiro' is not installed"**
Install the plugin: `npm install -g @autofix-hub/plugin-apiiro`. If developing from source, ensure `packages/plugin-apiiro/src/index.js` exists.

**"Issue not found for source"**
Run `autofix-hub <source> fetch` first to populate the database.

**"Issue is not ready for approval"**
The issue must be in `ai_fixed` or `verified` status. Check current status with `autofix-hub report`.

**`gh` CLI errors during approve**
Ensure `gh` is installed and authenticated: `gh auth status`. The approve command uses `gh pr create` under the hood.

**Database locked errors**
autofix-hub uses SQLite in WAL mode with file-level locking. If you see lock errors, ensure no other autofix-hub process is running on the same project.

**Dashboard won't start**
Check if the port is in use: change `DASHBOARD_PORT` in `.env`. Default is 8000.

## Development

For testing packages locally without publishing to npm (e.g., on another machine), see [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md).

```bash
# Install dependencies
pnpm install

# Run CLI in dev mode
pnpm dev

# Run tests across all packages
pnpm test

# Run CLI directly
node packages/core/bin/autofix-hub.js --help
```

## License

MIT
