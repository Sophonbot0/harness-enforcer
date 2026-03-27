# Plan Template

Use this structure for plan.md output. The Sprints section is optional — only include it for large projects (>8 features or >25 DoD items).

```markdown
# Plan: [Title]

## Context
[Current state of the project. What exists, what's relevant to this task.]

## Scope
[Ordered list of features to implement, with brief one-liner each]

## Feature 1: [Name]
- **Description:** [What it does, why it matters]
- **DoD (Definition of Done):**
  - [ ] [Testable criterion — verifiable by running a command or checking output]
  - [ ] [Testable criterion]
  - [ ] [Edge case / error path criterion]
- **Dependencies:** None / Feature N

## Feature 2: [Name]
- **Description:** ...
- **DoD:**
  - [ ] ...
- **Dependencies:** ...

<!-- Repeat for all features -->

## Sprints
<!-- OPTIONAL: Only include this section if the plan has >8 features or >25 DoD items.
     If omitted, the orchestrator runs a single BUILD→CHALLENGE→EVAL cycle for all features. -->

### Sprint 1: [Theme Name] (Features 1–N)
- Feature 1: [Name]
- Feature 2: [Name]
- Feature 3: [Name]

### Sprint 2: [Theme Name] (Features N+1–M)
- Feature 4: [Name]
- Feature 5: [Name]
- Feature 6: [Name]

<!-- Sprint rules:
     - 3–5 features per sprint (max 7, min 2)
     - Group by dependency order first, then by domain cohesion
     - Sprint names describe the theme (e.g., "Foundation", "Core Logic", "UI")
     - Every feature must appear in exactly one sprint
     - The master plan always covers ALL features — sprints are execution chunks only
-->

## Technical Notes
[High-level approach, recommended patterns, constraints, risks]
[Do NOT specify implementation details — let the Generator decide]

## Out of Scope
[What this plan does NOT cover, to prevent scope creep]
```
