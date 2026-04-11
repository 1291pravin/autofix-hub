---
name: autofix-hub
description: Autofix-hub CLI integration for all scanners (Apiiro, AQA, SonarQube). Use this skill when the user wants to fetch, fix, approve, reject, or report on security, accessibility, or code quality issues. Triggers on /autofix, or any mention of autofix-hub, Apiiro security scanning, AQA accessibility, SonarQube code quality, WCAG violations, secret detection, SCA vulnerabilities, SAST findings, code smells, or security hotspots.
---

# Autofix Hub

This skill wraps the `autofix-hub` CLI to manage issues from all supported scanners — Apiiro (security), AQA (accessibility), and SonarQube (code quality). It handles the full lifecycle: fetch issues, pick the highest-priority one, apply the AI-generated fix, then approve or reject based on review.

The CLI is installed globally as `autofix-hub` (via `npm install -g @autofix-hub/core` or similar). Run all commands from the project root.

## Fix Guide Resources

Each scanner has a fix guide in the `resources/` directory with scanner-specific fix patterns, categories, and review levels. **Before applying any fix, read the relevant guide:**

- **Apiiro**: `.agents/skills/autofix-hub/resources/apiiro-fix-guide.md`
- **AQA**: `.agents/skills/autofix-hub/resources/aqa-fix-guide.md`
- **SonarQube**: `.agents/skills/autofix-hub/resources/sonarqube-fix-guide.md`

## Syntax

```
/autofix <scanner> <action> [args]
/autofix <shared-action>
```

Where `<scanner>` is one of: `apiiro`, `aqa`, `sonarqube`
And `<action>` is one of: `fetch`, `fix-next`, `fix <id>`, `fix-cluster <clusterId>`, `approve`, `reject`, `report`
And `<shared-action>` is one of: `setup`, `dashboard`, `report`

---

## Scanner Commands

### `/autofix <scanner> fetch`

Fetch the latest issues from the scanner and import them into the local database.

1. Run:
   ```bash
   autofix-hub <scanner> fetch
   ```
2. The CLI outputs a summary like "Found X issues, Y new, Z reopened"
3. Show the user this summary. Highlight critical items relevant to the scanner type.
4. If the command fails with an auth error, tell the user to run `/autofix setup` to configure credentials.

### `/autofix <scanner> fix-next`

Pick the highest-priority unfixed issue (or cluster), create a fix branch, and apply the fix.

1. **Read** the scanner's fix guide from `resources/` (see paths above) to understand the fix patterns and review levels.
2. Run:
   ```bash
   autofix-hub <scanner> fix-next
   ```
3. The CLI outputs JSON:
   ```json
   {
     "issueId": "<scanner>-<id>",
     "branch": "autofix/<scanner>-<id>",
     "files": ["src/example.js"],
     "fixPrompt": "...",
     "clusterInfo": null,
     "reviewLevel": "careful",
     "estimatedEffort": "small"
   }
   ```
4. Parse this JSON output. Open each file listed in `files`.
5. Read the `fixPrompt` and apply the fix following the category-specific instructions from the fix guide. Fix only the targeted issue — do not touch unrelated code.
6. After applying the fix, mark the issue as AI-fixed:
   ```bash
   autofix-hub status <issueId> ai_fixed
   ```
7. Tell the user what was fixed, which files were changed, and the review level. Remind them of the review expectations per the fix guide.

### `/autofix <scanner> fix <id>`

