# SonarQube Fix Guide

Scanner-specific guidance for applying AI-generated fixes to SonarQube code quality issues.

## Categories & Fix Patterns

### Bugs
- Analyze the reported bug and understand the root cause
- Fix the logic error with a minimal change
- Add null checks or boundary checks if caused by missing guards
- Handle edge cases: off-by-one errors, resource leaks, incorrect conditions

### Vulnerabilities
- Identify the vulnerability type (OWASP category)
- Apply standard remediation for the vulnerability class
- Parameterized queries for SQL injection, output encoding for XSS
- Proper auth checks, secure crypto usage
- Do not introduce new security controls — fix the existing vulnerability

### Security Hotspots
- Review the flagged code for security implications
- If insecure: replace with the secure alternative (strong hashing, no hardcoded credentials, input validation)
- If intentional and safe: add a comment explaining why
- Follow security best practices for the framework in use

### Code Smells
- Refactor as suggested by the SonarQube rule
- Apply the minimal refactoring that resolves the issue
- Maintain existing behavior — quality fix, not a feature change
- Extract methods, reduce complexity, fix naming, remove dead code as needed

## Review Levels
- `quick`: INFO-level code smells — trivial fixes that may be auto-approved
- `careful`: MINOR/MAJOR code smells and minor bugs — need a human glance
- `security_review`: Vulnerabilities, security hotspots, BLOCKER/CRITICAL bugs — require careful manual review

## General Rules
- Minimal change that resolves the issue
- Follow existing code style and patterns
- Fix only the targeted issue — do not restructure surrounding code
