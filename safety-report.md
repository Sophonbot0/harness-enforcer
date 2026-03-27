# Safety Audit: harness-enforcer

**Auditor:** Adversary / Safety Subagent  
**Date:** 2026-03-27T14:06Z  
**Files reviewed:** `index.ts`, `src/tools.ts`, `src/state.ts`, `src/validation.ts`, `openclaw.plugin.json`, `package.json`, `tsconfig.json`

---

## Verdict: SAFE TO LOAD

The plugin is well-structured, defensively coded, and will not break OpenClaw on load. Two medium-severity design observations are noted below but none are blocking.

---

## Critical Issues

**None found.**

| Check | Result |
|-------|--------|
| 1. Default export shape (`id`, `name`, `register(api)`) | ✅ Correct — `index.ts` exports `{ id: "harness-enforcer", name: "Harness Enforcer", register(api) }` |
| 2. `register()` uses only valid API calls | ✅ Only calls `api.registerTool()` (5 times, all via factory callbacks) |
| 3. Top-level side effects at import time | ✅ None — `index.ts` only imports modules and defines a function/export. No file I/O, network, or mutation at module scope. `state.ts` and `validation.ts` only define functions; the `locks` Map in `state.ts` is an empty in-memory map (no side effect). |
| 4. Missing imports / module resolution | ✅ All imports resolve: `node:fs`, `node:path`, `node:os` are Node builtins; `openclaw/plugin-sdk` is a peer dependency; internal `./src/*.js` imports match actual files. |
| 5. `openclaw.plugin.json` has valid `id` | ✅ `"id": "harness-enforcer"` present and matches `index.ts` export |
| 6. `package.json` conflicts with core | ✅ Only peer dependency is `"openclaw": "*"` — no pinned versions that could conflict. No regular dependencies. |

---

## High Issues

**None found.**

| Check | Result |
|-------|--------|
| 7. Unhandled exceptions propagating to core | ✅ Every `execute()` method wraps its entire body in `try/catch` and returns a structured `jsonResult({ error: ... })` rather than throwing. Errors from `validation.*` and `state.*` are caught. |
| 8. Infinite loops or blocking operations | ⚠️ **Minor note:** All file I/O is synchronous (`readFileSync`, `writeFileSync`, `readdirSync`, `statSync`). This blocks the Node.js event loop during execution. However, the data volumes are tiny (small JSON files, a JSONL of checkpoints) and operations complete in microseconds. **Not a real risk** at the expected scale. |
| 9. File operations corrupting shared OpenClaw state | ✅ The plugin only writes to its own `~/.openclaw/harness-enforcer/runs/<runId>/` directories. It creates: `run-state.json`, `dod-items.json`, `checkpoints.jsonl`, `delivery.json`. These are fully isolated from OpenClaw core state. |
| 10. Writes outside `~/.openclaw/harness-enforcer/` | ✅ By default, all writes go to `~/.openclaw/harness-enforcer/runs/`. The `sanitizePath` function in `validation.ts` restricts user-supplied paths (planPath, evalReportPath) to under `~/.openclaw/`. **See Medium #1 below for a nuance on configurable `runsDir`.** |

---

## Medium Issues

### 1. Configurable `runsDir` is not validated against a path allowlist

**Risk:** The `resolveRunsDir()` function in `index.ts` accepts `cfg.runsDir` from the plugin config without any path sanitization. If a user (or config injection) sets `runsDir` to an arbitrary path like `/tmp/evil` or `/etc/`, the plugin would happily create directories and write JSON files there.

**Mitigating factors:**
- The config is set by the plugin owner (the user themselves), not by untrusted input.
- OpenClaw plugin configs are typically edited manually or through a trusted UI.
- The files written are benign JSON/JSONL (run state, checkpoints) — not executable content.
- The default path (`~/.openclaw/harness-enforcer/runs`) is safe.

**Recommendation:** Add a `sanitizePath`-style check to `resolveRunsDir()` to ensure the configured path is under `~/.openclaw/`. Low priority since exploitation requires the user to misconfigure their own plugin.

### 2. In-memory lock map and directory scanning without bounds

**Risk:**
- The `locks` Map in `state.ts` stores one entry per active `withLock()` call. Entries are always deleted in the `finally` block, so the map stays at 0-1 entries in normal use. **Not a leak.**
- `findActiveRun()`, `findMostRecentRun()`, and `listCompletedRuns()` call `readdirSync()` on the runs directory and iterate all subdirectories. Over months of use, hundreds of run directories could accumulate, making `harness_status` and `harness_start` slower.

