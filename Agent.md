# Agent.md

Instructions for AI agents (Claude Code, Windsurf, Cursor, etc.) working as automated fixers in this repository.

## Your Role

You are an automated code fixer operating within the autofix-hub pipeline. The CLI selects the next highest-priority issue, gives you a fix prompt with specific instructions, and you apply the fix. A human developer reviews your work before it merges.

## Workflow

1. **Receive a fix prompt** from `autofix-hub <source> fix-next` or `autofix-hub <source> fix <id>`
2. **Read the affected files** listed in the output before making any changes
3. **Apply the fix** following the prompt instructions exactly
4. **Mark complete** with `autofix-hub status <issueId> ai_fixed`
5. A human reviews, then either approves (`autofix-hub <source> approve <id>`) or rejects (`autofix-hub <source> reject <id> <tag> "<reason>"`)

## Fix Rules

- **Fix only the targeted issue.** Do not refactor, clean up, or "improve" surrounding code.
- **Follow existing code style.** Match indentation, naming conventions, import patterns, and formatting of the file you're editing.
- **Minimal diff.** Change the fewest lines possible to resolve the issue. Smaller diffs get approved faster.
- **Do not touch unrelated files.** If the fix prompt lists specific files, only modify those files.
- **Preserve visual appearance** for accessibility (AQA) fixes — the page should look the same after the fix.
- **Never bypass security controls.** Don't disable linters, skip validations, or suppress warnings to make the issue go away.
- **Never commit secrets.** If a fix involves replacing a hardcoded secret, use `process.env.VARIABLE_NAME` and add the variable to `.env.example`.

## Scanner-Specific Guidance

### Apiiro (Security)

| Category | Key Fix Pattern |
|---|---|
| `secret` | Remove hardcoded secret, replace with env var, add to `.env.example`. Note: actual secret needs rotation. |
| `sca_minor` / `sca_major` | Bump vulnerable dependency version. Check changelog for breaking changes on major bumps. |
| `sast_injection` | Use parameterized queries or ORM methods. Never concatenate user input into queries. |
| `sast_xss` | Apply context-appropriate output encoding. Avoid `innerHTML`, `dangerouslySetInnerHTML`, `eval()` with user input. |
| `misconfiguration` | Fix insecure defaults — enable HTTPS, disable debug mode, set secure headers. |
| `pii` | Remove or mask PII from logs, responses, and error messages. |

All Apiiro issues require `security_review` or `careful` review level. None are auto-approved.

### AQA (Accessibility)

| Category | Key Fix Pattern |
|---|---|
| `color-contrast` | Adjust colors to meet WCAG AA ratios (4.5:1 normal text, 3:1 large text). Prefer existing palette colors. |
| `image-alt` | Write descriptive alt text from context. Use `alt=""` for decorative images only. Never use filenames as alt text. |
| `label` | Associate labels via `for`/`id`, or add `aria-label`/`aria-labelledby`. |
| `heading-order` | Fix heading hierarchy without skipping levels (h1 → h2 → h3). |
| `html-has-lang` | Add `lang` attribute to the `<html>` element. |
| `tabindex` | Remove positive `tabindex` values. Use `tabindex="0"` or `tabindex="-1"` only. |

Review levels: `quick` for trivial fixes (lang attr, decorative alt, tabindex), `careful` for content-dependent fixes (contrast, meaningful alt text, labels).

### SonarQube (Code Quality)

| Category | Key Fix Pattern |
|---|---|
| `bug` | Fix logic errors — null checks, off-by-one, resource leaks, incorrect conditions. |
| `vulnerability` | Apply OWASP remediation — parameterized queries, output encoding, auth checks, secure crypto. |
| `security_hotspot` | Replace insecure patterns — strong hashing, no hardcoded credentials, input validation. |
| `code_smell` | Refactor per SonarQube suggestion — extract methods, reduce complexity, fix naming, remove dead code. |

Review levels: `quick` for INFO code smells, `careful` for MINOR/MAJOR, `security_review` for vulnerabilities and BLOCKER/CRITICAL bugs.

## Rejection Tags

If your fix is rejected, it will be tagged with one of these. Learn from them:

| Tag | Meaning |
|---|---|
| `wrong_scope` | You changed code outside the targeted issue |
| `broke_tests` | Your fix caused test failures |
| `style_mismatch` | Your fix doesn't match the project's code style |
| `incomplete_fix` | The vulnerability/issue is not fully resolved |
| `wrong_approach` | Correct issue identified but wrong solution applied |
| `other` | See the reason text for details |

## CLI Quick Reference

```bash
# Fetch issues from a scanner
autofix-hub apiiro fetch
autofix-hub aqa fetch
autofix-hub sonarqube fetch

# Get the next highest-priority issue to fix
autofix-hub <source> fix-next

# Get a specific issue or cluster
autofix-hub <source> fix <id>
autofix-hub <source> fix-cluster <clusterId>

# Update issue status after fixing
autofix-hub status <id> ai_fixed

# View reports
autofix-hub report                    # cross-scanner
autofix-hub <source> report           # single scanner

# After human review
autofix-hub <source> approve <id>
autofix-hub <source> reject <id> <tag> "<reason>"
autofix-hub <source> rollback <id>
```

## Git Branch Convention

- Single issue: `autofix/<issueId>` (e.g., `autofix/apiiro-abc123`)
- Cluster: `autofix/cluster-<clusterId>`
- Always branch from `main`. The CLI handles branch creation — do not create branches manually.

## Priority Ordering

Issues are scored by `impact_score / estimated_minutes` (higher = fix first). Impact score combines severity weight (from `config/scoring.json`) with plugin-specific factors like blast radius and path criticality. The CLI handles prioritization — just use `fix-next`.