Fix a specific issue by its ID. Use this when you know exactly which issue to fix (e.g., from the dashboard's "Copy Fix Command" button).

1. **Read** the scanner's fix guide from `resources/` (see paths above).
2. Run:
   ```bash
   autofix-hub <scanner> fix <id>
   ```
3. The CLI outputs the same JSON format as `fix-next`:
   ```json
   {
     "issueId": "<scanner>-<id>",
     "branch": "autofix/<scanner>-<id>",
     "files": ["src/example.js"],
     "fixPrompt": "...",
     "clusterInfo": null,
     "reviewLevel": "careful",
     "estimatedEffort": "small"
   }
   ```
4. Parse the JSON, open each file in `files`, apply the fix following `fixPrompt` and the fix guide.
5. After applying the fix, mark as AI-fixed:
   ```bash
   autofix-hub status <issueId> ai_fixed
   ```
6. Tell the user what was fixed, which files were changed, and the review level.

### `/autofix <scanner> fix-cluster <clusterId>`

Fix all open issues in a specific cluster. The CLI creates a single branch for all issues. Use this when you want to batch-fix related issues together (e.g., from the dashboard's cluster "Copy Fix Command" button).

1. **Read** the scanner's fix guide from `resources/` (see paths above).
2. Run:
   ```bash
   autofix-hub <scanner> fix-cluster <clusterId>
   ```
3. The CLI outputs JSON with a `clusterInfo` field:
   ```json
   {
     "issueId": "<first-issue-id>",
     "branch": "autofix/cluster-<clusterId>",
     "files": ["src/file1.js", "src/file2.js"],
     "fixPrompt": "...",
     "clusterInfo": {
       "clusterId": "<clusterId>",
       "clusterKey": "...",
       "issueCount": 3,
       "issueIds": ["id1", "id2", "id3"]
     },
     "reviewLevel": "careful",
     "estimatedEffort": "medium"
   }
   ```
4. Parse the JSON. Open **all** files in `files`. Apply the fix following `fixPrompt` — it will be a batch prompt covering all issues in the cluster.
5. After applying all fixes, mark **each** issue as AI-fixed:
   ```bash
   autofix-hub status <issueId1> ai_fixed
   autofix-hub status <issueId2> ai_fixed
   autofix-hub status <issueId3> ai_fixed
   ```
6. Tell the user what was fixed across the cluster, which files were changed, and the review level.

### `/autofix <scanner> approve <id>`

Approve a fixed issue, push the branch, and create a PR.

1. Run:
   ```bash
   autofix-hub <scanner> approve <id>
   ```
2. The CLI will push the fix branch, create a PR via `gh`, and optionally wait for CI.
3. If CI passes, show the PR URL to the user.
4. If CI fails, the CLI auto-rejects — inform the user and show the failure details.

### `/autofix <scanner> reject <id> <tag> <reason>`

Reject a fix that didn't pass review.

Valid rejection tags: `wrong_scope`, `broke_tests`, `style_mismatch`, `incomplete_fix`, `wrong_approach`, `other`

1. Run:
   ```bash
   autofix-hub <scanner> reject <id> <tag> "<reason>"
   ```
2. The CLI rolls back the fix branch and records the rejection pattern for future learning.
3. Confirm the rejection to the user. The issue returns to `open` status and can be retried.

### `/autofix <scanner> report`

Show a scanner-specific summary report.

1. Run:
   ```bash
   autofix-hub <scanner> report
   ```
2. Display the formatted output — issue counts by status and severity/category, plus top priority items.

---

## Shared Commands

### `/autofix setup`

Run the interactive setup wizard to configure scanners and initialize the project database.

1. Run:
   ```bash
   autofix-hub setup
   ```
2. The wizard will:
   - Check/create `~/.autofix-hub/credentials.json`
   - For each installed scanner plugin: check CLI/API availability and authentication
   - Create `.autofix-hub/` directory and SQLite database in the project root
   - Scaffold default `config/scoring.json` and `config/effort-map.json` if missing
   - Add `.autofix-hub/` to `.gitignore`
3. Follow the interactive prompts. Scanners can be skipped if credentials aren't available yet.
4. Show the final summary: "N of M scanners configured"

### `/autofix dashboard`

Open the autofix-hub web dashboard.

1. Run:
   ```bash
   autofix-hub dashboard
   ```
2. The CLI starts an Express server on the configured port (default: 8000).
3. Tell the user the dashboard is available at `http://localhost:8000` (or the `DASHBOARD_PORT` from `.env`).
4. The server runs in the foreground — stop with Ctrl+C.

### `/autofix report`

Show a cross-scanner summary report in the terminal.

1. Run:
   ```bash
   autofix-hub report
   ```
2. Display the combined view: issue counts by source and status, top 5 priority items, acceptance rate and velocity metrics.
