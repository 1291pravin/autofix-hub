---
description: Fire-and-forget autofix run for AQA (accessibility) issues
---

# /aqa-fix

Run autofix-hub end-to-end for AQA: scan, club, fix, gate, commit, summarize.
Fire and forget. Each club becomes one PR.

## Rules (never break)

- Do NOT touch any path that `autofix-hub commit` refuses (blocklist enforced by the CLI).
- Do NOT summarize between clubs. After each commit/abandon, immediately continue.
- Edit ONLY the files listed in the club. No refactoring, no drive-by changes.
- Gate fail → ONE retry with the error output → else abandon.
- Stop when `issues` returns zero clubs, or WIP is full, or the returned set is exhausted.

## Steps

1. `autofix-hub aqa run --check-wip` → read `capacity`; if `wip_full`, stop.
2. `autofix-hub aqa fetch --json` → refresh issues.
3. `autofix-hub aqa issues --capacity <capacity>` → capture `session_id` and `clubs[]`.
   If `clubs_count == 0`, skip to step 5.
4. For each club (in score order):
   a. `autofix-hub worktree create <club.id>` → cd into `worktree_path`.
   b. Apply fixes using `club.combined_prompt` + per-issue prompts. Only edit `club.files[]`.
   c. `autofix-hub gate <club.id>`: pass → (d); fail → one retry → still fail → (f).
   d. `autofix-hub commit <club.id>`: ok → capture `pr_url` → (e); refused/error → (f).
   e. `autofix-hub worktree destroy <club.id>`. Next club.
   f. `autofix-hub abandon <club.id> --reason "<short>"`. Next club.
5. `autofix-hub summarize --session <session_id> --post github-issue --end`.
