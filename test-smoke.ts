// Smoke test for harness-enforcer plugin
// Run: npx tsx test-smoke.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createHarnessStartTool,
  createHarnessCheckpointTool,
  createHarnessSubmitTool,
  createHarnessStatusTool,
  createHarnessResetTool,
} from "./src/tools.js";
import { renderProgressBar, renderFinalStatus } from "./src/progress.js";
import * as validation from "./src/validation.js";
import * as state from "./src/state.js";

const testDir = path.join(os.tmpdir(), `harness-test-${Date.now()}`);
const runsDir = path.join(testDir, "runs");

// Create a fake plan.md in a valid ~/.openclaw path for sanitizePath to accept
const planDir = path.join(os.homedir(), ".openclaw", "harness-enforcer", "_test");
fs.mkdirSync(planDir, { recursive: true });
const planPath = path.join(planDir, "plan.md");
fs.writeFileSync(planPath, `# Plan: Test

## Feature 1: Test Feature
- **DoD:**
  - [ ] First criterion
  - [ ] Second criterion
  - [x] Already done criterion
`);

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("\n🔧 Harness Enforcer — Smoke Test\n");

  // --- Test 1: harness_start ---
  console.log("1. harness_start");
  const startTool = createHarnessStartTool(runsDir);
  const startResult = await startTool.execute("test-1", {
    planPath,
    taskDescription: "Smoke test run",
  });
  const startData = (startResult as any).details;
  assert("Returns success", startData?.success === true);
  assert("Returns runId", typeof startData?.runId === "string" && startData.runId.length > 0);
  assert("Counts DoD items", startData?.dodItemCount === 3);
  assert("Counts unchecked DoD items", startData?.uncheckedDodItems === 2);

  const runId = startData?.runId;

  // Check state files exist on disk
  const runDir = path.join(runsDir, runId);
  assert("run-state.json exists", fs.existsSync(path.join(runDir, "run-state.json")));
  assert("dod-items.json exists", fs.existsSync(path.join(runDir, "dod-items.json")));

  // --- Test 2: harness_start rejects duplicate ---
  console.log("\n2. harness_start (duplicate rejection)");
  const dupResult = await startTool.execute("test-2", {
    planPath,
    taskDescription: "Should be rejected",
  });
  const dupData = (dupResult as any).details;
  assert("Rejects duplicate run", dupData?.error?.includes("already active"));

  // --- Test 3: harness_checkpoint ---
  console.log("\n3. harness_checkpoint");
  const cpTool = createHarnessCheckpointTool(runsDir);
  const cpResult = await cpTool.execute("test-3", {
    phase: "build",
    completedFeatures: ["Feature A"],
    pendingFeatures: ["Feature B"],
    blockers: [],
    summary: "First checkpoint — Feature A done",
  });
  const cpData = (cpResult as any).details;
  assert("Returns success", cpData?.success === true);
  assert("Checkpoint number is 1", cpData?.checkpointNumber === 1);
  assert("Phase is build", cpData?.phase === "build");
  assert("checkpoints.jsonl exists", fs.existsSync(path.join(runDir, "checkpoints.jsonl")));

  // --- Test 4: harness_status ---
  console.log("\n4. harness_status");
  const statusTool = createHarnessStatusTool(runsDir);
  const statusResult = await statusTool.execute("test-4", {});
  const statusData = (statusResult as any).details;
  assert("Shows active run", statusData?.status === "active");
  assert("Shows correct runId", statusData?.runId === runId);
  assert("Shows checkpoint count", statusData?.checkpointCount === 1);
  assert("Shows latest checkpoint", statusData?.latestCheckpoint?.phase === "build");

  // --- Test 5: harness_submit (should FAIL — no eval report) ---
  console.log("\n5. harness_submit (rejection test)");
  const submitTool = createHarnessSubmitTool(runsDir);
  const submitResult = await submitTool.execute("test-5", {
    evalReportPath: path.join(planDir, "nonexistent-eval.md"),
  });
  const submitData = (submitResult as any).details;
  assert("Rejects without eval report", submitData?.delivered === false);
  assert("Lists errors", Array.isArray(submitData?.errors) && submitData.errors.length > 0);

  // --- Test 6: harness_submit (should PASS with valid eval) ---
  console.log("\n6. harness_submit (success test)");
  // First update plan to have all DoD checked
  fs.writeFileSync(planPath, `# Plan: Test

## Feature 1: Test Feature
- **DoD:**
  - [x] First criterion
  - [x] Second criterion
  - [x] Already done criterion
`);
  // Create passing eval report
  const evalPath = path.join(planDir, "eval-report.md");
  fs.writeFileSync(evalPath, `# Evaluation Report

## Overall: PASS

All criteria verified.
`);
  const passResult = await submitTool.execute("test-6", {
    evalReportPath: evalPath,
  });
  const passData = (passResult as any).details;
  assert("Delivers successfully", passData?.delivered === true);
  assert("Shows PASS grade", passData?.evalGrade === "PASS");
  assert("delivery.json exists", fs.existsSync(path.join(runDir, "delivery.json")));

  // --- Test 7: harness_reset (no active run) ---
  console.log("\n7. harness_reset (no active run)");
  const resetTool = createHarnessResetTool(runsDir);
  const resetNoRun = await resetTool.execute("test-7a", {});
  const resetNoRunData = (resetNoRun as any).details;
  assert("Returns message when no active run", resetNoRunData?.message?.includes("No active"));

  // --- Test 8: harness_reset (cancel active run) ---
  console.log("\n8. harness_reset (cancel active run)");
  // Start a new run first
  fs.writeFileSync(planPath, `# Plan: Reset Test\n\n- [ ] Item A\n- [ ] Item B\n`);
  const startForReset = await startTool.execute("test-8a", {
    planPath,
    taskDescription: "Run to be reset",
  });
  const resetRunId = (startForReset as any).details?.runId;
  assert("New run started for reset test", typeof resetRunId === "string");

  const resetResult = await resetTool.execute("test-8b", { reason: "Testing reset" });
  const resetData = (resetResult as any).details;
  assert("Reset returns success", resetData?.success === true);
  assert("Reset returns correct runId", resetData?.runId === resetRunId);
  assert("Reset returns reason", resetData?.reason === "Testing reset");
  assert("Reset returns cancelledAt", typeof resetData?.cancelledAt === "string");

  // --- Test 9: harness_start works after reset ---
  console.log("\n9. harness_start after reset");
  const startAfterReset = await startTool.execute("test-9", {
    planPath,
    taskDescription: "Fresh start after reset",
  });
  const afterResetData = (startAfterReset as any).details;
  assert("Start succeeds after reset", afterResetData?.success === true);
  assert("New runId is different", afterResetData?.runId !== resetRunId);

  // --- Test 10: harness_status shows cancelled run ---
  console.log("\n10. harness_status shows cancelled run");
  // First cancel this new run too so we can check status
  await resetTool.execute("test-10a", {});
  const statusAfterReset = await statusTool.execute("test-10b", { runId: resetRunId });
  const statusResetData = (statusAfterReset as any).details;
  assert("Cancelled run shows status=cancelled", statusResetData?.status === "cancelled");

  // --- Test 11: Validation edge cases ---
  console.log("\n11. Validation edge cases");
  // Path traversal
  try {
    const badStart = await startTool.execute("test-7a", {
      planPath: "/Users/testuser/.openclaw/../../../etc/passwd",
      taskDescription: "Should be rejected",
    });
    const badData = (badStart as any).details;
    assert("Rejects path traversal", badData?.error?.includes(".."));
  } catch {
    assert("Rejects path traversal (thrown)", true);
  }

  // Missing params
  try {
    const badStart2 = await startTool.execute("test-7b", {
      taskDescription: "Missing planPath",
    });
    const badData2 = (badStart2 as any).details;
    assert("Rejects missing planPath", badData2?.error !== undefined);
  } catch {
    assert("Rejects missing planPath (thrown)", true);
  }

  // ─── Progress Bar Tests ───

  // --- Test 12: renderProgressBar — 0% progress ---
  console.log("\n12. renderProgressBar — 0% progress");
  {
    const output = renderProgressBar({
      taskDescription: "Implement progress bar",
      phase: "plan",
      completedFeatures: [],
      pendingFeatures: ["Feature A", "Feature B", "Feature C"],
      blockers: [],
      dodTotal: 10,
      dodCompleted: 0,
      elapsedSeconds: 0,
    });
    assert("Contains task description", output.includes("Implement progress bar"));
    assert("Contains 0%", output.includes("0%"));
    assert("Contains empty bar (all ▱)", output.includes("▱".repeat(BAR_WIDTH)));
    assert("No filled blocks", !output.includes("▰"));
    assert("Phase plan is current (▶)", output.includes("▶plan"));
    assert("Phase build is pending (○)", output.includes("○build"));
    assert("Shows 0/10 done", output.includes("0/10 done"));
    assert("Shows 0s elapsed", output.includes("⏱0s"));
    assert("Pending features shown", output.includes("⬜ Feature A"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 13: renderProgressBar — 50% progress ---
  console.log("\n13. renderProgressBar — 50% progress");
  {
    const output = renderProgressBar({
      taskDescription: "Build API endpoint",
      phase: "build",
      completedFeatures: ["Schema types", "API endpoint"],
      pendingFeatures: ["Integration tests", "Documentation"],
      inProgressFeature: "Integration tests",
      blockers: [],
      dodTotal: 10,
      dodCompleted: 5,
      elapsedSeconds: 222,
    });
    assert("Contains 50%", output.includes("50%"));
    assert("Contains filled blocks (▰)", output.includes("▰"));
    assert("Phase plan completed (●)", output.includes("●plan"));
    assert("Phase build is current (▶)", output.includes("▶build"));
    assert("Phase challenge pending (○)", output.includes("○challenge"));
    assert("Completed features marked", output.includes("✅ Schema types"));
    assert("In-progress feature marked", output.includes("⏳ Integration tests"));
    assert("Pending feature marked", output.includes("⬜ Documentation"));
    assert("Elapsed formatted", output.includes("3m 42s"));
    assert("Shows 5/10 done", output.includes("5/10 done"));
    assert("In-progress not duplicated as pending",
      output.split("Integration tests").length - 1 === 1);
  }

  // --- Test 14: renderProgressBar — 100% progress ---
  console.log("\n14. renderProgressBar — 100% progress");
  {
    const output = renderProgressBar({
      taskDescription: "Complete task",
      phase: "eval",
      completedFeatures: ["Feature A", "Feature B"],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 6,
      dodCompleted: 6,
      elapsedSeconds: 3661,
    });
    assert("Contains 100%", output.includes("100%"));
    assert("Full bar (all ▰)", output.includes("▰".repeat(BAR_WIDTH)));
    assert("No empty blocks", !output.includes("▱"));
    assert("Eval phase current (▶)", output.includes("▶eval"));
    assert("Shows 6/6 done", output.includes("6/6 done"));
    assert("Hours in elapsed", output.includes("1h 1m 1s"));
    assert("Blockers: 0", output.includes("0 blockers"));
  }

  // --- Test 15: renderProgressBar — with blockers ---
  console.log("\n15. renderProgressBar — with blockers");
  {
    const output = renderProgressBar({
      taskDescription: "Task with blockers",
      phase: "challenge",
      completedFeatures: ["Done thing"],
      pendingFeatures: ["Blocked thing"],
      blockers: ["Database connection failing", "Missing API key"],
      dodTotal: 4,
      dodCompleted: 2,
      elapsedSeconds: 600,
    });
    assert("Shows blocker count", output.includes("2 blockers"));
    assert("Shows blocker emoji", output.includes("🚫"));
    assert("Shows first blocker", output.includes("Database connection failing"));
    assert("Shows second blocker", output.includes("Missing API key"));
    assert("Shows warning section", output.includes("⚠️ Blockers:"));
  }

  // --- Test 16: renderProgressBar — empty features ---
  console.log("\n16. renderProgressBar — empty features");
  {
    const output = renderProgressBar({
      taskDescription: "No features yet",
      phase: "plan",
      completedFeatures: [],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 0,
      dodCompleted: 0,
      elapsedSeconds: 5,
    });
    assert("Contains 0%", output.includes("0%"));
    assert("Shows 0/0 done", output.includes("0/0 done"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 17: renderProgressBar — very long feature names ---
  console.log("\n17. renderProgressBar — very long feature names (truncation)");
  {
    const longName = "A".repeat(100);
    const output = renderProgressBar({
      taskDescription: "T".repeat(200),
      phase: "build",
      completedFeatures: [longName],
      pendingFeatures: [longName, longName],
      blockers: [longName],
      dodTotal: 3,
      dodCompleted: 1,
      elapsedSeconds: 10,
    });
    assert("Task description truncated", !output.includes("T".repeat(100)));
    assert("Contains truncation char", output.includes("…"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 18: renderProgressBar — 10 features (Telegram limit) ---
  console.log("\n18. renderProgressBar — 10 features (Telegram limit)");
  {
    const features = Array.from({ length: 10 }, (_, i) => `Feature ${i + 1}: Something descriptive here`);
    const output = renderProgressBar({
      taskDescription: "Large feature set",
      phase: "build",
      completedFeatures: features.slice(0, 5),
      pendingFeatures: features.slice(5),
      blockers: ["Blocker 1", "Blocker 2", "Blocker 3"],
      dodTotal: 30,
      dodCompleted: 15,
      elapsedSeconds: 1800,
    });
    assert("Under 4096 chars with 10 features", output.length <= 4096);
    assert("All completed features present", features.slice(0, 5).every(f => output.includes(f)));
    assert("All pending features present", features.slice(5).every(f => output.includes(f)));
  }

  // --- Test 19: renderProgressBar — unknown phase ---
  console.log("\n19. renderProgressBar — unknown phase");
  {
    const output = renderProgressBar({
      taskDescription: "Custom phase",
      phase: "deploy",
      completedFeatures: ["A"],
      pendingFeatures: ["B"],
      blockers: [],
      dodTotal: 2,
      dodCompleted: 1,
      elapsedSeconds: 30,
    });
    assert("All phases shown as pending for unknown phase (○)",
      output.includes("○plan") && output.includes("○build"));
    assert("Still renders valid output", output.includes("50%"));
  }

  // --- Test 20: renderFinalStatus — pass ---
  console.log("\n20. renderFinalStatus — pass");
  {
    const output = renderFinalStatus({
      taskDescription: "Completed task",
      status: "pass",
      evalGrade: "PASS",
      dodTotal: 8,
      dodCompleted: 8,
      elapsedSeconds: 900,
      completedFeatures: ["Feature X", "Feature Y"],
      pendingFeatures: [],
      blockers: [],
    });
    assert("Shows DELIVERED", output.includes("✅ DELIVERED"));
    assert("Shows grade PASS", output.includes("Grade: PASS"));
    assert("Shows 100%", output.includes("100%"));
    assert("Shows full bar (▰)", output.includes("▰".repeat(BAR_WIDTH)));
    assert("Shows DoD count", output.includes("DoD: 8/8"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 21: renderFinalStatus — fail ---
  console.log("\n21. renderFinalStatus — fail");
  {
    const output = renderFinalStatus({
      taskDescription: "Failed task",
      status: "fail",
      evalGrade: "FAIL",
      dodTotal: 8,
      dodCompleted: 3,
      elapsedSeconds: 1200,
      completedFeatures: ["Feature X"],
      pendingFeatures: ["Feature Y", "Feature Z"],
      blockers: ["Critical bug"],
    });
    assert("Shows FAILED", output.includes("❌ FAILED"));
    assert("Shows grade FAIL", output.includes("Grade: FAIL"));
    assert("Shows partial progress", output.includes("38%"));
    assert("Shows blocker", output.includes("Critical bug"));
  }

  // --- Test 22: renderFinalStatus — cancelled ---
  console.log("\n22. renderFinalStatus — cancelled");
  {
    const output = renderFinalStatus({
      taskDescription: "Cancelled task",
      status: "cancelled",
      dodTotal: 5,
      dodCompleted: 2,
      elapsedSeconds: 60,
      completedFeatures: ["A"],
      pendingFeatures: ["B", "C"],
      blockers: [],
    });
    assert("Shows CANCELLED", output.includes("🚫 CANCELLED"));
    assert("Shows partial progress", output.includes("40%"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 23: Edge cases — dodCompleted > dodTotal ---
  console.log("\n23. Edge cases — dodCompleted > dodTotal");
  {
    const output = renderProgressBar({
      taskDescription: "Edge case",
      phase: "eval",
      completedFeatures: [],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 5,
      dodCompleted: 10,
      elapsedSeconds: 0,
    });
    assert("Clamps to 100%", output.includes("100%"));
    assert("Clamps dodCompleted to dodTotal", output.includes("5/5 done"));
  }

  // --- Test 24: Edge cases — negative elapsedSeconds ---
  console.log("\n24. Edge cases — negative elapsedSeconds");
  {
    const output = renderProgressBar({
      taskDescription: "Negative time",
      phase: "plan",
      completedFeatures: [],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 1,
      dodCompleted: 0,
      elapsedSeconds: -100,
    });
    assert("Handles negative elapsed gracefully", output.includes("⏱0s"));
  }

  // ─── Sprint-specific Tests ───

  // --- Test 25: renderProgressBar — sprint mode, sprint 1/4 ---
  console.log("\n25. renderProgressBar — sprint mode (sprint 1/4)");
  {
    const output = renderProgressBar({
      taskDescription: "Large project with sprints",
      phase: "build",
      completedFeatures: ["Schema types"],
      pendingFeatures: ["API routes", "Auth middleware"],
      inProgressFeature: "API routes",
      blockers: [],
      dodTotal: 10,
      dodCompleted: 3,
      elapsedSeconds: 300,
      sprintCurrent: 1,
      sprintTotal: 4,
    });
    assert("Shows sprint header", output.includes("📦 Sprint 1/4"));
    assert("Shows task description", output.includes("Large project with sprints"));
    assert("Shows phase indicator", output.includes("▶build"));
    assert("Sprint status line: ⏳⬜⬜⬜", output.includes("⏳⬜⬜⬜"));
    // Overall: (0 completed sprints * 100 + 30%) / 4 = 8%
    assert("Overall percentage is 8%", output.includes("8%"));
    assert("Shows completed feature", output.includes("✅ Schema types"));
    assert("Shows in-progress feature", output.includes("⏳ API routes"));
    assert("Shows pending feature", output.includes("⬜ Auth middleware"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 26: renderProgressBar — sprint mode, sprint 3/4 (midway) ---
  console.log("\n26. renderProgressBar — sprint mode (sprint 3/4)");
  {
    const output = renderProgressBar({
      taskDescription: "Large project",
      phase: "challenge",
      completedFeatures: ["Notifications", "Search"],
      pendingFeatures: ["File upload"],
      blockers: [],
      dodTotal: 12,
      dodCompleted: 8,
      elapsedSeconds: 7200,
      sprintCurrent: 3,
      sprintTotal: 4,
    });
    assert("Shows sprint 3/4", output.includes("📦 Sprint 3/4"));
    assert("Sprint status: ✅✅⏳⬜", output.includes("✅✅⏳⬜"));
    // Overall: (2 * 100 + 67%) / 4 = 67%
    assert("Overall percentage is 67%", output.includes("67%"));
    assert("Shows 2h elapsed", output.includes("2h 0m 0s"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 27: renderProgressBar — sprint mode, last sprint 100% ---
  console.log("\n27. renderProgressBar — sprint mode (last sprint at 100%)");
  {
    const output = renderProgressBar({
      taskDescription: "Almost done",
      phase: "eval",
      completedFeatures: ["API docs", "Integration tests"],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 8,
      dodCompleted: 8,
      elapsedSeconds: 28800,
      sprintCurrent: 4,
      sprintTotal: 4,
    });
    assert("Shows sprint 4/4", output.includes("📦 Sprint 4/4"));
    assert("Sprint status: ✅✅✅⏳", output.includes("✅✅✅⏳"));
    // Overall: (3 * 100 + 100%) / 4 = 100%
    assert("Overall percentage is 100%", output.includes("100%"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 28: renderProgressBar — no sprint params (backward compat) ---
  console.log("\n28. renderProgressBar — no sprint params (backward compatible)");
  {
    const output = renderProgressBar({
      taskDescription: "Simple project",
      phase: "build",
      completedFeatures: ["Feature A"],
      pendingFeatures: ["Feature B"],
      blockers: [],
      dodTotal: 4,
      dodCompleted: 2,
      elapsedSeconds: 120,
    });
    assert("No sprint header", !output.includes("📦 Sprint"));
    assert("No sprint status line", !output.includes("⏳⬜"));
    assert("Shows 50%", output.includes("50%"));
    assert("Shows task description", output.includes("Simple project"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 29: renderFinalStatus — with sprint params ---
  console.log("\n29. renderFinalStatus — with sprint params");
  {
    const output = renderFinalStatus({
      taskDescription: "Sprint project completed",
      status: "pass",
      evalGrade: "PASS",
      dodTotal: 45,
      dodCompleted: 45,
      elapsedSeconds: 28800,
      completedFeatures: ["Schema", "Auth", "CRUD", "Notifications", "Dashboard"],
      pendingFeatures: [],
      blockers: [],
      sprintCurrent: 6,
      sprintTotal: 6,
    });
    assert("Shows DELIVERED", output.includes("✅ DELIVERED"));
    assert("Shows sprint count", output.includes("📦 Sprints: 6/6 completed"));
    assert("Shows DoD", output.includes("DoD: 45/45"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 30: renderFinalStatus — without sprint params (backward compat) ---
  console.log("\n30. renderFinalStatus — without sprint params (backward compat)");
  {
    const output = renderFinalStatus({
      taskDescription: "Simple completed",
      status: "pass",
      evalGrade: "PASS",
      dodTotal: 8,
      dodCompleted: 8,
      elapsedSeconds: 600,
      completedFeatures: ["A", "B"],
      pendingFeatures: [],
      blockers: [],
    });
    assert("Shows DELIVERED", output.includes("✅ DELIVERED"));
    assert("No sprint line", !output.includes("📦 Sprints:"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 31: renderProgressBar — sprint mode with blockers ---
  console.log("\n31. renderProgressBar — sprint mode with blockers");
  {
    const output = renderProgressBar({
      taskDescription: "Sprint with blockers",
      phase: "build",
      completedFeatures: [],
      pendingFeatures: ["Feature X"],
      blockers: ["Test failure"],
      dodTotal: 5,
      dodCompleted: 0,
      elapsedSeconds: 100,
      sprintCurrent: 2,
      sprintTotal: 3,
    });
    assert("Shows sprint header", output.includes("📦 Sprint 2/3"));
    assert("Shows blocker section", output.includes("⚠️ Blockers:"));
    assert("Shows blocker detail", output.includes("Test failure"));
    assert("Sprint status: ✅⏳⬜", output.includes("✅⏳⬜"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // --- Test 32: renderFinalStatus — sprint mode fail ---
  console.log("\n32. renderFinalStatus — sprint mode fail");
  {
    const output = renderFinalStatus({
      taskDescription: "Sprint project failed",
      status: "fail",
      evalGrade: "FAIL",
      dodTotal: 30,
      dodCompleted: 15,
      elapsedSeconds: 3600,
      completedFeatures: ["A", "B"],
      pendingFeatures: ["C", "D"],
      blockers: ["Critical regression"],
      sprintCurrent: 3,
      sprintTotal: 5,
    });
    assert("Shows FAILED", output.includes("❌ FAILED"));
    assert("Shows sprint count", output.includes("📦 Sprints: 3/5 completed"));
    assert("Shows blocker", output.includes("Critical regression"));
    assert("Under 4096 chars", output.length <= 4096);
  }

  // ── 33. Feature extraction from plan ──
  console.log("\n33. Feature extraction from plan");
  {
    const planWithFeatures = `# My Plan

## Phase 1: Core

- [ ] **Feature A**: Build the widget
- [ ] **Feature B**: Test the widget
- [x] **Feature C**: Deploy the widget

## Phase 2: Polish

- [ ] Add error handling
- [ ] Improve performance

\`\`\`
- [ ] This should be ignored (in code block)
\`\`\`
`;
    const features = validation.extractFeatures(planWithFeatures);
    assert("Extracts 5 features", features.length === 5, `got ${features.length}`);
    assert("First feature id is f001", features[0].id === "f001");
    assert("Category includes Phase 1", features[0].category.includes("Phase 1"));
    assert("Unchecked = pending", features[0].status === "pending");
    assert("Checked = passed", features[2].status === "passed");
    assert("Plain text feature extracted", features[3].description === "Add error handling");
  }

  // ── 34. Feature sync from checkpoint ──
  console.log("\n34. Feature sync from checkpoint");
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-feat-"));
    const runId = "test-feat-sync";
    const features: state.Feature[] = [
      { id: "f001", category: "Core", description: "Build the widget", status: "pending" },
      { id: "f002", category: "Core", description: "Test the widget", status: "pending" },
      { id: "f003", category: "Polish", description: "Add error handling", status: "pending" },
    ];
    state.writeFeatures(tmpDir, runId, features);

    state.syncFeaturesFromCheckpoint(
      tmpDir, runId,
      ["Build the widget"],
      ["Test the widget", "Add error handling"],
    );

    const updated = state.readFeatures(tmpDir, runId);
    assert("Completed feature → passed", updated[0].status === "passed");
    assert("Passed feature gets verifiedAt", updated[0].verifiedAt !== undefined);
    assert("Pending feature stays pending", updated[1].status === "pending");
    assert("Other pending stays pending", updated[2].status === "pending");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── 35. Progress file generation ──
  console.log("\n35. Progress file generation");
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-prog-"));
    const runId = "test-progress";
    const runState2: state.RunState = {
      runId,
      planPath: "/test/plan.md",
      taskDescription: "Test Task",
      startedAt: new Date().toISOString(),
      phase: "build",
      round: 1,
      checkpoints: [new Date().toISOString()],
      status: "active",
    };
    const checkpoint: state.Checkpoint = {
      timestamp: new Date().toISOString(),
      phase: "build",
      completedFeatures: ["Widget A"],
      pendingFeatures: ["Widget B"],
      blockers: [],
      summary: "Making progress",
    };
    const features: state.Feature[] = [
      { id: "f001", category: "Core", description: "Widget A", status: "passed" },
      { id: "f002", category: "Core", description: "Widget B", status: "pending" },
    ];

    state.writeProgressFile(tmpDir, runId, runState2, checkpoint, features);
    const progress = state.readProgressFile(tmpDir, runId);
    assert("Progress file exists", progress !== null);
    assert("Contains task description", progress!.includes("Test Task"));
    assert("Contains passed count", progress!.includes("Passed: 1"));
    assert("Contains pending count", progress!.includes("Pending: 1"));
    assert("Contains completed feature", progress!.includes("Widget A"));
    assert("Contains summary", progress!.includes("Making progress"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── 36. Feature immutability — passed features don't revert ──
  console.log("\n36. Feature immutability — passed features don't revert");
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-immut-"));
    const runId = "test-immut";
    const features: state.Feature[] = [
      { id: "f001", category: "Core", description: "Already done", status: "passed", verifiedAt: "2026-01-01T00:00:00Z" },
      { id: "f002", category: "Core", description: "Still pending", status: "pending" },
    ];
    state.writeFeatures(tmpDir, runId, features);

    // Checkpoint that doesn't mention the passed feature
    state.syncFeaturesFromCheckpoint(
      tmpDir, runId,
      [],  // nothing completed this round
      ["Still pending"],
    );

    const updated = state.readFeatures(tmpDir, runId);
    assert("Passed feature stays passed", updated[0].status === "passed");
    assert("VerifiedAt preserved", updated[0].verifiedAt === "2026-01-01T00:00:00Z");
  }

  // ── 37. Work log in progress bar ──
  console.log("\n37. Work log in progress bar");
  {
    const bar = renderProgressBar({
      taskDescription: "Test Work Log",
      phase: "build",
      completedFeatures: ["Done A"],
      pendingFeatures: ["Pending B"],
      blockers: [],
      dodTotal: 4,
      dodCompleted: 2,
      elapsedSeconds: 120,
      workLog: ["Editing state.ts", "Running tests", "Pushing to GitHub"],
    });
    assert("Contains work log marker", bar.includes("📝"));
    assert("Shows last action", bar.includes("Pushing to GitHub"));
    assert("Shows earlier action", bar.includes("Running tests"));
    assert("Under 4096 chars", bar.length <= 4096);
  }

  // ── 38. Work log truncation ──
  console.log("\n38. Work log truncation (max 5 entries)");
  {
    const bar = renderProgressBar({
      taskDescription: "Test Truncation",
      phase: "build",
      completedFeatures: [],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 1,
      dodCompleted: 0,
      elapsedSeconds: 60,
      workLog: ["Action 1", "Action 2", "Action 3", "Action 4", "Action 5", "Action 6", "Action 7"],
    });
    // Should only show last 5
    assert("Does not show Action 1", !bar.includes("Action 1"));
    assert("Does not show Action 2", !bar.includes("Action 2"));
    assert("Shows Action 3", bar.includes("Action 3"));
    assert("Shows Action 7", bar.includes("Action 7"));
  }

  // ── 39. Empty work log doesn't render ──
  console.log("\n39. Empty work log doesn't render");
  {
    const bar = renderProgressBar({
      taskDescription: "No Log",
      phase: "plan",
      completedFeatures: [],
      pendingFeatures: [],
      blockers: [],
      dodTotal: 1,
      dodCompleted: 0,
      elapsedSeconds: 10,
    });
    assert("No work log marker", !bar.includes("📝"));
  }

  // Summary
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"─".repeat(40)}\n`);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(planDir, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

// BAR_WIDTH must match the constant in progress.ts
const BAR_WIDTH = 15;

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
