# UsableNet AQA API v3.1 — Full Reference

Base URL: `https://api-aqa.usablenet.com/v3.1/{teamSlug}`

All requests require the header: `X-Team: {API_KEY}`

---

## Table of Contents

1. [Suites](#suites)
2. [Flows (User Flows)](#flows)
3. [Crawlers (Page Collections)](#crawlers)
4. [Tests (Accessibility Tests)](#tests)
5. [Test Runs](#test-runs)
6. [Run Results — Flows](#run-results--flows)
7. [Run Results — Pages (Crawler)](#run-results--pages)
8. [Issues](#issues)
9. [Evaluate HTML](#evaluate-html)
10. [Rulesets](#rulesets)
11. [Saved Reviews](#saved-reviews)
12. [Scheduling](#scheduling)
13. [Keyboard Navigation Tests](#keyboard-navigation-tests)
14. [Devices & Locations](#devices--locations)
15. [Notification Groups](#notification-groups)

---

## Suites

### List Suites
```
GET /a11y/suites
```
Optional query params: `flowType` (`functional` | `keyboard`), `crawlerType` (`crawler` | `singlePageCrawler`)

Response:
```json
{
  "suites": [
    {
      "id": "TS612",
      "name": "example.com",
      "description": "",
      "locationId": "...",
      "numFlows": 3,
      "numCrawlers": 1
    }
  ]
}
```

### Get Suite Details
```
GET /a11y/suites/{suiteId}
```
Returns full suite object including nested `flows[]` and `crawlers[]` arrays with their IDs, names, URLs, device info, and connection settings.

---

## Flows

Flows are single-page user flows within a suite. Each flow has a starting URL and optional device/connection settings.

### Get Flow Details
```
GET /a11y/suites/{suiteId}/flows/{flowId}
```
Returns: `id`, `name`, `description`, `url` (starting URL), `deviceId`, `deviceScreenIndex`, `connectionSettings`, `type` (`functional` | `keyboard`).

### Create Flow
```
POST /a11y/suites/{suiteId}/flows/{sourceType}/create
```
`sourceType` is one of:
- `url` — provide a starting URL and manual settings
- `settings` — clone settings from an existing flow
- `flow` — clone an existing flow entirely

**Body for `sourceType=url`:**
```json
{
  "name": "Homepage flow",
  "description": "Tests the homepage",
  "url": "https://example.com",
  "deviceId": "D774",
  "deviceScreenIndex": 0,
  "connectionSettings": {
    "cookies": [],
    "headers": [],
    "hosts": [],
    "auth": [],
    "sslValidation": true,
    "timeout": 30
  }
}
```
Only `name` and `url` are required. `deviceId` defaults to the suite's default device.

**Body for `sourceType=settings`:**
```json
{
  "name": "New flow from settings",
  "url": "https://example.com/page2",
  "linkedFlowId": "T4143"
}
```
`linkedFlowId` is the existing flow whose settings (device, connection) to copy.

**Body for `sourceType=flow`:**
```json
{
  "linkedFlowId": "T4143"
}
```
Clones the flow entirely.

Response: `{ "part": { "id": "T4200", "name": "..." } }`

### Update Flow
```
POST /a11y/suites/{suiteId}/flows/{flowId}/update
```
Body (all fields optional, null values are ignored):
```json
{
  "name": "Updated name",
  "description": "Updated description",
  "url": "https://example.com/new-page",
  "deviceId": "D774",
  "deviceScreenIndex": 0,
  "connectionSettings": { ... }
}
```

### Delete Flow
```
POST /a11y/suites/{suiteId}/flows/{flowId}/delete
```
No request body. Permanently removes the flow from the suite.

---

## Crawlers

Crawlers are page collection configurations that crawl multiple pages from a starting URL.

### Get Crawler Details
```
GET /a11y/suites/{suiteId}/crawlers/{crawlerId}
```
Returns: `id`, `name`, `description`, `url`, `deviceId`, `depth`, `limit`, `collectionType` (`crawler` | `sitemap` | `spreadsheet` | `staticsite`).

### Create Crawler
```
POST /a11y/suites/{suiteId}/crawlers/{sourceType}/create
```
`sourceType`: `url`, `settings`, or `flow` (same pattern as flows).

**Body for `sourceType=url`:**
```json
{
  "name": "Site crawler",
  "description": "Crawls example.com",
  "url": "https://example.com",
  "deviceId": "D774",
  "depth": 3,
  "limit": 100
}
```
- `depth` — deepest crawl level from starting page
- `limit` — max URLs to collect

### Update Crawler
```
POST /a11y/suites/{suiteId}/crawlers/{crawlerId}/update
```
Body (all optional):
```json
{
  "name": "Updated crawler",
  "description": "...",
  "url": "https://example.com",
  "deviceId": "D774",
  "deviceScreenIndex": 0,
  "depth": 5,
  "limit": 200
}
```

### Delete Crawler
```
POST /a11y/suites/{suiteId}/crawlers/{crawlerId}/delete
```
No request body.

---

## Tests

Tests define what to scan: which suite, which flows/crawlers, and which ruleset.

### List Tests
```
GET /a11y/tests
```
Required query param: `suiteId` (e.g., `?suiteId=TS612`)

Returns:
```json
{
  "tests": [
    {
      "id": "A3687-0",
      "name": "aqa-scan-2025-03-26",
      "description": "",
      "suiteId": "TS612",
      "rulesetPackId": "v2",
      "rulesetId": "wcag22",
      "folder": "desk",
      "numFlows": 3,
      "numCrawlers": 1,
      "creationTime": 1748113678629,
      "lastEditTime": 1748113678629
    }
  ]
}
```

### Get Test Details (with runs)
```
GET /a11y/tests/{testId}
```
Optional query param: `trashedRuns=true` to see trashed runs.

Returns test config plus `runs[]` array with each run's `id`, `status`, `epoch`, `folder`, flow/crawler summaries.

### Create Test
```
POST /a11y/tests/create
```
```json
{
  "suiteId": "TS612",
  "name": "aqa-scan-2025-03-26-14-30",
  "description": "Automated accessibility scan",
  "rulesetPackId": "v2",
  "rulesetId": "wcag22",
  "flowIds": ["T4143", "T4144"],
  "crawlerIds": ["T4695"],
  "savedReviewId": "AP84",
  "collectMaxTime": 2,
  "collectPause": 5,
  "notificationGroupId": "NG270",
  "reportTypes": ["accessibilityComplianceSummary"],
  "lifespan": "month"
}
```
**Required**: `suiteId`, `name`, `rulesetPackId`, `rulesetId`.
At least one of `flowIds` or `crawlerIds` should be provided.

- `rulesetPackId`: typically `"v2"`
- `rulesetId`: e.g., `"wcag22"`, `"wcag21"`, `"wcag20"` (get available from `/a11y/tests/rulesets`)
- `lifespan`: `"runsList"` (last 30 runs), `"week"`, `"month"`, `"quarter"`
- `reportTypes`: array of report types to auto-generate after each run

Response: `{ "definition": { "id": "A3700-0", "name": "..." } }`

### Update Test
```
POST /a11y/tests/{testId}/update
```
Body (all optional):
```json
{
  "name": "Updated test name",
  "description": "...",
  "flowIds": ["T4143"],
  "crawlerIds": [],
  "savedReviewId": "AP84",
  "collectMaxTime": 3,
  "collectPause": 10,
  "notificationGroupId": "NG270",
  "reportTypes": [],
  "lifespan": "quarter"
}
```
Note: `suiteId`, `rulesetPackId`, and `rulesetId` cannot be changed after creation.

### Move Test
```
POST /a11y/tests/{testId}/move
```
```json
{ "folder": "vault" }
```
Folder values: `"desk"` (workspace), `"vault"` (archive), `"trash"` (trash).

---

## Test Runs

### Create (Trigger) a Run
```
POST /a11y/tests/{testId}/run
```
No request body. Queues a new run.

Response: `{ "run": { "id": "A3687-1747995246509", ... } }`

### Get Run Details
```
GET /a11y/tests/runs/{runId}
```
Returns:
```json
{
  "run": {
    "id": "A3687-1747995246509",
    "status": "ready",
    "epoch": 1747995246509,
    "folder": "desk",
    "numFlows": 3,
    "numCrawlers": 1,
    "numResults": 4,
    "numCollectedPages": 50,
    "flowsSummary": { ... },
    "crawlerPagesSummary": { ... }
  }
}
```

**Run statuses**: `"idle"` (queued), `"scheduled"`, `"collecting"` (in progress), `"ready"` (complete).

### Stop a Run
```
POST /a11y/tests/runs/{runId}/stop
```
Stops a running test.

### Move a Run
```
POST /a11y/tests/runs/{runId}/move
```
```json
{ "folder": "vault" }
```

---

## Run Results — Flows

### List Run Flows
```
GET /a11y/tests/runs/{runId}/flows
```
Returns all flows in the run with their result summaries, statuses, and issue counts.

Part statuses: `0` = passed, `1` = failed, `2` = collecting, `3` = evaluating, `4` = queued, `9` = not processed.

### Get Run Flow Details
```
GET /a11y/tests/runs/{runId}/flows/{flowId}
```
Returns detailed flow result with steps, page URLs, summaries, and a `partSummaryUrl` (public link to view results).

### List Flows with Errors
```
GET /a11y/tests/runs/{runId}/flowErrors
```
Returns flows that encountered errors during collection.

### List Starting Flows with Errors
```
GET /a11y/tests/runs/{runId}/crawlerInitFlowErrors
```
Returns starting flows (used by crawlers) that had errors.

---

## Run Results — Pages

### List Run Pages
```
GET /a11y/tests/runs/{runId}/pages
```
Returns all crawled pages in the run. Supports pagination via `page` query param.

### Get Run Page Details
```
GET /a11y/tests/runs/{runId}/pages/{pageId}
```
Returns detailed page result.

### List Pages with Errors
```
GET /a11y/tests/runs/{runId}/pageErrors
```

---

## Issues

### Flow Issues
```
GET /a11y/tests/runs/{runId}/flows/{flowId}/issues
```
Query params:
- `stepIndex` (default `0`) — zero-based step index
- `changeIndex` (default `-1`) — change index, `-1` = initial state
- `manual` (default `false`) — include manual-review issues
- `comments` (default `false`) — include user comments

Response:
```json
{
  "issuesData": {
    "issues": [
      {
        "auto": true,
        "id": "AI1",
        "ruleId": "wcag22-1_4_3",
        "ruleTitle": "1.4.3: Contrast (Minimum)",
        "ruleShortTitle": "1.4.3",
        "needFixTitle": "Element has insufficient color contrast",
        "checkManuallyTitle": "Check color contrast ratio",
        "solutionId": "insufficient_contrast",
        "responsibility": "CSS/Design",
        "technology": "CSS",
        "selectors": ["#main .hero-text"],
        "tagName": "p",
        "properties": ["needs fix", "medium", "easy"],
        "comments": [...]
      }
    ],
    "propertyTitles": ["Issue status", "Severity", "Complexity"],
    "descriptions": {
      "wcag22-1_4_3": {
        "insufficient_contrast": {
          "problem": "<p>Element has insufficient color contrast.</p>",
          "solutions": [
            { "title": "Fix foreground color", "text": "<p>Adjust foreground...</p>" }
          ]
        }
      }
    }
  }
}
```

**Note:** The `html` field is **not** part of the v3.1 schema. The API does not return the actual HTML element content. Use `selectors[]`, `tagName`, and `solutionId` to identify elements. Use `id` (e.g., `AI5`) to cross-reference issues in the AQA dashboard.

### Page Issues (Crawler results)
```
GET /a11y/tests/runs/{runId}/pages/{pageId}/issues
```
Query params: `manual`, `comments` (same as flow issues).

Same response structure as flow issues.

---

## Evaluate HTML

Evaluate raw HTML against a ruleset without creating a test/run. Useful for quick checks.

```
POST /a11y/tests/evaluate
```
Content-Type: `application/x-www-form-urlencoded` or `multipart/form-data`

Fields:
- `rulesetId` (required) — e.g., `"wcag2aa"`
- `pageUrl` (required) — the URL the HTML was fetched from (for context)
- `code` — raw HTML string (alternative to `archive`)
- `archive` — ZIP file containing HTML (alternative to `code`, multipart only)
- `context` — CSS selector to limit evaluation scope
- `manual` — include manual-review issues

Response: same issue structure as flow/page issues.

---

## Rulesets

### List Rulesets
```
GET /a11y/tests/rulesets
```
Returns all available ruleset packs and their rulesets:
```json
{
  "rulesets": [
    {
      "id": "v2",
      "name": "AQA v2",
      "rulesets": [
        { "id": "wcag22", "name": "WCAG 2.2" },
        { "id": "wcag21", "name": "WCAG 2.1" },
        { "id": "wcag20", "name": "WCAG 2.0" }
      ]
    }
  ]
}
```

---

## Saved Reviews

### List Saved Reviews
```
GET /a11y/tests/savedReviews
```
Returns saved review configurations (ID format: `"AP84"`). These can be applied to tests to carry over manual review decisions.

---

## Scheduling

### Create Scheduler
```
POST /a11y/tests/{testId}/scheduler/create
```
```json
{
  "startTime": 1748113678629,
  "execution": "day",
  "numRepeats": 7
}
```
- `execution`: `"once"`, `"day"`, `"week"`, `"month"`
- `numRepeats`: number of executions (2-31 for day, 2-52 for week, 2-12 for month). Use `0` for infinite.
- For `"week"`: also provide `"dayOfWeek"` (0=Sunday, 6=Saturday)
- For `"month"`: also provide `"dayOfMonth"` (1-28)

Cannot override active scheduler — delete first.

### Delete Scheduler
```
POST /a11y/tests/{testId}/scheduler/delete
```
No request body. Removes the active scheduler.

---

## Keyboard Navigation Tests

Separate set of endpoints for keyboard-specific accessibility testing. Same patterns as accessibility tests.

### List Keyboard Tests
```
GET /a11y/keyboardTests
```
Query param: `suiteId` (required)

### Create Keyboard Test
```
POST /a11y/keyboardTests/create
```
Same body structure as accessibility test create.

### Get Keyboard Test Details
```
GET /a11y/keyboardTests/{testId}
```

### Update Keyboard Test
```
POST /a11y/keyboardTests/{testId}/update
```

### Run Keyboard Test
```
POST /a11y/keyboardTests/{testId}/run
```

### Get Keyboard Run Details
```
GET /a11y/keyboardTests/runs/{runId}
```

### List Keyboard Run Flows
```
GET /a11y/keyboardTests/runs/{runId}/flows
```

### Get Keyboard Run Flow Details
```
GET /a11y/keyboardTests/runs/{runId}/flows/{flowId}
```

### Stop Keyboard Run
```
POST /a11y/keyboardTests/runs/{runId}/stop
```

### Move Keyboard Run / Test
```
POST /a11y/keyboardTests/runs/{runId}/move
POST /a11y/keyboardTests/{testId}/move
```

### Schedule / Unschedule Keyboard Test
```
POST /a11y/keyboardTests/{testId}/scheduler/create
POST /a11y/keyboardTests/{testId}/scheduler/delete
```

---

## Devices & Locations

### List Devices
```
GET /aqa/devices
```
Returns available devices with their IDs (format: `"D774"`), names, screen resolutions.

### List Locations
```
GET /aqa/locations
```
Returns available recording locations for suites.

---

## Notification Groups

### List Notification Groups
```
GET /aqa/notificationGroups
```
Returns recipient groups (ID format: `"NG270"`) for test notifications.
