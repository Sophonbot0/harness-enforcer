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
} from "./src/tools.js";

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

  // --- Test 7: Validation edge cases ---
  console.log("\n7. Validation edge cases");
  // Path traversal
  try {
    const badStart = await startTool.execute("test-7a", {
      planPath: "/Users/jbelo/.openclaw/../../../etc/passwd",
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

  // Summary
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"─".repeat(40)}\n`);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.rmSync(planDir, { recursive: true, force: true });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
