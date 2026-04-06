# autofix-hub

A modular, plugin-based CLI that fetches issues from security and accessibility scanners, scores and clusters them by business impact, generates AI fix prompts, and manages git branches/PRs.

**Core loop:** Scan -> Score -> Cluster -> AI Fix -> Developer Review -> PR -> Merge

## Features

- **Multi-scanner support** -- Apiiro (security), UsableNet AQA (accessibility), SonarQube (code quality)
- **Smart scoring** -- severity weights, path criticality, page importance
- **Issue clustering** -- groups related issues to reduce noise (min 2 per cluster)
- **AI fix prompts** -- generates context-rich prompts per scanner type
- **Git workflow** -- automated branch creation (`autofix/<issueId>`), PR management via `gh` CLI
- **Dashboard** -- unified web view of all issues across scanners
- **Setup wizard** -- interactive configuration for all scanners

## Quick Start

```bash
# Install dependencies
pnpm install

# Interactive setup
node packages/core/bin/autofix-hub.js setup

# Fetch issues from scanners
node packages/core/bin/autofix-hub.js apiiro fetch
node packages/core/bin/autofix-hub.js aqa fetch
node packages/core/bin/autofix-hub.js sonarqube fetch

# Get the next AI fix prompt
node packages/core/bin/autofix-hub.js apiiro fix-next

# Launch dashboard
node packages/core/bin/autofix-hub.js dashboard
```

## Architecture

pnpm monorepo with four packages:

| Package | Description |
|---------|-------------|
| `packages/core` | CLI entry point, shared logic (DB, git, scoring, clustering, dashboard, scheduler) |
| `packages/plugin-apiiro` | Apiiro security scanner plugin |
| `packages/plugin-aqa` | UsableNet AQA accessibility plugin |
| `packages/plugin-sonarqube` | SonarQube code quality plugin |

### Plugin System

Plugins are auto-discovered by scanning `packages/plugin-*`. Each exports a standard interface:

- **Required:** `name`, `fetch`, `normalize`, `clusterKeys`, `effortEstimate`, `reviewLevel`, `promptTemplate`
- **Optional:** `displayName`, `checkInstalled`, `checkAuth`, `setupPrompts`, `batchPromptTemplate`, `scoringFactors`

### Data Flow

```
Scanner CLI/API --> fetch() --> normalize() --> score() --> cluster() --> promptTemplate() --> git branch/PR
```

### Issue Status Flow

```
open -> in_progress -> ai_fixed -> verified -> merged -> closed
                          |
                          +-> rejected
```

## Configuration

| File | Purpose |
|------|---------|
| `.env` | Scanner IDs, feature flags, cron schedules, dashboard port (see `.env.example`) |
| `config/scoring.json` | Severity weights, path criticality patterns, page importance |
| `config/effort-map.json` | Per-scanner effort estimates (level + minutes) |

## Prerequisites

- Node.js >= 18
- [pnpm](https://pnpm.io/)
- [git](https://git-scm.com/) and [gh](https://cli.github.com/) CLI
- Scanner CLIs: `apiiro`, `sonar-scanner`, or AQA HTTP API access

## License

MIT
