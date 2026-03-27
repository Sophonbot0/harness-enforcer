# Plan: Add harness_reset Tool

## User Request (verbatim)
"Add a harness_reset tool that cancels the active run and resets state, allowing a fresh start without manually deleting files."

## Extracted Requirements
1. [Explicit] A new tool called `harness_reset` must be added to the plugin
2. [Explicit] The tool must cancel the currently active run
3. [Explicit] The tool must reset state so the user can start fresh
4. [Explicit] The user should not need to manually delete files on disk
5. [Implicit] The tool must be registered in `index.ts` alongside the existing 4 tools
6. [Implicit] The tool must follow the same patterns as existing tools (jsonResult, error handling, validation, locking)
7. [Implicit] If no active run exists, the tool should return a clear message (not crash)
8. [Implicit] The run state should be marked with a terminal status (not just deleted) to preserve history/auditability
9. [Implicit] The tool should appear in `harness_status` recent runs after reset (cancelled status visible)
10. [Implicit] The smoke test (`test-smoke.ts`) should be updated to cover the new tool
11. [Implicit] README.md should document the new tool in the tool table

## Context
- Plugin lives at `/Users/jbelo/.openclaw/extensions/harness-enforcer/`
- 4 existing tools: `harness_start`, `harness_checkpoint`, `harness_submit`, `harness_status`
- Tools are created in `src/tools.ts` and registered in `index.ts`
- Run state is persisted as JSON files in `~/.openclaw/harness-enforcer/runs/{runId}/`
- `RunState` has a `status` field: `"active" | "completed" | "failed"` (defined in `src/state.ts`)
- `findActiveRun()` scans run dirs for `status === "active"`
- `harness_start` rejects if an active run exists — this is the pain point the reset tool solves
- In-memory locks via `withLock()` protect concurrent state mutations
- All tools use `jsonResult()` for structured output and try-catch for error wrapping

## Features

### Feature 1: harness_reset Tool Implementation
- **Description:** Create a new `createHarnessResetTool(runsDir)` function in `src/tools.ts` that finds the active run, marks it as cancelled, and returns confirmation. The tool takes an optional `reason` parameter so the user can document why the run was cancelled.
- **Covers requirements:** #1, #2, #3, #4, #6, #7, #8
- **DoD:**
  - [x] `createHarnessResetTool` function exists in `src/tools.ts`
  - [x] Tool name is `harness_reset` with label "Harness Reset"
  - [x] Tool has an optional `reason` parameter (string) for documenting why the run was cancelled
  - [x] Tool finds the active run using `state.findActiveRun(runsDir)`
  - [x] If no active run exists, returns a clear message (not an error/crash): `{ message: "No active harness run to reset." }`
  - [x] If an active run exists, sets `runState.status` to `"cancelled"` and writes updated state using `state.writeRunState()` within `state.withLock()`
  - [x] Returns structured result with `{ success: true, runId, cancelledAt, reason, elapsed }`
  - [x] Entire execute body wrapped in try-catch returning `jsonResult({ error: ... })` on failure
- **Dependencies:** Feature 2 (needs `"cancelled"` status type)

### Feature 2: State Type Update for Cancelled Status
- **Description:** Extend the `RunState.status` union type in `src/state.ts` to include `"cancelled"` so the reset tool can mark runs without abusing `"failed"`.
- **Covers requirements:** #8, #9
- **DoD:**
  - [x] `RunState.status` type in `src/state.ts` is updated from `"active" | "completed" | "failed"` to `"active" | "completed" | "failed" | "cancelled"`
  - [x] `findActiveRun` still only matches `status === "active"` (no change needed — already correct)
  - [x] `listCompletedRuns` is NOT affected (it filters `status === "completed"` — cancelled runs are excluded, which is correct)
- **Dependencies:** None

### Feature 3: Plugin Registration
- **Description:** Import and register the new tool in `index.ts` so OpenClaw discovers it.
- **Covers requirements:** #5
- **DoD:**
  - [x] `createHarnessResetTool` is imported in `index.ts`
  - [x] `api.registerTool(() => createHarnessResetTool(runsDir))` is called in the `register()` function
- **Dependencies:** Feature 1

### Feature 4: Smoke Test Coverage
- **Description:** Add test cases to `test-smoke.ts` that exercise the reset tool: reset with no active run, reset an active run, and verify that `harness_start` succeeds after a reset.
- **Covers requirements:** #10
- **DoD:**
  - [x] Test case: calling `harness_reset` when no run is active returns a message (not an error)
  - [x] Test case: start a run, then call `harness_reset` — returns `success: true` with the cancelled runId
  - [x] Test case: after reset, `harness_start` succeeds (proving the active-run lock is cleared)
  - [x] Test case: after reset, `harness_status` shows the cancelled run with `status: "cancelled"`
  - [x] All existing tests still pass (no regressions)
- **Dependencies:** Features 1, 2, 3

### Feature 5: Documentation Update
- **Description:** Update README.md to include `harness_reset` in the tool table and add a brief description.
- **Covers requirements:** #11
- **DoD:**
  - [x] README.md tool table includes a row for `harness_reset` with purpose description
  - [x] Description mentions: cancels the active run, marks it as cancelled, allows a fresh `harness_start`
- **Dependencies:** Feature 1

## Requirements Coverage Matrix
| Requirement | Covered by Feature(s) | DoD items |
|---|---|---|
| #1 New harness_reset tool | Feature 1 | 1.1, 1.2 |
| #2 Cancel active run | Feature 1 | 1.4, 1.6 |
| #3 Reset state for fresh start | Feature 1 | 1.6, 1.7 |
| #4 No manual file deletion | Feature 1 | 1.6 |
| #5 Register in index.ts | Feature 3 | 3.1, 3.2 |
| #6 Follow existing patterns | Feature 1 | 1.3, 1.7, 1.8 |
| #7 Handle no active run gracefully | Feature 1 | 1.5 |
| #8 Terminal status (not delete) | Feature 1, Feature 2 | 1.6, 2.1 |
| #9 Visible in status after reset | Feature 2 | 2.2, 2.3 |
| #10 Smoke test coverage | Feature 4 | 4.1–4.5 |
| #11 README documentation | Feature 5 | 5.1, 5.2 |

## Completeness Check
- [x] Every explicit requirement has at least one DoD item
- [x] Every implicit requirement has at least one DoD item
- [x] Every feature has error path DoD items (Feature 1: 1.5, 1.8)
- [x] No requirement is uncovered in the matrix

## Technical Notes
- The `"cancelled"` status is preferred over deleting the run directory — it preserves audit history and is consistent with how `"completed"` and `"failed"` work
- The reset tool must use `withLock()` for the state mutation to prevent race conditions (same pattern as checkpoint/submit)
- The `reason` parameter is optional — if omitted, a default like `"Manual reset"` should be used
- `findActiveRun()` already filters on `status === "active"`, so marking a run as `"cancelled"` automatically unblocks `harness_start` without any changes to start logic
- The cancelled run won't appear in `listCompletedRuns` (which filters on `"completed"`), but it WILL appear in `findMostRecentRun` (which accepts any status) — this is desirable for `harness_status` visibility

## Out of Scope
- Force-reset that deletes run files from disk (current approach preserves history)
- Batch reset of multiple runs
- Undo/resume a cancelled run
- GitHub push (separate task)
