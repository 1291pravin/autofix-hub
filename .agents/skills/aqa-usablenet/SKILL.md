---
name: aqa-usablenet
description: >
  Full UsableNet AQA API integration — create suites, manage flows and crawlers,
  run accessibility tests, fetch and analyze issues, schedule recurring scans,
  evaluate raw HTML, and remediate WCAG violations. Handles any AQA operation:
  list/create/update/delete suites, flows, crawlers, and tests; trigger and
  monitor runs; extract issues by flow or page; schedule tests; manage keyboard
  navigation tests; and auto-fix accessibility violations with PR creation.
  Use this skill whenever the user mentions UsableNet, AQA, accessibility API,
  WCAG scan, a11y issues, suite ID, flow ID, run ID, test ID, or wants to
  interact with the AQA platform in any way — even if they don't explicitly
  say "aqa-usablenet". Accepts suite IDs (TS*), test IDs (A*-0), run IDs
  (A*-timestamp), flow IDs (T*), or site names to resolve targets automatically.
---

# UsableNet AQA — API-Driven Accessibility Platform

This skill gives you complete control over the UsableNet AQA API v3.1. You can perform any operation — from listing suites to running scans and fixing violations.

For the full API reference with request/response schemas, read `references/api-reference.md` in this skill directory.

## Authentication & Setup

Every API call requires two values:

| Variable | Purpose | ID Format |
|----------|---------|-----------|
| `AQA_API_KEY` | API key, sent as `X-Team` header | Opaque string |
| `AQA_TEAM_SLUG` | Team identifier in the URL path | e.g. `acme` |

**Base URL**: `https://api-aqa.usablenet.com/v3.1/{AQA_TEAM_SLUG}`

**Common headers** for every request:
```
Accept: application/json
X-Team: {AQA_API_KEY}
Content-Type: application/json  (for POST requests with body)
```

Before doing any work, verify both variables are set:
```bash
[ -z "$AQA_API_KEY" ]   && echo "MISSING: AQA_API_KEY"   || echo "OK: AQA_API_KEY"
[ -z "$AQA_TEAM_SLUG" ] && echo "MISSING: AQA_TEAM_SLUG" || echo "OK: AQA_TEAM_SLUG"
```

If missing, tell the user to set them:
```
export AQA_API_KEY=<your-api-key>
export AQA_TEAM_SLUG=<your-team-slug>
```
Find these in the AQA dashboard under "API Keys & Views". Never print the key value or commit it.

**Connectivity check** — verify the API is reachable before any operation:
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Accept: application/json" \
  -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites"
```
`200` = OK, `401` = bad key, `403` = insufficient permissions, `404` = bad team slug, `5xx` = API down.

## ID Formats

The AQA API uses specific ID formats. Recognize these when the user provides them:

| Resource | Format | Example |
|----------|--------|---------|
| Suite | `TS{n}` | `TS612` |
| Flow / Crawler | `T{n}` | `T4143` |
| Test | `A{n}-0` | `A3687-0` |
| Run | `A{n}-{timestamp}` | `A3687-1747995246509` |
| Page | `PAGE-{n}-T{n}-{n}-{hash}` | `PAGE-2-T4695-1-195ecaa26ef_ac1f2e8a66` |
| Device | `D{n}` | `D774` |
| Notification Group | `NG{n}` | `NG270` |
| Saved Review | `AP{n}` | `AP84` |

When the user provides an ID, infer the resource type from the format and use the appropriate API.

## Core API Operations

Below is a quick-reference for the most common operations. For full schemas and all endpoints, read `references/api-reference.md`.

### Suites

```bash
# List all suites
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites"

# Get suite details (includes flows[] and crawlers[])
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites/$SUITE_ID"
```

### Flows (within a Suite)

```bash
# Get flow details
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites/$SUITE_ID/flows/$FLOW_ID"

# Create a flow from URL
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Flow", "url": "https://example.com"}' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites/$SUITE_ID/flows/url/create"

# Update a flow
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Flow", "url": "https://example.com/new"}' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites/$SUITE_ID/flows/$FLOW_ID/update"

# Delete a flow
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites/$SUITE_ID/flows/$FLOW_ID/delete"
```

### Crawlers (within a Suite)

```bash
# Create a crawler
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Site Crawler", "url": "https://example.com", "depth": 3, "limit": 100}' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/suites/$SUITE_ID/crawlers/url/create"

# Update / Delete follow same pattern as flows
```

### Tests

```bash
# List tests for a suite
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests?suiteId=$SUITE_ID"

