---
description: Fire-and-forget autofix run for SonarQube code quality issues
---

# /sonar-fix

Run autofix-hub end-to-end for SonarQube: scan, club, fix, gate, commit, summarize.
Fire and forget. Each club becomes one PR.

## Rules (never break)

- Do NOT touch any path that `autofix-hub commit` refuses (blocklist enforced).
- Do NOT summarize between clubs.
- Edit ONLY files listed in the club.
- Gate fail → ONE retry → else abandon.
- Stop on empty clubs, WIP full, or exhaustion of the returned set.

## Steps

1. `autofix-hub sonarqube run --check-wip` → read `capacity`; if `wip_full`, stop.
2. `autofix-hub sonarqube fetch --json` → refresh issues.
3. `autofix-hub sonarqube issues --capacity <capacity>` → capture `session_id` and `clubs[]`.
   If `clubs_count == 0`, skip to step 5.
4. For each club:
   a. `autofix-hub worktree create <club.id>` → cd into `worktree_path`.
   b. Apply fixes from `club.combined_prompt`. Only edit `club.files[]`.
   c. `autofix-hub gate <club.id>`: pass → (d); fail → one retry → still fail → (f).
   d. `autofix-hub commit <club.id>`: ok → (e); refused/error → (f).
   e. `autofix-hub worktree destroy <club.id>`. Next club.
   f. `autofix-hub abandon <club.id> --reason "<short>"`. Next club.
5. `autofix-hub summarize --session <session_id> --post github-issue --end`.
