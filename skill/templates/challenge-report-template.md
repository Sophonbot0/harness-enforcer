# Challenge Report Template

Use this structure for challenge-report.md output.

```markdown
# Challenge Report — Round N

## Overall Confidence Assessment

**Confidence Rating: X/5**

| Rating | Meaning |
|---|---|
| 1/5 | Fundamentally broken — multiple critical issues, unlikely to pass evaluation |
| 2/5 | Significant gaps — major issues that will cause failures |
| 3/5 | Partially solid — works on happy path, but untested assumptions and edge case gaps |
| 4/5 | Mostly sound — minor issues, well-tested, few gaps |
| 5/5 | High confidence — thoroughly implemented, edge cases handled, evidence of quality |

**Rationale:** [1-2 sentences explaining the rating]

## Challenges

### Challenge 1: [Title] — CRITICAL / MAJOR / MINOR
- **Category:** Overconfidence / Untested Assumption / Missing Edge Case / Happy-Path Bias / Scope Gap
- **Feature:** [Which plan.md feature this relates to]
- **What I found:** [Specific description of the issue]
- **Evidence:** [Command run, output observed, or code reference with explanation]
- **Likelihood × Impact:** [High/Medium/Low] × [High/Medium/Low]

### Challenge 2: [Title] — CRITICAL / MAJOR / MINOR
...

### Challenge N: [Title] — CRITICAL / MAJOR / MINOR
...

## Overconfidence Flags

Areas where the Generator claimed success without sufficient proof:

1. [Generator claimed X works, but no test exercises this path]
2. [Generator committed without running Y]
3. ...

## Weakest Points

The top 3 areas most likely to fail during evaluation:

1. **[Area]:** [Why this is weak — specific evidence]
2. **[Area]:** [Why this is weak — specific evidence]
3. **[Area]:** [Why this is weak — specific evidence]

## Demands for Evidence

Specific tests and checks the Evaluator MUST run to verify the implementation:

1. [ ] [Specific test: run X command, expect Y output]
2. [ ] [Specific test: call API with Z input, verify response]
3. [ ] [Specific test: check that edge case A is handled]
4. [ ] [Specific test: verify error path B returns correct status]
5. [ ] ...
```
