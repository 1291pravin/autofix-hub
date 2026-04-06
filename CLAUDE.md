# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**autofix-hub** is a modular, plugin-based CLI that fetches issues from security/accessibility scanners (Apiiro, AQA/UsableNet, SonarQube), scores and clusters them by business impact, generates AI fix prompts, and manages git branches/PRs. The core loop: Scan → Score → Cluster → AI Fix → Developer Review → PR → Merge.

## Commands

```bash
pnpm install                          # install all workspace dependencies
pnpm dev                              # run core in dev mode
pnpm test                             # run tests across all packages
node packages/core/bin/autofix-hub.js # run CLI directly without global install
```

## Architecture

**pnpm monorepo** with four workspace packages under `packages/`:

- **`core`** (`@autofix-hub/core`) — CLI entry point, shared logic (DB, git, scoring, clustering, dedup, locks, scheduler, dashboard, metrics, notifications), all commands. Entry: `bin/autofix-hub.js` using Commander.js.
- **`plugin-apiiro`** (`@autofix-hub/plugin-apiiro`) — Apiiro security scanner plugin
- **`plugin-aqa`** (`@autofix-hub/plugin-aqa`) — UsableNet AQA accessibility plugin
- **`plugin-sonarqube`** (`@autofix-hub/plugin-sonarqube`) — SonarQube code quality plugin

### Plugin System

Plugins are auto-discovered by `pluginLoader.js` scanning `packages/plugin-*` directories. Each plugin exports a standard interface with required methods: `name`, `fetch`, `normalize`, `clusterKeys`, `effortEstimate`, `reviewLevel`, `promptTemplate`. Optional: `displayName`, `checkInstalled`, `checkAuth`, `setupPrompts`, `batchPromptTemplate`, `scoringFactors`.

Plugins depend on `@autofix-hub/core` via `workspace:*`. Core does not depend on plugins.

### Data Flow

1. **Fetch**: Plugin's `fetch()` calls external scanner CLI/API → raw issues
2. **Normalize**: Plugin's `normalize()` → common schema with prefixed IDs (e.g., `apiiro-xxx`)
3. **Score**: Core's `scoring.js` combines `severity_weights` from `config/scoring.json` with plugin's `scoringFactors()`
4. **Cluster**: Core's `clustering.js` groups issues using plugin's `clusterKeys()` (min 2 issues per cluster)
5. **Fix**: Core generates prompts via plugin's `promptTemplate()`, manages git branches (`autofix/<issueId>`)
6. **Approve/Reject**: Core handles PR creation via `gh` CLI, CI polling, rollback

### Storage

- **SQLite** (`better-sqlite3`, WAL mode) at `<project-root>/.autofix-hub/issues.db` — per-project, gitignored
- **Global credentials** at `~/.autofix-hub/credentials.json`
- **Team-shared config** in `config/scoring.json` and `config/effort-map.json` — committed to git

### Key Tables

`issues` (main tracking), `clusters` (grouped issues), `fix_attempts`, `scan_history`, `rejection_patterns`, `auto_approve_log`, `locks` (file-level concurrency), `issue_metadata` (key-value extensions).

### Status Flow

`open → in_progress → ai_fixed → verified → merged → closed` (with `rejected` branch from `ai_fixed`)

### External Dependencies

- **git** and **gh** CLI for branch/PR management
- Scanner CLIs: `apiiro` (Apiiro), `sonar-scanner` (SonarQube), HTTP API (AQA)
- Node.js >= 18

## Configuration

- `.env` at project root (see `.env.example`) — scanner IDs, feature flags, cron schedules, dashboard port
- `config/scoring.json` — severity weights, path criticality patterns, page importance, type weights
- `config/effort-map.json` — per-scanner, per-category effort estimates (level + minutes)

## IDE Skills

`.agents/skills/autofix-hub/` contains a unified IDE integration skill for Windsurf/Cascade, covering all scanners (Apiiro, AQA, SonarQube) and shared commands (setup, dashboard, report).

## Development Phases

Phase 1 (current): Core CLI + plugins + clustering + dashboard + setup wizard + git/PR workflow. Phase 2 (planned): Rejection learning, AI diff analysis, git-based scoring, auto-improvement. See `docs/` for specs and plans.
