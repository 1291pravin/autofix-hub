# Apiiro Fix Guide

Scanner-specific guidance for applying AI-generated fixes to Apiiro security issues.

## Categories & Fix Patterns

### Secrets
- Remove the hardcoded secret/credential from source code
- Replace with an environment variable reference (e.g., `process.env.SECRET_NAME`)
- Add the variable name to `.env.example` with a placeholder value
- Note: the actual secret needs to be rotated — this fix only removes it from code
- Ensure the secret is not committed anywhere in git history

### SCA (Dependency Vulnerabilities)
- Bump the vulnerable dependency to the patched version
- Check the dependency's changelog for breaking changes
- If a major version bump: review migration guide and update usage accordingly
- Run tests to verify no regressions

### SAST — Injection
- Use parameterized queries instead of string concatenation for SQL/NoSQL
- Apply proper input sanitization and validation
- Use prepared statements or ORM methods
- Do not bypass security controls — fix the root cause

### SAST — XSS
- Apply proper output encoding/escaping for the context (HTML, JS, URL, CSS)
- Use framework-provided sanitization (e.g., React auto-escapes JSX)
- Avoid `dangerouslySetInnerHTML`, `innerHTML`, or `eval()` with user input
- Validate and sanitize input at the boundary

### Misconfiguration
- Fix the insecure default or misconfigured setting
- Apply secure defaults (e.g., enable HTTPS, disable debug mode, set secure headers)
- Follow security best practices for the framework/platform in use

### PII Exposure
- Remove or mask personally identifiable information from logs, responses, or storage
- Use encryption or hashing where PII must be stored
- Ensure PII is not exposed in error messages or API responses

## Review Levels
- All Apiiro issues require `security_review` or `careful` review level
- Secrets, injection, PII, supply chain → always `security_review`
- SCA minor bumps → `careful`
- Everything else (SCA major, XSS, misconfiguration) → `security_review`

## General Rules
- Fix only the targeted issue — do not touch unrelated code
- Follow existing code patterns and style
- Minimal change that addresses the vulnerability
