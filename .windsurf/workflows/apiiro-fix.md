---
description: Fire-and-forget autofix run for Apiiro security issues
---

# /apiiro-fix

Run autofix-hub end-to-end for Apiiro: scan, club, fix, gate, commit, summarize.
Fire and forget. Each club becomes one PR.

## Rules (never break)

- Do NOT touch any path that `autofix-hub commit` refuses (blocklist enforced by the CLI).
- Do NOT summarize between clubs. After each commit/abandon, immediately continue to the next.
- Do NOT edit files outside the club's worktree path.
- Edit ONLY the files listed in the club. No refactoring, no "while we're here" cleanup.
- If gate fails, you get ONE retry with the error output. Still fails → abandon.
- Stop when `issues` returns zero clubs, or when WIP is full, or after finishing the returned set.

## Steps

1. **WIP check.** Run `autofix-hub apiiro run --check-wip`.
   - If `status == "wip_full"`, stop. Report the open PR URLs and exit.
   - Otherwise note the `capacity` number.

2. **Scan.** Run `autofix-hub apiiro fetch --json` to refresh issues from the scanner.

3. **Get clubs.** Run `autofix-hub apiiro issues --capacity <capacity-from-step-1>`.
   - Capture `session_id` and the `clubs[]` array.
   - If `clubs_count == 0`, jump to step 5 (summarize) and exit.

4. **Execute each club in score order** (already sorted). For each club:

   a. `autofix-hub worktree create <club.id>` → capture `worktree_path`.

   b. Read `club.combined_prompt` (the batch prompt) and `club.issues[]` (each with per-issue prompt).
      Change directory to `worktree_path`. Edit ONLY `club.files[]`. Apply the fixes described
      in the prompts. Touch nothing else.

   c. `autofix-hub gate <club.id>`:
      - exit 0 (pass) → step (d)
      - exit 2 (fail) → read `results[].stderr`, make ONE more attempt fixing the errors.
        Re-run gate. If still fail → step (f).

   d. `autofix-hub commit <club.id>`:
      - `status == "ok"` → capture `pr_url`, continue.
      - `status == "refused"` (blocklist) → go to step (f) with reason "blocklist".
      - `status == "error"` → go to step (f) with the error message as reason.

   e. `autofix-hub worktree destroy <club.id>`. Move to next club.

   f. **Abandon:** `autofix-hub abandon <club.id> --reason "<short summary>"`. Move to next club.

5. **Summarize.** Run:
   `autofix-hub summarize --session <session_id> --post github-issue --end`
   Report the returned `posted_issue_url` and the totals.

## What success looks like

- N PRs opened, each labeled `autofix`, each with tests/build passing locally.
- A GitHub issue summarizing the session.
- All worktrees cleaned up.
- No files modified outside the worktrees.
