# autofix-hub

> This file is a pointer. All detailed documentation lives in `docs/`.

A modular, plugin-based CLI platform that fetches issues from security and accessibility scanners, scores and clusters them by business impact, generates AI fix prompts, manages git branches/PRs, and provides a unified dashboard.

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/PROJECT.md](docs/PROJECT.md) | Architecture, plugin interface, tech stack, DB schema, scanner references |
| [docs/PHASE1_SPEC.md](docs/PHASE1_SPEC.md) | Phase 1 specification — features, CLI commands, dashboard, setup wizard |
| [docs/PHASE2_SPEC.md](docs/PHASE2_SPEC.md) | Phase 2 specification — rejection learning, git-based scoring, cost attribution |
| [docs/PHASE1_PLAN.md](docs/PHASE1_PLAN.md) | Phase 1 implementation plan — step-by-step build order for Claude Code |
| [docs/PHASE2_PLAN.md](docs/PHASE2_PLAN.md) | Phase 2 implementation plan — step-by-step build order for Claude Code |

## Quick Start (after implementation)

```bash
pnpm install
autofix-hub setup                    # interactive setup wizard
autofix-hub apiiro fetch             # fetch security issues
autofix-hub aqa fetch                # fetch accessibility issues
autofix-hub sonarqube fetch          # fetch code quality issues
autofix-hub apiiro fix-next          # get next fix prompt
autofix-hub dashboard                # unified dashboard on localhost:8000
```

## Scanner References

- Apiiro: https://github.com/1291pravin/skills/tree/main/apiiro-fix
- AQA: https://github.com/1291pravin/skills/tree/main/aqa-usablenet
- SonarQube: https://github.com/1291pravin/skills/tree/main/sonarqube-fix
