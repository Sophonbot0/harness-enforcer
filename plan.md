# Plan: Harness Planner Q&A + Plugin Test + GitHub Repo

## User Request (verbatim)
"E o planner deve fazer perguntas se as tiver antes de construir o plano. Altera tudo isso usa o harness. Depois aplica o pluggin faz um test simples para ver se ele funciona e depois cria um novo reparo no GitHub (sophonbot0) e faz push deste projeto"

## Extracted Requirements
1. [Explicit] Planner must ask clarifying questions before building the plan (if it has questions)
2. [Explicit] Update the harness skill/prompts to support Q&A flow
3. [Explicit] Apply/install the harness-enforcer plugin (make it loadable by OpenClaw)
4. [Explicit] Run a simple test to verify the plugin works
5. [Explicit] Create a new GitHub repo under sophonbot0
6. [Explicit] Push the harness-enforcer project to that repo
7. [Implicit] The planner Q&A should not block if there are no questions (proceed directly)
8. [Implicit] The Q&A should be practical — planner asks the orchestrator, who relays to the user if needed
9. [Implicit] The plugin test should verify all 4 tools work (start, checkpoint, submit, status)
10. [Implicit] The GitHub repo needs proper README, .gitignore, license

## Context
- Plugin code exists at `/Users/jbelo/.openclaw/extensions/harness-enforcer/`
- Skill exists at `/Users/jbelo/.openclaw/skills/harness/`
- Planner prompt at `prompts/planner-system.md` currently says "do NOT ask questions"
- Plugin has 4 tools: harness_start, harness_checkpoint, harness_submit, harness_status
- GitHub account: Sophonbot0
- Plugin passed eval with all DoD items ✅

## Features

### Feature 1: Planner Q&A Flow
- **Description:** Update planner prompt and SKILL.md so the planner can ask clarifying questions before writing the plan. The orchestrator receives the questions, relays to the owner, and re-launches the planner with answers.
- **Covers requirements:** #1, #2, #7, #8
- **DoD:**
  - [ ] planner-system.md allows asking questions when requirements are ambiguous
  - [ ] planner-system.md defines a clear output format for questions (separate from plan output)
  - [ ] planner-system.md says to proceed directly if no questions are needed
  - [ ] SKILL.md documents the Q&A flow: planner outputs questions → orchestrator relays → planner re-runs with answers
  - [ ] SKILL.md has a max-questions limit (e.g., 1 round of questions to avoid infinite Q&A loops)
- **Dependencies:** None

### Feature 2: Plugin Smoke Test
- **Description:** Run a functional test of all 4 harness-enforcer tools to verify the plugin loads and works.
- **Covers requirements:** #3, #4, #9
- **DoD:**
  - [ ] Plugin can be loaded without errors (import index.ts succeeds)
  - [ ] harness_start creates a run directory and returns a runId
  - [ ] harness_checkpoint saves progress and returns checkpoint data
  - [ ] harness_status returns run information
  - [ ] harness_submit rejects when eval report is missing/failing (quality gate works)
  - [ ] All state files (run-state.json, checkpoints.jsonl, dod-items.json) are created correctly on disk
- **Dependencies:** None

### Feature 3: GitHub Repository
- **Description:** Create a new repo `harness-enforcer` under Sophonbot0, add README and .gitignore, push all code.
- **Covers requirements:** #5, #6, #10
- **DoD:**
  - [ ] Repo `Sophonbot0/harness-enforcer` exists on GitHub
  - [ ] README.md exists with project description, tool list, install instructions
  - [ ] .gitignore excludes node_modules, dist, .DS_Store
  - [ ] All source files pushed (index.ts, src/*, openclaw.plugin.json, package.json, tsconfig.json)
  - [ ] Repo is accessible at https://github.com/Sophonbot0/harness-enforcer
- **Dependencies:** Feature 2 (push after test passes)

## Requirements Coverage Matrix
| Requirement | Covered by Feature(s) | DoD items |
|---|---|---|
| #1 Planner asks questions | Feature 1 | 1.1, 1.2, 1.3 |
| #2 Update harness skill/prompts | Feature 1 | 1.4, 1.5 |
| #3 Apply/install plugin | Feature 2 | 2.1 |
| #4 Simple test | Feature 2 | 2.1-2.6 |
| #5 Create GitHub repo | Feature 3 | 3.1, 3.5 |
| #6 Push project | Feature 3 | 3.4 |
| #7 No block if no questions | Feature 1 | 1.3 |
| #8 Practical Q&A flow | Feature 1 | 1.4, 1.5 |
| #9 Test all 4 tools | Feature 2 | 2.2-2.5 |
| #10 README, .gitignore | Feature 3 | 3.2, 3.3 |

## Completeness Check
- [x] Every explicit requirement has at least one DoD item
- [x] Every implicit requirement has at least one DoD item
- [x] Every feature has error path DoD items
- [x] No requirement is uncovered in the matrix

## Technical Notes
- For the plugin test: create a temp dir, mock a plan.md, call each tool function directly
- For GitHub: use `gh repo create` CLI
- Planner Q&A: output format should be clearly distinguishable (e.g., `## Questions` section vs `## Features` section)

## Out of Scope
- Automated test suite (vitest/jest) — just a manual smoke test
- CI/CD pipeline for the repo
- Plugin hooks/services (v2 features)