# Create a test
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "suiteId": "'"$SUITE_ID"'",
    "name": "aqa-scan-'"$(date +%Y-%m-%d-%H-%M)"'",
    "rulesetPackId": "v2",
    "rulesetId": "wcag22",
    "flowIds": '"$FLOW_IDS_JSON"',
    "crawlerIds": '"$CRAWLER_IDS_JSON"'
  }' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/create"

# Get test details (includes runs history)
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/$TEST_ID"

# Update test configuration
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated", "flowIds": ["T4143"], "lifespan": "month"}' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/$TEST_ID/update"

# Move test to archive/trash/workspace
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"folder": "vault"}' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/$TEST_ID/move"
```

### Runs (Trigger, Monitor, Results)

```bash
# Trigger a run
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/$TEST_ID/run"

# Check run status (poll until status = "ready")
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/runs/$RUN_ID"

# Stop a running test
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/runs/$RUN_ID/stop"

# List flows in a run (with result summaries)
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/runs/$RUN_ID/flows"

# List pages in a run (crawler results, supports pagination)
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/runs/$RUN_ID/pages"
```

### Issues (the core results)

```bash
# Get issues for a specific flow in a run
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/runs/$RUN_ID/flows/$FLOW_ID/issues?changeIndex=-1&manual=false&stepIndex=0"

# Get issues for a specific page in a run (crawler results)
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/runs/$RUN_ID/pages/$PAGE_ID/issues"
```

Issue objects contain: `auto`, `id` (e.g., `AI5`), `ruleId`, `ruleTitle`, `ruleShortTitle`, `needFixTitle`, `checkManuallyTitle`, `solutionId`, `selectors[]`, `tagName`, `properties[]` (status/severity/complexity), `responsibility`, `technology`. Detailed problem descriptions and solutions are in the shared `descriptions` map, keyed by `descriptions[issue.ruleId][issue.solutionId]`. **Note:** There is no `html` field — the API does not return element HTML snippets.

### Evaluate HTML (quick check, no test needed)

```bash
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "rulesetId=wcag2aa" \
  --data-urlencode "pageUrl=https://example.com" \
  --data-urlencode "code=<html>...</html>" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/evaluate"
```

### Rulesets & Saved Reviews

```bash
# List available rulesets
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/rulesets"

# List saved reviews
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/savedReviews"
```

### Scheduling

```bash
# Schedule a test (e.g., daily for 7 days)
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"startTime": '"$(date +%s%3N)"', "execution": "day", "numRepeats": 7}' \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/$TEST_ID/scheduler/create"

# Remove scheduler
curl -s -X POST -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/a11y/tests/$TEST_ID/scheduler/delete"
```

Scheduler options: `execution` = `once` | `day` | `week` | `month`. For `week` add `dayOfWeek` (0-6), for `month` add `dayOfMonth` (1-28). `numRepeats` = 0 for infinite.

### Devices & Locations

```bash
# List available devices
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/aqa/devices"

# List recording locations
curl -s -H "Accept: application/json" -H "X-Team: $AQA_API_KEY" \
  "https://api-aqa.usablenet.com/v3.1/$AQA_TEAM_SLUG/aqa/locations"
