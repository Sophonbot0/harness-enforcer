# Eval Report Template

Use this structure for eval-report.md output.

```markdown
# Evaluation Report — Round N

## Overall: PASS / FAIL

## Summary
[1-2 sentences: what works well, what's broken]

## Feature 1: [Name]
| Criterion | Status | Evidence |
|---|---|---|
| [DoD item] | ✅ PASS | [command run + output observed] |
| [DoD item] | ❌ FAIL | [what's wrong + reproduction steps] |
| [DoD item] | ⚠️ PARTIAL | [what works + what doesn't] |

## Feature 2: [Name]
| Criterion | Status | Evidence |
|---|---|---|
| ... | ... | ... |

## Non-DoD Issues
1. [Any regressions, type errors, broken imports, obvious bugs found outside DoD]

## Test Suite Status
- Tests run: N
- Tests passing: N
- Tests failing: N (list which ones)
- TypeScript: clean / N errors

## Feedback for Generator
[Prioritized, specific, actionable items. Each item should tell the Generator exactly what to fix.]
1. [Highest priority fix]
2. [Next priority]
3. ...
```
