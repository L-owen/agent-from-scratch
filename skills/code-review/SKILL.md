---
name: code-review
description: Review code for bugs, security issues, style violations, and performance problems.
---

# Code Review Skill

## Overview

This skill guides the agent through a systematic code review process, checking for bugs, security issues, style violations, and performance problems.

## Review Checklist

### 1. Correctness
- Does the code do what it claims to do?
- Are edge cases handled?
- Are there off-by-one errors or incorrect conditions?

### 2. Security
- SQL injection, XSS, command injection
- Hardcoded secrets or credentials
- Improper input validation
- Path traversal vulnerabilities

### 3. Performance
- Unnecessary loops or redundant computations
- Missing indexes for database queries
- Memory leaks or unbounded growth

### 4. Style & Maintainability
- Clear variable and function names
- Appropriate comments (why, not what)
- Consistent formatting
- No dead code or unused imports

## Output Format

For each issue found, report:
- **File and line number**
- **Severity**: critical / warning / suggestion
- **Description**: what's wrong and why
- **Fix**: suggested code change
