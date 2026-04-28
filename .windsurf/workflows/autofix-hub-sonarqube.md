---
description: Autopilot loop — keep producing SonarQube code-quality autofix PRs, respecting the 3-PR WIP cap, until the queue is drained
---

# /autofix-hub-sonarqube

Run autofix-hub end-to-end for SonarQube on a continuous loop. Each iteration
produces one PR. The CLI enforces the WIP cap (default 3 open `autofix`-labeled
PRs); when the cap is reached, this workflow blocks and polls until a PR is
merged or closed before opening another.

Designed to be fire-and-forget: invoke once, walk away, come back to a queue of
review-ready PRs.

## Rules (never break)

- Edit ONLY the files listed in `next_club.files`. No refactoring, no "while
  we're here" cleanup.
- Do NOT touch any path that `autofix-hub commit` refuses (blocklist enforced
  by the CLI).
- Do NOT switch directories outside the worktree path returned by `next-club`.
- One cluster per iteration. After each commit/abandon, immediately move on.
- If `gate` fails, you get ONE retry with the error output. Still fails →
  abandon and continue.
- Stop only when `next-club` returns `status: queue_empty` or
  `status: wip_full_timeout`. Do not stop on transient errors — abandon the
  current cluster and let the loop continue.

## Steps

1. **Refresh the queue.** Run `autofix-hub sonarqube fetch --json`.
   - Requires `sonar-scanner` on PATH and `SONAR_TOKEN` / `SONAR_HOST_URL` /
     `SONAR_PROJECT_KEY` in `.env` (set up via `/autofix setup`).
   - Note the counts. If zero open issues, jump to step 4 (summarize) and exit.

2. **Loop.** Repeat until termination:

   a. `autofix-hub sonarqube next-club --wait --poll-seconds 60 --max-wait-minutes 30`
      - This call:
        - Reconciles PR statuses via `check-prs`
        - Polls the WIP gate every 60s, waiting up to 30 min for a slot
        - Picks the highest-scored open cluster
        - Creates the worktree on a fresh branch
        - Returns `next_club` with `id`, `worktree_path`, `branch`, `files[]`,
          `combined_prompt`, and per-issue prompts
      - Termination handling:
        - `status: queue_empty` → break out of loop, jump to step 4
        - `status: wip_full_timeout` → break out of loop, jump to step 4 with
          a note that 3 PRs are still in flight
        - `status: error` → break out of loop, report and jump to step 4
        - `status: ready` → continue to step (b)

   b. **Edit.** Operate exclusively inside `next_club.worktree_path`. Read
      `combined_prompt` (the batch prompt) and `next_club.issues[]` (each with
      its own per-issue prompt). Edit ONLY the files listed in
      `next_club.files`. Apply the code-quality fixes described in the prompts.

   c. `autofix-hub gate <next_club.id>`
      - exit 0 → continue to step (d)
      - exit 2 → read `results[].stderr` from the JSON, make ONE more attempt
        fixing the gate errors. Re-run gate. Still fails → step (f).

   d. `autofix-hub commit <next_club.id>`
      - `status: ok` → capture `pr_url`, continue to step (e)
      - `status: refused` (blocklist) → step (f) with reason `blocklist`
      - `status: error` → step (f) with the error message

   e. Worktree is left in place; the next iteration's `next-club` will create
      a fresh one for a different cluster. Loop back to step (a).

   f. **Abandon:** `autofix-hub abandon <next_club.id> --reason "<short>"`.
      Loop back to step (a).

3. (Implicit — covered by the loop's termination conditions.)

4. **Summarize.** Run:
   `autofix-hub summarize --post github-issue --end`
   Report `posted_issue_url` and the totals. If the loop exited on
   `wip_full_timeout`, list the still-open PR URLs from the last `next-club`
   response so the user knows what's holding the queue.

## What success looks like

- N PRs opened during the run, each labeled `autofix`, each with the
  configured gate (lint/typecheck/build) passing locally.
- Never more than 3 `autofix`-labeled PRs open at once.
- A GitHub issue summarizing the session.
- All worktrees that hit a PR are tracked in the DB; abandoned ones are
  cleaned up.
- No files modified outside the per-cluster worktrees.

## Tuning

- `--poll-seconds <n>` on `next-club` — how often to re-check the WIP gate
  while waiting. Default 60s. Lower if you expect fast review/merge cadence.
- `--max-wait-minutes <n>` — total wait per iteration. Default 30. The loop
  exits cleanly on timeout rather than hanging forever.
- The 3-PR cap and the `autofix` / `autofix-reviewed` labels live in
  `.autofix-hub/config.json` under `wip`. Edit there to change.

## Recovery

If the workflow is killed mid-edit:
- Worktree and branch persist on disk.
- Run `/autofix-hub-sonarqube` again — `check-prs` reconciles any PRs that did
  get opened, and the loop will pick up from the next available cluster.
- To clean a stuck cluster manually:
  `autofix-hub abandon <club_id> --reason "killed mid-run"`