```

## Resolving User Intent

When the user provides partial information, resolve the target using this logic:

**Given a site name** (e.g., "example.com"):
1. List suites → search names for case-insensitive match
2. If one match → use it. If multiple → ask user. If none → show all suites.

**Given a suite ID** (e.g., "TS612"):
1. Get suite details directly to retrieve flows and crawlers.

**Given a test ID** (e.g., "A3687-0"):
1. Get test details directly — includes suite, flows, crawlers, and run history.

**Given a run ID** (e.g., "A3687-1747995246509"):
1. Get run details directly — includes status, flow/crawler summaries.

**Given a flow ID** (e.g., "T4143") without suite context:
1. List suites → get details of each → find which contains the flow.

**User says "run my site" / "scan this site"**:
1. Resolve suite → get flows/crawlers → create test → trigger run → poll → fetch issues.

**User says "fix my site" / "fix accessibility issues"**:
1. Follow the full remediation workflow below.

## Full Remediation Workflow

> **DEPRECATED**: The remediation workflow below has been replaced by the Jira-centric flow:
> 1. `/triage-aqa` — scan and create Jira tickets
> 2. `/work-on-ticket <KEY>` — fix the violations locally
> 3. `/ship-ticket` — commit, create PR, and update Jira
>
> The API management operations above (suites, flows, crawlers, tests, scheduling) are **not deprecated** and remain the primary way to interact with the AQA platform.

When the user wants to scan and fix accessibility issues, follow this end-to-end flow. Each step uses the APIs above.

1. **Validate** environment variables and API connectivity
2. **Resolve** the target suite (from site name, suite ID, or by listing)
3. **Resume detection** — check for previous chunks (see details below)
4. **Get suite details** to collect all flow IDs and crawler IDs
5. **Create test** using all flows/crawlers with `rulesetPackId: "v2"`, `rulesetId: "wcag22"`
6. **Trigger run** and **poll** every 10s until `status === "ready"` (timeout: 30 min)
7. **Fetch issues** for every flow and page in the run
8. **Sort by severity**: critical > serious > moderate > minor
9. **Skip already-handled issues** based on resume detection, then **display inventory** grouped by ruleId and severity
10. **Map issues to source files** using selectors, flow URLs, and file-based routing patterns
11. **Remediate** up to 20 issues per chunk (see remediation guidance below)
12. **Build and test** — verify no regressions
13. **Create PR** with conventional commit format

### Step 3: Resume Detection

Before scanning, check if previous chunks were already processed in earlier sessions:

1. **List existing chunk branches** (local and remote):
   ```bash
   git branch -a --list '*fix/aqa-accessibility-chunk-*'
   ```
2. **Extract the highest chunk number** from matching branches (e.g., `fix/aqa-accessibility-chunk-3-2026-03-28` → chunk 3)
3. **Check PR status** for each chunk branch using `gh pr list --head <branch> --state all --json number,state,title`
4. **Calculate resume point**:
   - Count all chunk branches that have an open or merged PR → multiply by 20 = issues already handled
   - The next chunk number = highest chunk number + 1
   - Issues to skip = (next chunk number - 1) × 20
5. **Inform the user** if resuming:
   > Resuming from chunk **N**. Found **X** existing chunk branches with PRs. Skipping the first **Y** issues (already handled in previous chunks).

If no previous chunk branches exist, start from chunk 1 with zero issues to skip.

**Important**: The resume logic assumes issues are sorted identically each time (same severity ordering: critical > serious > moderate > minor, then by ruleId). The ordering is deterministic for a given set of issues from the same run. If a previous chunk's PR was merged and the fixes deployed, a new scan may return fewer issues — the skip count adjusts naturally since resolved issues won't appear in new results.

Skip files in `node_modules/`, `dist/`, `build/`, `.next/`, `.nuxt/`, CDN resources, or auto-generated files. Add these to a manual review list.

## Remediation Guidance

When fixing issues, always consult the issue's `solutions[]` array and `needFixTitle` for specific guidance. Process in severity order.

| Rule ID | WCAG | Fix Approach |
|---------|------|-------------|
| `color-contrast` | 1.4.3/1.4.11 | Adjust text/background colors to meet 4.5:1 (normal) or 3:1 (large text). Preserve hue, update CSS custom properties at `:root` when applicable. |
| `image-alt` | 1.1.1 | Decorative: `alt=""` + `role="presentation"`. Informative: descriptive alt under 125 chars. Linked: describe destination. |
| `aria-required-attr`, `aria-label` | 4.1.2 | Prefer visible `<label>` or text content. Icon-only: add `aria-label`. Label elsewhere: use `aria-labelledby`. |
| `label` | 1.3.1/3.3.2 | Add `<label for="id">`. Visually hidden: use `.sr-only` class (not `display:none`). |
| `keyboard`, `tabindex` | 2.1.1/2.4.3 | Replace `<div onClick>` with `<button>`. Remove positive `tabindex`. Remove `tabindex="-1"` on interactive elements. |
| `link-name`, `button-name` | 4.1.2 | Icon-only SVG: add `aria-label` or `<title>`. Generic text: make descriptive. |
| `document-title` | 2.4.2 | Add/fix `<title>{Page} \| {Site}</title>` in `<head>`. |
| `heading-order` | 1.3.1 | Fix skipped levels. Restyle with CSS if visual change isn't desired. |
| `landmark-*`, `region` | 1.3.1 | Wrap content in `<main>`, label multiple `<nav>` elements. |
| `focus-visible` | 2.4.7 | Remove `outline:none` on `:focus`. Add visible `:focus-visible` style with 3:1 contrast. |

## PR Format

**Branch**: `fix/aqa-accessibility-chunk-N-YYYY-MM-DD` (N = chunk number from resume detection)

**Commit** (conventional commits):
```
fix(a11y): remediate UsableNet AQA violations — chunk N

- Fixed X color contrast issues (WCAG 1.4.3)
- Fixed Y missing alt text (WCAG 1.1.1)
Suite: {suiteName} | Run: {runId}
```

**PR body** should include: severity range, suite/run info, summary table (violation type / found / fixed / manual), files changed with descriptions, manual action items, remaining violation count.
