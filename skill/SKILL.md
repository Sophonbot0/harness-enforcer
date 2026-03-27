---
name: harness
description: >
  4-agent harness for complex development tasks: Planner → Generator → Adversary → Evaluator.
  Orchestrates a planner agent (expands spec + DoD), a generator agent (implements),
  an adversary agent (devil's advocate), and an evaluator agent (grades against DoD).
  Uses intelligent loop control based on progress, not round limits.
  Triggers: coding tasks, feature implementation, bug fixes, refactors, any dev work.
---

# Harness — Planner → Generator → Adversary → Evaluator

4-agent architecture for quality-driven development. Each agent is a separate subagent with clean context.

## When to use

**Use harness** when:
- Implementing features, bug fixes, refactors
- Any task that touches >2 files or >1 feature
- Any task where quality verification matters

**Skip harness** when:
- Trivial one-line fixes (< 5 min, single file)
- Pure research/reading with no code output
- User explicitly says "quick" or "just do it"

The decision is contextual — evaluate the complexity of what's being asked.

## Workflow

```
PLAN → BUILD → CHALLENGE → EVAL
                              ↓
                         DONE? → ✅ deliver
                         NOT DONE? → BUILD R(n+1) → CHALLENGE → EVAL
                         STUCK? → ⛔ escalate to owner
```

## Phase 1: PLANNER (Critical — Must Not Fail)

The planner is the foundation. If it misses requirements, everything downstream fails.

Spawn subagent with prompt from `prompts/planner-system.md`.

### Planner Q&A Flow

The planner MAY ask clarifying questions before building the plan. The flow is:

```
1. Spawn planner with user request
2. Planner writes plan.md
3. Check plan.md status:
   - Status: AWAITING_ANSWERS → planner has questions
     → Read questions from plan.md
     → Relay questions to the user
     → Wait for answers
     → Re-spawn planner with original request + answers
   - Status: READY → plan is complete, proceed to BUILD
4. Maximum 1 round of Q&A (to prevent infinite loops)
   → If planner asks questions again after receiving answers, proceed with best-effort plan
```

**If planner subagent fails** (empty output, timeout, <30 seconds runtime):
- Do NOT skip planning
- Write the plan yourself as orchestrator
- Read all relevant project files BEFORE writing the plan
- The plan must still follow the full template with DoD items

**Input to planner:**
- User's request (VERBATIM — do not summarise or interpret)
- Project context (README, relevant source files, current state)
- Any constraints
- (Round 2 only) Answers to planner's questions

**Output:** `plan.md` with DoD items for every feature, OR questions if clarification needed.

**Model:** Fast reasoning model (sonnet-class).

**Thinking:** DISABLED — set `thinking: "off"` in sessions_spawn. Claude subagents crash with 400 errors when thinking is enabled because stateless sessions lack the required thinking blocks in message history.

**Timeout:** 25 min

## Phase 2: GENERATOR

Spawn subagent with prompt from `prompts/generator-system.md`.

**Input to generator:**
- `plan.md` from planner
- Access to project filesystem + git
- On rounds >1: `eval-report.md` AND `challenge-report.md` with specific feedback

**Output:** Code changes, commits, summary.

**Model:** Best available (opus-class).

**Thinking:** DISABLED — set `thinking: "off"` in sessions_spawn.

**Timeout:** 45 min

## Phase 3: ADVERSARY

Spawn subagent with prompt from `prompts/adversary-system.md`.

**Input to adversary:**
- `plan.md` (DoD criteria to challenge against)
- All source files (read-only)
- Reference implementations for comparison

**Output:** `challenge-report.md` with severity-classified issues.

**Model:** DIFFERENT model family than Generator. If Generator=opus, use GPT-class. Avoids correlated blind spots.

**Thinking:** DISABLED — set `thinking: "off"` in sessions_spawn.

**Timeout:** 15 min

## Phase 4: EVALUATOR

Spawn subagent with prompt from `prompts/evaluator-system.md`.

**Input to evaluator:**
- `plan.md` (DoD criteria)
- `challenge-report.md` (adversary findings)
- All source files
- Previous eval reports (for progress comparison on R2+)

**Output:** `eval-report.md` with per-DoD-item status and progress delta.

**Model:** Good reasoning model (sonnet/opus-class).

**Thinking:** DISABLED — set `thinking: "off"` in sessions_spawn.

**Timeout:** 20 min

## Intelligent Loop Control

The loop does NOT use round limits. It uses **progress detection**.

### After each EVAL, the orchestrator checks:

1. **All DoD items PASS?** → DONE ✅ — deliver results
2. **Progress since last round?** → Compare DoD pass counts:
   - R(n) had 8/12 PASS, R(n+1) has 11/12 PASS → progress, continue
   - R(n) had 11/12 PASS, R(n+1) has 11/12 PASS → NO progress on the same item
3. **Same item(s) failing repeatedly?** → Track which specific DoD items failed in each round:
   - If item X failed in R1 and R2 with the same root cause → STUCK on item X
   - If item X failed in R1 and R2 with different causes → still trying, continue

### Decision logic:

```
if (all_dod_pass):
    DONE → deliver

if (progress_made):
    continue → BUILD R(n+1) with specific failures list

if (no_progress AND same_items_stuck):
    STUCK → escalate to owner:
    "Owner, estes items estão bloqueados após {n} tentativas:
     - [item]: [razão]. Tentei [approach1] e [approach2].
     Precisas de intervir ou queres que tente uma abordagem diferente?"

if (total_elapsed > 30min):
    TIMEOUT → escalate to owner with current state
```

### What "escalate" means:
- Report to owner with: what works, what's stuck, why it's stuck, what was tried
- Do NOT silently fail or deliver incomplete work
- Do NOT loop again without new input from owner

## Sprint Execution

Sprint mode activates automatically for large projects. The orchestrator detects and runs sprints sequentially.

### Detection

After the planner produces `plan.md`, the orchestrator checks for sprint sections:

1. Read `plan.md`
2. Look for `## Sprints` heading followed by `### Sprint N` subsections
3. If found → sprint mode. If not found → single-cycle mode (existing behavior, no changes).

### Sprint-Mode Flow

```
PLAN (full master plan — all features, all sprints)
│
├─ Sprint 1 ──────────────────────────
│   ├─ BUILD (generator gets: sprint 1 features only + master plan context)
│   │   └─ harness_checkpoint(phase="build", summary="Sprint 1 build...")
│   ├─ CHALLENGE (adversary gets: sprint 1 scope + code)
│   │   └─ harness_checkpoint(phase="challenge", summary="Sprint 1 challenge...")
│   ├─ EVAL (evaluator checks: sprint 1 DoD items only)
│   │   └─ harness_checkpoint(phase="eval", summary="Sprint 1 eval...")
│   ├─ PASS → commit, mark sprint 1 complete
│   └─ FAIL → retry loop (same as single-cycle mode)
│       └─ STUCK → escalate sprint 1 to owner, do NOT proceed to sprint 2
│
├─ Sprint 2 ──────────────────────────
│   ├─ Context briefing from sprint 1 (2–3 sentences + key files)
│   ├─ BUILD → CHALLENGE → EVAL
│   ├─ PASS → commit, mark sprint 2 complete
│   └─ FAIL → retry / escalate
│
├─ ... (repeat for all sprints) ...
│
└─ INTEGRATION EVAL (only if >2 sprints)
    ├─ Adversary: cross-sprint interactions, regressions
    ├─ Evaluator: all DoD items, full test suite
    └─ harness_submit (validates master plan)
```

### Context Handoff Between Sprints

Each sprint's generator starts with a clean context. To bridge sprints, the orchestrator passes a brief summary of each completed sprint:

```markdown
## Prior Sprints Summary

### Sprint 1: Foundation ✅ (completed, 1 round)
Built: Database schema with User/Team/Project models. Authentication middleware using JWT.
Key files: src/models/*.ts, src/middleware/auth.ts

### Sprint 2: Core CRUD ✅ (completed, 2 rounds)
Built: Full CRUD API for users, teams, and projects with validation.
Key files: src/routes/users.ts, src/routes/teams.ts, src/services/validator.ts

## Current Sprint: Sprint 3 — Services
[sprint 3 features and DoD items from the master plan]
```

Rules for context summaries:
- **2–3 sentences per completed sprint** — what was built, not how
- **3–5 key files** — so the generator can read them if needed
- **No full code** — the generator has filesystem access and can read files itself
- Summaries are written by the orchestrator after each sprint's eval passes

### Sprint-Scoped Sub-Plans

For each sprint, the orchestrator composes a sprint-specific plan by:

1. Extracting only the current sprint's features and DoD items from the master plan
2. Prepending the prior sprints summary (context handoff)
3. Passing this scoped plan to the generator/adversary/evaluator instead of the full master plan

This keeps each subagent focused on 3–5 features instead of the entire project.

### Integration Eval

After all sprints complete, if the project had >2 sprints, run a lightweight integration eval:

1. **Skip BUILD** — no new code, just verification
2. **ADVERSARY** runs across all code with the full master plan, focusing on cross-sprint interactions
3. **EVALUATOR** re-checks all DoD items and runs the full test suite
4. If integration eval fails, run a targeted fix cycle (generator gets only the failing items)
5. Final `harness_submit` validates the master plan with all DoD items checked

Skip integration eval when:
- Project has ≤2 sprints
- All features are independent (no cross-feature data flows)

### Progress Bar in Sprint Mode

When rendering the progress bar during sprint mode, pass the sprint parameters:

```
renderProgressBar({
  taskDescription,
  phase,
  completedFeatures,   // only current sprint's features
  pendingFeatures,     // only current sprint's features
  inProgressFeature,
  blockers,
  dodTotal,            // current sprint's DoD count
  dodCompleted,        // current sprint's completed DoD count
  elapsedSeconds,
  sprintCurrent: 2,    // current sprint number (1-indexed)
  sprintTotal: 4,      // total number of sprints
})
```

The renderer will:
- Show "Sprint 2/4" in the header
- Calculate overall progress as: `(completedSprints * 100 + currentSprintProgress) / totalSprints`
- Display sprint status indicators: `✅✅⏳⬜` for completed/active/pending sprints

For `renderFinalStatus`, pass the same sprint params to show the final sprint count in the result.

### Failure and Escalation

- If a sprint fails after retries → escalate that sprint to the owner. Do NOT proceed to the next sprint.
- If a sprint is stuck → report what works, what's stuck, which sprint, and what was tried.
- Completed sprints are never re-run. Their code is committed and on disk.
- If the process crashes mid-sprint, `harness_status` shows the last checkpoint. Resume from there.

## Plugin Integration (harness-enforcer)

When the `harness-enforcer` plugin is loaded, use its tools:

1. **`harness_start`** at pipeline start — registers the run, extracts DoD
2. **`harness_checkpoint`** after each phase — saves progress to disk
3. **`harness_submit`** at the end — quality gate, validates PASS before delivery

The plugin provides enforcement. The skill provides orchestration. Both work together.

## Progress Bar (Telegram live status)

During harness runs, maintain a **single Telegram message** that shows live progress. Update it **at every transition** — not just on checkpoints.

### When to update the progress bar

Edit the progress message at ALL of these moments:

| # | Moment | Phase shown | What changed |
|---|---|---|---|
| 1 | After `harness_start` | `▶plan` | Send initial message, save messageId |
| 2 | Planner subagent spawned | `▶plan` | "Planning..." |
| 3 | Planner subagent completes | `●plan→▶build` | Plan ready, features listed |
| 4 | Generator subagent spawned | `●plan→▶build` | "Building..." |
| 5 | Generator subagent completes | `●plan→●build→▶challenge` | Features completed |
| 6 | Adversary subagent spawned | `●plan→●build→▶challenge` | "Challenging..." |
| 7 | Adversary subagent completes | `●plan→●build→●challenge→▶eval` | Challenges found |
| 8 | Evaluator subagent spawned | `●plan→●build→●challenge→▶eval` | "Evaluating..." |
| 9 | Evaluator subagent completes | All ● or result | PASS/FAIL result |
| 10 | `harness_submit` or `harness_reset` | Final | DELIVERED/FAILED/CANCELLED |

**Minimum 8 updates per harness cycle.** On multi-round runs (eval FAIL → retry), updates happen again for each BUILD→CHALLENGE→EVAL round.

### Flow — Plugin-Assisted Auto-Updates

The plugin now auto-renders the progress bar. Every tool response includes a `progressBar` field with the rendered text.

1. **`harness_start` with `telegramChatId` + `telegramThreadId`:**
   - Returns `progressBar` + `telegramAction: "send"`
   - Agent sends it via `message action=send` and captures `messageId`
   - Agent passes `messageId` to the first `harness_checkpoint` call

2. **Every `harness_checkpoint` call (with `telegramMessageId`):**
   - Returns auto-rendered `progressBar` + `telegramAction: "edit"`
   - Agent edits the message using the returned `progressBar` text and `telegramMessageId`
   - **Call checkpoint at EVERY phase transition** — before and after each subagent spawn/completion

3. **`harness_submit` / `harness_reset`:**
   - Returns `progressBar` with final status (DELIVERED/FAILED/CANCELLED)
   - Agent edits one last time

**The agent's job is simple:** call `harness_checkpoint` frequently, then copy the `progressBar` from the response into a `message action=edit`. The plugin handles all rendering.

### When to call harness_checkpoint

Call `harness_checkpoint` at ALL of these moments:

### Rules

- **One message only** — send once, edit thereafter. Never spam the channel.
- **Save the messageId** — without it, you cannot edit. Store it in memory for the run duration.
- **Update at EVERY phase transition** — not just checkpoints. The user should see progress moving.
- **Best-effort** — if `message edit` fails, continue. Progress bar is informational, never blocks the pipeline.
- **Keep it short** — feature names should be concise. Long names are auto-truncated.

## Grading criteria

Read `references/grading-criteria.md` for domain-specific criteria (code, UI, research).