**Mitigating factors:**
- Each directory scan reads only directory names, then at most one small JSON file per directory (short-circuiting on first match for `findActiveRun`/`findMostRecentRun`).
- `listCompletedRuns` has a `limit` parameter (default 5).
- Even 1000 directories would scan in <100ms on any modern filesystem.

**Recommendation:** Consider adding a cleanup/archival mechanism for old runs as a future improvement, not a safety concern.

### 3. TypeScript compilation — no issues found

- `tsconfig.json` targets ES2022 with `moduleResolution: "bundler"` — compatible with OpenClaw's expectations.
- `"type": "module"` in `package.json` matches the ESM import style used throughout.
- `strict: true` is enabled, reducing risk of type-related runtime errors.

---

## Detailed Analysis

### `index.ts` — Plugin Entry Point
- Clean, minimal entry point. No side effects.
- Properly typed with `OpenClawPluginApi`.
- Factory pattern (`api.registerTool(() => createXTool(runsDir))`) is correct — tools are lazily created.
- `resolveRunsDir` gracefully handles missing/undefined config.
- **Grade: PASS**

### `src/tools.ts` — Tool Implementations
- 5 tools: `harness_start`, `harness_checkpoint`, `harness_submit`, `harness_status`, `harness_reset`.
- Every `execute()` has a top-level try/catch that returns structured error JSON — **no unhandled throws**.
- Parameters are validated through `validation.*` helpers before use.
- User-supplied file paths (`planPath`, `evalReportPath`, `challengeReportPath`) go through `sanitizePath` to prevent path traversal and restrict to `~/.openclaw/`.
- State mutations use `withLock()` for concurrency safety.
- `harness_start` checks for an already-active run (prevents duplicate runs).
- `harness_reset` marks runs as "cancelled" rather than deleting files (safe, preserves history).
- Return format `{ content: [{ type: "text", text }], details }` matches expected OpenClaw tool output shape.
- Note: `createHarnessResetTool` is defined above `createHarnessStatusTool` — the comment `// ─── harness_status ───` appears before the reset tool definition. This is a cosmetic comment error, not a functional issue.
- **Grade: PASS**

### `src/state.ts` — State Management
- All state is file-based (JSON/JSONL under `runsDir`).
- In-memory lock is correctly implemented with try/finally cleanup.
- `safeParseJson` wraps JSON.parse with descriptive errors.
- `readCheckpoints` gracefully skips corrupted JSONL lines (try/catch per line).
- `findActiveRun` and `findMostRecentRun` catch errors per-directory and skip corrupted entries.
- No global mutable state beyond the `locks` Map (which stays clean).
- **Grade: PASS**

### `src/validation.ts` — Input Validation
- Strong parameter validation: type checks, null checks, empty string checks.
- `sanitizePath` rejects `..` traversal AND enforces `~/.openclaw/` prefix — **effective path containment**.
- `extractDodItems` correctly handles fenced code blocks (won't extract checkboxes from code examples).
- `safeReadFile` returns null on error rather than throwing.
- `checkEvalReport` and `findUnaddressedCriticals` use regex-based content analysis — no injection risk since they only read and pattern-match.
- **Grade: PASS**

### `openclaw.plugin.json` — Manifest
- Valid JSON with `id: "harness-enforcer"`.
- `configSchema` properly defines `enabled` (boolean) and `runsDir` (string) with `additionalProperties: false`.
- `uiHints` provides user-facing documentation for the config field.
- **Grade: PASS**

### `package.json` — Package Metadata
- `"type": "module"` — correct for ESM.
- `"main": "index.ts"` — OpenClaw loads TypeScript directly (expected).
- Only peer dependency: `"openclaw": "*"` — no version conflicts possible.
- No `dependencies` block — plugin is self-contained using only Node builtins.
- **Grade: PASS**

---

## Recommendation

**SAFE TO LOAD** — Confidence: **HIGH (95%)**

This plugin is well-engineered with proper error handling, input validation, and path containment. It:

1. Will not crash OpenClaw on load (no top-level side effects, correct export shape)
2. Will not corrupt OpenClaw state (writes only to its own isolated directory)
3. Will not propagate unhandled exceptions (every tool execution is try/catch wrapped)
4. Will not allow path traversal attacks (sanitizePath validates all user-supplied paths)
5. Has no external dependencies that could introduce supply chain risk

The only actionable improvement is adding path validation to the configurable `runsDir` in `resolveRunsDir()`, which is low-priority since it requires the user to deliberately misconfigure their own plugin.

**Load it.**
