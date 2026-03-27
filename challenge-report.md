# Challenge Report: harness-enforcer
## Summary
The `harness-enforcer` plugin delivers much-needed runtime enforcement to the harness pipeline, following proven patterns from the OpenClaw plugin SDK. The core functions—registering tools, state tracking via JSON files, and DoD compliance—are present and broadly aligned with both the plan and OpenClaw conventions. The code demonstrates robust error handling, adherence to the SDK surface, and well-scoped file-based state management. However, several potentially-high-impact gaps exist: parameter validation is inconsistent, certain edge cases (file corruption, concurrent write hazards) are under-addressed, and there is risk of silent failure if file operations or state transitions go wrong. Import style and some error-path feedback could be improved for maintainability and resilience. No critical crashers are found, but some issues are *high severity* and should be resolved for robust operation.

## Challenges

### HIGH Challenge 1: Inconsistent Parameter Validation & Sanitization
- **File:** `/src/tools.ts`, indirectly throughout tool execution
- **Issue:** Only basic type/shape validation is performed on input parameters. There is direct casting and trimming, but no strong runtime assertion on array contents or forbidden values, and defensive coding is inconsistent (e.g., missing for array fields or directory-traversal risk on plan paths).
- **Evidence:** In `createHarnessCheckpointTool`, features and blockers arrays are simply cast; in `createHarnessStartTool` planPath is only trimmed. In real deployments, agents or users could send malformed or malicious input.
- **Impact:** Weak parameter handling could lead to silent data corruption, confusing errors, or even file I/O injection if an attacker compromises the call path. Harness runs could be started with incomplete/malformed metadata.
- **Fix:** Harden all tool parameters: strictly validate types, array element types, and especially planPath/taskDescription for invalid characters or relative path exploits. Consider using a utility like the `readStringParam` seen in lossless-claw for consistency and safety.

### HIGH Challenge 2: Silent Failure on File Operation Errors (Corruption, I/O)
- **File:** `/src/state.ts`, `/src/validation.ts`, `/src/tools.ts`
- **Issue:** File read/write errors (e.g., partial writes, corrupted JSON, disk full) are caught at a very high level or ignored altogether. Functions like `readCheckpoints`, `readDodItems`, and `readRunState` assume valid files and do not handle parse errors robustly. Safe reading is implemented for plan/markdown files but *not* consistently for all JSON file accesses.
- **Evidence:** Most state accesses use `JSON.parse(fs.readFileSync(...))` with no try-catch; only `safeReadFile` for markdown. Dir creation/writes (e.g. `fs.appendFileSync`, `fs.writeFileSync`) do not check/handle errors. Any malformed or truncated file may blow up entire plugin flow.
- **Impact:** A single file corrupt (disk, user error, crash) can break all harness runs or create inconsistency that is very hard to debug. Uncaught exceptions in synchronous file I/O are hazardous to plugin stability.
- **Fix:** Always trap parse errors in all read functions; wrap all file I/O in try-catch and clearly return structured errors to the tools layer. Consider atomic write patterns or backups for critical state files.

### MEDIUM Challenge 3: Concurrency & Potential Race Conditions
- **File:** `/src/state.ts`, all tools
- **Issue:** No checks for concurrent tool invocation or overlapping write operations. There is a window where two rapid calls could interleave (`checkpoints.jsonl` or `run-state.json` modification).
- **Evidence:** State mutations are performed via plain synchronous writes but without file or in-memory locking. Parallel agent/task handling is possible in advanced harness scenarios.
- **Impact:** Rare, but could result in clobbered state files, missing checkpoints, or partial run registration.
- **Fix:** Implement file-level locking or, at minimum, guard critical operations in memory (e.g., a lock map for active runIds). Detect and reject parallel writes or add queueing.

### MEDIUM Challenge 4: DoD Extraction Logic Assumes Markdown Consistency
- **File:** `/src/validation.ts`
- **Issue:** Extraction of DoD checkboxes expects standard list formatting. Unusual markdown (indented lists, code blocks, or nonstandard checkbox tokens) may cause missed or false-positive items.
- **Evidence:** `extractDodItems` parses only lines starting with `- [ ]`/`- [x]` (with single space). Edge patterns are not recognized.
- **Impact:** DoD items could be missed or incorrectly marked, leading to false compliance.
- **Fix:** Document markdown DoD requirements or strengthen parsing with regex for leading whitespace, variation in bullet type, etc. Add tests for edge markdown.

### LOW Challenge 5: Type Imports & ES Module Conventions
- **File:** `/index.ts`
- **Issue:** Uses direct `import * as ... from "./src/xxx.js"`, which is nonstandard in TypeScript source files (should be `.ts`). Similar to lossless-claw, but in future may confuse module system or cause import resolution headaches during tooling upgrades.
- **Evidence:** Present throughout imports in entry file.
- **Impact:** Currently functional, but could break in stricter or more advanced build setups.
- **Fix:** Standardize imports to point to `.ts` source (let TS compile to `.js` as needed), or clarify module strategy (e.g., output to dist).

## DoD Compliance Check
Based on `/plan.md`:

### Feature 1: `harness_start` Tool
- [x] Tool registered via `api.registerTool()`
- [x] Accepts correct parameters
- [x] Creates run dir + `run-state.json`
- [x] Extracts DoD from plan.md into `dod-items.json`
- [x] Single active run enforced
- [x] Returns confirmation + runId

### Feature 2: `harness_checkpoint` Tool
- [x] Registered and parameterized
- [x] Validates existence of run
- [x] Updates `run-state.json` + appends checkpoints
- [x] Confirmation and metrics returned

### Feature 3: `harness_submit` Tool
- [x] Registered and parameterized
- [x] Validates run exists, eval report pass, DoD check
- [x] Proper errors if any validation fails
- [x] Delivery only if all checks pass

### Feature 4: `harness_status` Tool
- [x] Registered and parameterized
- [x] Reads run/checkpoint state
- [x] Shows last 5 completed runs
- [x] Handles no-run case

### Structure & State
- [x] All files conform to planned structure
- [x] No DB usage; plain JSON as described
- [x] Returns and parameter schemas match plan

### Out of Scope
All correctly omitted (no unverified hooks/services used).

## Verdict
CONDITIONAL PASS

The plugin meets its planned DoD and the core API compatibility, but **high-severity robustness challenges** remain around input validation and file error handling. With fixes applied, this will be production-ready and strong by design. Address HIGH risks before broad deployment.