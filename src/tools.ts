import type { AnyAgentTool } from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as state from "./state.js";
import * as validation from "./validation.js";
import { renderProgressBar, renderFinalStatus } from "./progress.js";

/** Shared mutable ref so tools can read the current session key set by the hook. */
export interface SessionContext {
  currentSessionKey: string | undefined;
}

function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function elapsedSeconds(startedAt: string): number {
  return Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── harness_start ───

export function createHarnessStartTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_start",
    label: "Harness Start",
    description:
      "Initialise a new harness run. Creates a run directory, records the plan, and extracts DoD items. " +
      "Call this at the start of every harness pipeline. Only one active run is allowed at a time. " +
      "SILENT WORK MODE: During a harness run, do NOT send separate progress messages. Use harness_checkpoint with currentAction to update the progress bar instead.",
    parameters: {
      type: "object",
      properties: {
        planPath: {
          type: "string",
          description: "Absolute path to the plan.md file for this harness run.",
        },
        taskDescription: {
          type: "string",
          description: "Short description of the task being executed.",
        },
        telegramChatId: {
          type: "string",
          description: "Telegram chat ID for progress bar auto-updates. If set, the tool returns a rendered progress bar to send.",
        },
        telegramThreadId: {
          type: "string",
          description: "Telegram thread/topic ID for progress bar auto-updates (optional, for forum groups).",
        },
        verifyCommand: {
          type: "string",
          description: "Optional command to verify work (e.g. 'npm test', 'vitest run'). Stored in run state and recommended to agent before marking features done.",
        },
        parentRunId: {
          type: "string",
          description: "Optional parent run ID to link sub-plans for orchestration. Enables future multi-plan hierarchies.",
        },
      },
      required: ["planPath", "taskDescription"],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const planPath = validation.sanitizePath(
          validation.readStringParam(p, "planPath"),
          "planPath",
        );
        const taskDescription = validation.readStringParam(p, "taskDescription");

        // Check for already-active run ON THIS SESSION (allows concurrent runs on different sessions)
        const sessionKey = sessionCtx.currentSessionKey;
        const active = state.findActiveRunForSession(runsDir, sessionKey);
        if (active) {
          return jsonResult({
            error: "A harness run is already active for this session.",
            activeRunId: active.runId,
            phase: active.state.phase,
            startedAt: active.state.startedAt,
            hint: "Complete or abort the current run before starting a new one.",
          });
        }

        // Read plan and extract DoD
        const planContent = validation.safeReadFile(planPath);
        if (planContent === null) {
          return jsonResult({
            error: `Cannot read plan file: ${planPath}`,
            hint: "Verify the file exists and the path is correct.",
          });
        }

        const dodItems = validation.extractDodItems(planContent);
        const features = validation.extractFeatures(planContent);
        const runId = state.generateRunId();
        const now = new Date().toISOString();

        const telegramChatId = validation.readOptionalStringParam(p, "telegramChatId");
        const telegramThreadId = validation.readOptionalStringParam(p, "telegramThreadId");
        const verifyCommand = validation.readOptionalStringParam(p, "verifyCommand");
        const parentRunId = validation.readOptionalStringParam(p, "parentRunId");

        const runState: state.RunState = {
          runId,
          planPath,
          taskDescription,
          startedAt: now,
          phase: "plan",
          round: 1,
          checkpoints: [],
          status: "active",
          ...(sessionKey ? { sessionKey } : {}),
          ...(telegramChatId ? { telegramChatId } : {}),
          ...(telegramThreadId ? { telegramThreadId } : {}),
          ...(verifyCommand ? { verifyCommand } : {}),
          ...(parentRunId ? { parentRunId } : {}),
        };

        state.writeRunState(runsDir, runId, runState);
        state.writeDodItems(
          runsDir,
          runId,
          dodItems.map((d) => ({ text: d.text, checked: d.checked })),
        );

        // Register this run in the manifest if parentRunId matches a manifest
        if (parentRunId) {
          const manifest = state.readManifest(runsDir, parentRunId);
          if (manifest) {
            const matchingPlan = manifest.plans.find(p => p.path === planPath && p.status === "pending");
            if (matchingPlan) {
              matchingPlan.status = "active";
              matchingPlan.runId = runId;
              state.writeManifest(runsDir, manifest);
            }
          }
        }

        // Write structured features (Anthropic pattern — immutable list)
        if (features.length > 0) {
          state.writeFeatures(runsDir, runId, features);
        }

        // Auto-render initial progress bar
        const progressBar = renderProgressBar({
          taskDescription,
          phase: "plan",
          completedFeatures: [],
          pendingFeatures: [],
          blockers: [],
          dodTotal: dodItems.length,
          dodCompleted: 0,
          elapsedSeconds: 0,
        });

        const result: Record<string, unknown> = {
          success: true,
          runId,
          startedAt: now,
          planPath,
          taskDescription,
          dodItemCount: dodItems.length,
          uncheckedDodItems: dodItems.filter((d) => !d.checked).length,
          featureCount: features.length,
          progressBar,
        };

        if (telegramChatId) {
          result.telegramAutoManaged = true;
          result.telegramChatId = telegramChatId;
          if (telegramThreadId) result.telegramThreadId = telegramThreadId;
          result.silentWorkMode = "⚠️ IMPORTANT: The plugin auto-sends and auto-edits the Telegram progress bar. Do NOT send or edit any Telegram messages yourself during this harness run. Just call harness_checkpoint to update progress — the bar updates automatically.";
        }

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_start failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_checkpoint ───

export function createHarnessCheckpointTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_checkpoint",
    label: "Harness Checkpoint",
    description:
      "Save progress during a harness run. Records the current phase, completed/pending features, " +
      "blockers, and a summary. Data persists to disk and survives context compaction.",
    parameters: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          description: "Current pipeline phase (e.g. 'plan', 'build', 'challenge', 'eval').",
        },
        completedFeatures: {
          type: "array",
          items: { type: "string" },
          description: "List of features/items completed so far.",
        },
        pendingFeatures: {
          type: "array",
          items: { type: "string" },
          description: "List of features/items still pending.",
        },
        blockers: {
          type: "array",
          items: { type: "string" },
          description: "List of current blockers or issues.",
        },
        summary: {
          type: "string",
          description: "Brief summary of progress at this checkpoint.",
        },
        telegramMessageId: {
          type: "string",
          description: "Telegram message ID to edit with updated progress bar. Pass the messageId from harness_start's initial send.",
        },
        verificationLog: {
          type: "string",
          description: "Optional test/build output proving features are complete. Stored as evidence.",
        },
        currentAction: {
          type: "string",
          description: "What the agent is currently doing. Shown in the progress bar work log instead of sending separate messages.",
        },
        contextSnapshot: {
          type: "object",
          description: "Cross-session context preservation. Survives crashes and context compaction. Include key decisions, files modified, current approach, and next steps.",
          properties: {
            keyDecisions: { type: "array", items: { type: "string" }, description: "Important decisions made during this run." },
            filesModified: { type: "array", items: { type: "string" }, description: "Files touched so far." },
            currentApproach: { type: "string", description: "What strategy is being used." },
            blockerHistory: { type: "array", items: { type: "string" }, description: "Blockers that were resolved." },
            nextSteps: { type: "array", items: { type: "string" }, description: "What should happen next (for resume)." },
          },
        },
      },
      required: ["phase", "completedFeatures", "pendingFeatures", "blockers", "summary"],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const phase = validation.readStringParam(p, "phase");
        const completedFeatures = validation.readStringArrayParam(p, "completedFeatures");
        const pendingFeatures = validation.readStringArrayParam(p, "pendingFeatures");
        const blockers = validation.readStringArrayParam(p, "blockers");
        const summary = validation.readStringParam(p, "summary");
        const telegramMessageId = validation.readOptionalStringParam(p, "telegramMessageId");
        const verificationLog = validation.readOptionalStringParam(p, "verificationLog");
        const currentAction = validation.readOptionalStringParam(p, "currentAction");
        const contextSnapshot = p.contextSnapshot as state.ContextSnapshot | undefined;

        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (!active) {
          return jsonResult({
            error: "No active harness run found.",
            hint: "Call harness_start first to initialise a run.",
          });
        }

        const { runId, state: runState } = active;

        // Resolve telegramMessageId: param > state > null
        const resolvedMessageId = telegramMessageId ?? runState.telegramMessageId;

        // Save telegramMessageId if provided and not already set
        if (telegramMessageId && !runState.telegramMessageId) {
          runState.telegramMessageId = telegramMessageId;
        }

        // Use lock for state mutation
        const result = state.withLock(runId, () => {
          runState.phase = phase;
          const now = new Date().toISOString();
          runState.checkpoints.push(now);
          state.writeRunState(runsDir, runId, runState);

          const checkpoint: state.Checkpoint = {
            timestamp: now,
            phase,
            completedFeatures,
            pendingFeatures,
            blockers,
            summary,
            ...(verificationLog ? { verificationLog: verificationLog.slice(0, 5000) } : {}),
            ...(contextSnapshot ? { contextSnapshot } : {}),
          };
          state.appendCheckpoint(runsDir, runId, checkpoint);

          // Persist latest context snapshot to run state for recovery
          if (contextSnapshot) {
            runState.lastContextSnapshot = contextSnapshot;
            state.writeRunState(runsDir, runId, runState);
          }

          // Sync features from checkpoint (Anthropic pattern)
          state.syncFeaturesFromCheckpoint(
            runsDir,
            runId,
            completedFeatures,
            pendingFeatures,
          );

          // Write progress file (cross-session memory)
          const features = state.readFeatures(runsDir, runId);
          if (features.length > 0) {
            state.writeProgressFile(runsDir, runId, runState, checkpoint, features);
          }

          const elapsed = elapsedSeconds(runState.startedAt);
          const dodItems = state.readDodItems(runsDir, runId);

          // Update work log with current action
          if (currentAction) {
            const log = runState.workLog ?? [];
            log.push(currentAction);
            // Keep only last 5 entries
            runState.workLog = log.slice(-5);
            state.writeRunState(runsDir, runId, runState);
          }

          // Auto-render progress bar
          const progressBar = renderProgressBar({
            taskDescription: runState.taskDescription,
            phase,
            completedFeatures,
            pendingFeatures,
            blockers,
            dodTotal: dodItems.length,
            dodCompleted: completedFeatures.length,
            elapsedSeconds: elapsed,
            workLog: runState.workLog,
          });

          const res: Record<string, unknown> = {
            success: true,
            runId,
            checkpointNumber: runState.checkpoints.length,
            elapsed: formatDuration(elapsed),
            elapsedSeconds: elapsed,
            phase,
            completedCount: completedFeatures.length,
            pendingCount: pendingFeatures.length,
            blockerCount: blockers.length,
            progressBar,
          };

          // Verification reminder (Anthropic insight: don't mark done without testing)
          if (runState.verifyCommand && pendingFeatures.length > 0) {
            res.verificationReminder = `⚠️ Before marking features complete, run: ${runState.verifyCommand}`;
          }

          // Feature status summary
          if (features.length > 0) {
            const passed = features.filter(f => f.status === "passed").length;
            const pending2 = features.filter(f => f.status === "pending").length;
            res.featureStatus = { passed, pending: pending2, total: features.length };
          }

          // Telegram is auto-managed by the plugin hook — pass IDs so it can send/edit
          if (runState.telegramChatId) {
            res.telegramAutoManaged = true;
            res.telegramChatId = runState.telegramChatId;
            if (runState.telegramMessageId) res.telegramMessageId = runState.telegramMessageId;
            if (runState.telegramThreadId) res.telegramThreadId = runState.telegramThreadId;
          }

          return res;
        });

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_submit ───

export function createHarnessSubmitTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_submit",
    label: "Harness Submit",
    description:
      "Quality gate for delivering harness results. Validates that the eval report passes, " +
      "all DoD items are checked, and no critical challenges remain unaddressed. " +
      "Only delivers if all checks pass; otherwise returns structured errors.",
    parameters: {
      type: "object",
      properties: {
        evalReportPath: {
          type: "string",
          description: "Absolute path to the eval-report.md file.",
        },
        challengeReportPath: {
          type: "string",
          description: "Optional absolute path to the challenge-report.md file.",
        },
        nextPlanPath: {
          type: "string",
          description: "Optional path to next plan. On successful delivery, returns instructions to auto-start the next run.",
        },
      },
      required: ["evalReportPath"],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const evalReportPath = validation.sanitizePath(
          validation.readStringParam(p, "evalReportPath"),
          "evalReportPath",
        );
        const rawChallengePath = validation.readOptionalStringParam(p, "challengeReportPath");
        const challengeReportPath = rawChallengePath
          ? validation.sanitizePath(rawChallengePath, "challengeReportPath")
          : undefined;
        const rawNextPlan = validation.readOptionalStringParam(p, "nextPlanPath");

        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (!active) {
          return jsonResult({
            error: "No active harness run found.",
            hint: "Call harness_start first to initialise a run.",
          });
        }

        const { runId, state: runState } = active;
        const errors: string[] = [];

        // 1. Check eval report
        let evalContent: string | null = null;
        evalContent = validation.safeReadFile(evalReportPath);
        if (evalContent === null) {
          errors.push(`Cannot read eval report: ${evalReportPath}`);
        } else {
          const evalCheck = validation.checkEvalReport(evalContent);
          if (!evalCheck.passed) {
            errors.push(evalCheck.reason);
          }
        }

        // 2. Check DoD items from plan
        const planContent = validation.safeReadFile(runState.planPath);
        if (planContent === null) {
          errors.push(`Cannot read plan file: ${runState.planPath}`);
        } else {
          const unchecked = validation.findUncheckedDod(planContent);
          if (unchecked.length > 0) {
            errors.push(
              `${unchecked.length} unchecked DoD item(s) remain:\n` +
                unchecked.map((u) => `  - [ ] ${u}`).join("\n"),
            );
          }
        }

        // 3. Check challenge report if provided
        if (challengeReportPath) {
          const challengeContent = validation.safeReadFile(challengeReportPath);
          if (challengeContent === null) {
            errors.push(`Cannot read challenge report: ${challengeReportPath}`);
          } else {
            const criticals = validation.findUnaddressedCriticals(challengeContent);
            if (criticals.length > 0) {
              errors.push(
                `${criticals.length} unaddressed CRITICAL challenge(s):\n` +
                  criticals.map((c) => `  ${c}`).join("\n"),
              );
            }
          }
        }

        // 4. Check feature verification (warn, not block)
        const warnings: string[] = [];
        const features = state.readFeatures(runsDir, runId);
        if (features.length > 0) {
          const unverified = features.filter(f => f.status === "passed" && !f.verifiedAt);
          if (unverified.length > 0) {
            warnings.push(
              `${unverified.length} feature(s) marked passed without verification evidence:\n` +
                unverified.map(f => `  ⚠️ ${f.description}`).join("\n")
            );
          }
        }

        if (errors.length > 0) {
          // Generate recovery hints based on what failed
          const hints: string[] = [];
          for (const err of errors) {
            if (err.includes("unchecked DoD")) {
              hints.push("ACTION: Open the plan file and check off completed items, or verify and complete the remaining ones.");
            } else if (err.includes("FAIL")) {
              hints.push("ACTION: Review the eval report, fix the failing criteria, and re-run evaluation.");
            } else if (err.includes("CRITICAL")) {
              hints.push("ACTION: Address each critical challenge — add mitigations or mark as resolved in the challenge report.");
            } else if (err.includes("Cannot read")) {
              hints.push("ACTION: Ensure the report file exists at the specified path. Write it if missing.");
            }
          }

          return jsonResult({
            delivered: false,
            runId,
            errors,
            recoveryHints: hints,
            hint: "Fix all issues above and call harness_submit again.",
          });
        }

        // All checks passed — deliver (with lock)
        const result = state.withLock(runId, () => {
          const elapsed = elapsedSeconds(runState.startedAt);
          const checkpoints = state.readCheckpoints(runsDir, runId);
          const lastCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;

          let evalGrade = "PASS";
          if (evalContent) {
            const gradeMatch = evalContent.match(/overall\s*:\s*(\S+)/i);
            if (gradeMatch) evalGrade = gradeMatch[1];
          }

          const delivery: state.Delivery = {
            deliveredAt: new Date().toISOString(),
            evalGrade,
            totalRounds: runState.round,
            elapsedSeconds: elapsed,
            checkpointCount: checkpoints.length,
          };

          runState.status = "completed";
          state.writeRunState(runsDir, runId, runState);
          state.writeDelivery(runsDir, runId, delivery);

          // Auto-render final status bar
          // On PASS: force 100% — all features are complete (DoD was validated)
          const dodItems = state.readDodItems(runsDir, runId);
          const allFeatureNames = lastCheckpoint
            ? [...lastCheckpoint.completedFeatures, ...lastCheckpoint.pendingFeatures]
            : dodItems.map(d => d.text);
          const progressBar = renderFinalStatus({
            taskDescription: runState.taskDescription,
            status: "pass",
            evalGrade,
            dodTotal: dodItems.length,
            dodCompleted: dodItems.length, // PASS = 100%
            elapsedSeconds: elapsed,
            completedFeatures: allFeatureNames, // All features are done on PASS
            pendingFeatures: [],
            blockers: [],
          });

          const res: Record<string, unknown> = {
            delivered: true,
            runId,
            evalGrade,
            totalRounds: runState.round,
            elapsed: formatDuration(elapsed),
            elapsedSeconds: elapsed,
            checkpointCount: checkpoints.length,
            message: "All quality gates passed. Run delivered successfully.",
            progressBar,
            ...(warnings.length > 0 ? { warnings } : {}),
          };

          // Telegram is auto-managed by the plugin hook — pass IDs so it can edit final bar
          if (runState.telegramChatId) {
            res.telegramAutoManaged = true;
            res.telegramChatId = runState.telegramChatId;
            if (runState.telegramMessageId) res.telegramMessageId = runState.telegramMessageId;
            if (runState.telegramThreadId) res.telegramThreadId = runState.telegramThreadId;
          }

          // Run chaining — auto-continue to next plan
          if (rawNextPlan) {
            res.nextPlanPath = rawNextPlan;
            res.autoChain = true;
            res.chainingInstruction =
              `🔗 AUTO-CHAIN: This run is complete. Immediately call harness_start with planPath="${rawNextPlan}" ` +
              `to start the next run. Do NOT wait for user input. Carry forward the telegramChatId and telegramThreadId. ` +
              `Use parentRunId="${runId}" to link the runs.`;
          }

          // Manifest-aware auto-chain — update manifest and find next plan
          const manifest = state.findManifestByRunId(runsDir, runId);
          if (manifest) {
            // Mark this plan as completed in the manifest
            const thisPlan = manifest.plans.find(p => p.runId === runId);
            if (thisPlan) {
              thisPlan.status = "completed";
              thisPlan.evalGrade = evalGrade;
              thisPlan.completedAt = new Date().toISOString();
            }

            // Check if all plans are done
            const allDone = manifest.plans.every(p => p.status === "completed" || p.status === "skipped");
            if (allDone) {
              manifest.status = "completed";
              state.writeManifest(runsDir, manifest);
              res.manifestCompleted = true;
              res.manifestId = manifest.manifestId;
              res.manifestMessage = `🎉 All ${manifest.plans.length} phases completed! Project "${manifest.projectDescription}" is done.`;
            } else {
              // Find next plan(s)
              const nextPlan = state.getNextPendingPlan(manifest);
              const parallelReady = state.getParallelReadyPlans(manifest);

              if (nextPlan && !rawNextPlan) {
                // Auto-chain to next plan from manifest
                manifest.currentPhase = nextPlan.phase;
                state.writeManifest(runsDir, manifest);

                res.nextPlanPath = nextPlan.path;
                res.autoChain = true;
                res.manifestId = manifest.manifestId;
                res.manifestPhase = `${nextPlan.phase}/${manifest.plans.length}`;
                res.chainingInstruction =
                  `🔗 MANIFEST CHAIN: Phase ${nextPlan.phase}/${manifest.plans.length} — "${nextPlan.title}". ` +
                  `Immediately call harness_start with planPath="${nextPlan.path}" ` +
                  `and parentRunId="${manifest.manifestId}". Do NOT wait for user input. ` +
                  `Carry forward telegramChatId and telegramThreadId.`;

                if (parallelReady.length > 1) {
                  res.parallelPlans = parallelReady.map(p => ({
                    phase: p.phase,
                    title: p.title,
                    path: p.path,
                  }));
                  res.parallelHint = `${parallelReady.length} plans can run in parallel. ` +
                    `Use sessions_spawn for each parallel plan if multi-agent is available.`;
                }
              } else {
                state.writeManifest(runsDir, manifest);
              }
            }
          }

          return res;
        });

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_submit failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_status ───

export function createHarnessResetTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_reset",
    label: "Harness Reset",
    description:
      "Cancel the active harness run and reset state, allowing a fresh start. " +
      "Marks the run as 'cancelled' (preserves history) rather than deleting files. " +
      "After reset, harness_start can be called again.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for cancelling the run (e.g. 'requirements changed', 'stuck on blockers').",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const reason = validation.readOptionalStringParam(p, "reason") ?? "Manual reset";

        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (!active) {
          return jsonResult({
            message: "No active harness run to reset.",
            hint: "There is no active run. You can call harness_start to begin a new one.",
          });
        }

        const { runId, state: runState } = active;

        const result = state.withLock(runId, () => {
          const elapsed = elapsedSeconds(runState.startedAt);
          const checkpoints = state.readCheckpoints(runsDir, runId);
          const lastCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;

          runState.status = "cancelled";
          state.writeRunState(runsDir, runId, runState);

          // Auto-render final status bar
          const progressBar = renderFinalStatus({
            taskDescription: runState.taskDescription,
            status: "cancelled",
            dodTotal: state.readDodItems(runsDir, runId).length,
            dodCompleted: lastCheckpoint ? lastCheckpoint.completedFeatures.length : 0,
            elapsedSeconds: elapsed,
            completedFeatures: lastCheckpoint ? lastCheckpoint.completedFeatures : [],
            pendingFeatures: lastCheckpoint ? lastCheckpoint.pendingFeatures : [],
            blockers: lastCheckpoint ? lastCheckpoint.blockers : [],
          });

          const res: Record<string, unknown> = {
            success: true,
            runId,
            cancelledAt: new Date().toISOString(),
            reason,
            elapsed: formatDuration(elapsed),
            elapsedSeconds: elapsed,
            phase: runState.phase,
            checkpointCount: checkpoints.length,
            message: `Run '${runId}' cancelled. You can now call harness_start to begin a fresh run.`,
            progressBar,
          };

          // Telegram message will be auto-deleted by the plugin hook
          if (runState.telegramMessageId && runState.telegramChatId) {
            res.telegramAutoManaged = true;
            res.telegramDeleteOnReset = true;
            res.telegramMessageId = runState.telegramMessageId;
            res.telegramChatId = runState.telegramChatId;
          }

          return res;
        });

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_reset failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_resume ───

export function createHarnessResumeTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_resume",
    label: "Harness Resume",
    description:
      "Resume a cancelled, stale, or failed harness run. Creates a new active run that carries over " +
      "the context snapshot, completed features, plan path, and Telegram IDs from the original run. " +
      "Use this to recover from crashes, context loss, or gateway restarts.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Run ID to resume. If omitted, resumes the most recent non-active run.",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const requestedRunId = validation.readOptionalStringParam(p, "runId");

        // Check no active run exists
        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (active) {
          return jsonResult({
            error: "Cannot resume — an active run already exists.",
            activeRunId: active.runId,
            hint: "Complete, submit, or reset the current run first.",
          });
        }

        // Find the run to resume
        let sourceRun: { runId: string; state: state.RunState } | null = null;
        if (requestedRunId) {
          const s = state.readRunState(runsDir, requestedRunId);
          if (s) sourceRun = { runId: requestedRunId, state: s };
        } else {
          sourceRun = state.findMostRecentRun(runsDir);
        }

        if (!sourceRun) {
          return jsonResult({
            error: "No run found to resume.",
            hint: requestedRunId
              ? `Run '${requestedRunId}' does not exist.`
              : "No previous runs found.",
          });
        }

        if (sourceRun.state.status === "active") {
          return jsonResult({
            error: "That run is still active — nothing to resume.",
            runId: sourceRun.runId,
          });
        }

        if (sourceRun.state.status === "completed") {
          return jsonResult({
            error: "That run completed successfully — use harness_start with nextPlanPath instead.",
            runId: sourceRun.runId,
          });
        }

        // Load context from the source run
        const sourceCheckpoints = state.readCheckpoints(runsDir, sourceRun.runId);
        const lastCheckpoint = sourceCheckpoints.length > 0
          ? sourceCheckpoints[sourceCheckpoints.length - 1]
          : null;
        const sourceFeatures = state.readFeatures(runsDir, sourceRun.runId);
        const sourceDod = state.readDodItems(runsDir, sourceRun.runId);
        const contextSnapshot = sourceRun.state.lastContextSnapshot ?? lastCheckpoint?.contextSnapshot;

        // Create new run carrying over state
        const newRunId = state.generateRunId();
        const now = new Date().toISOString();

        const newRunState: state.RunState = {
          runId: newRunId,
          planPath: sourceRun.state.planPath,
          taskDescription: sourceRun.state.taskDescription,
          startedAt: now,
          phase: lastCheckpoint?.phase ?? sourceRun.state.phase,
          round: sourceRun.state.round + 1,
          checkpoints: [],
          status: "active",
          resumedFrom: sourceRun.runId,
          ...(sessionCtx.currentSessionKey ? { sessionKey: sessionCtx.currentSessionKey } : {}),
          ...(sourceRun.state.telegramChatId ? { telegramChatId: sourceRun.state.telegramChatId } : {}),
          ...(sourceRun.state.telegramThreadId ? { telegramThreadId: sourceRun.state.telegramThreadId } : {}),
          ...(sourceRun.state.verifyCommand ? { verifyCommand: sourceRun.state.verifyCommand } : {}),
          ...(sourceRun.state.parentRunId ? { parentRunId: sourceRun.state.parentRunId } : {}),
          ...(contextSnapshot ? { lastContextSnapshot: contextSnapshot } : {}),
        };

        state.writeRunState(runsDir, newRunId, newRunState);

        // Carry over DoD items and features
        if (sourceDod.length > 0) {
          state.writeDodItems(runsDir, newRunId, sourceDod);
        }
        if (sourceFeatures.length > 0) {
          state.writeFeatures(runsDir, newRunId, sourceFeatures);
        }

        // Build resume briefing for the agent
        const completedFeatures = lastCheckpoint?.completedFeatures ?? [];
        const pendingFeatures = lastCheckpoint?.pendingFeatures ?? [];
        const blockers = lastCheckpoint?.blockers ?? [];

        const briefing: string[] = [
          `# Resume Briefing`,
          ``,
          `**Original Run:** ${sourceRun.runId}`,
          `**Status:** ${sourceRun.state.status}`,
          `**Task:** ${sourceRun.state.taskDescription}`,
          `**Phase when stopped:** ${lastCheckpoint?.phase ?? sourceRun.state.phase}`,
          `**Round:** ${newRunState.round}`,
          ``,
          `## Completed (${completedFeatures.length})`,
          ...completedFeatures.map(f => `- ✅ ${f}`),
          ``,
          `## Pending (${pendingFeatures.length})`,
          ...pendingFeatures.map(f => `- ⬜ ${f}`),
          ``,
        ];

        if (blockers.length > 0) {
          briefing.push(`## Blockers from previous run`);
          briefing.push(...blockers.map(b => `- 🚫 ${b}`));
          briefing.push(``);
        }

        if (contextSnapshot) {
          briefing.push(`## Context Snapshot`);
          if (contextSnapshot.currentApproach) {
            briefing.push(`**Approach:** ${contextSnapshot.currentApproach}`);
          }
          if (contextSnapshot.keyDecisions && contextSnapshot.keyDecisions.length > 0) {
            briefing.push(`**Key Decisions:**`);
            briefing.push(...contextSnapshot.keyDecisions.map(d => `- ${d}`));
          }
          if (contextSnapshot.filesModified && contextSnapshot.filesModified.length > 0) {
            briefing.push(`**Files Modified:**`);
            briefing.push(...contextSnapshot.filesModified.map(f => `- \`${f}\``));
          }
          if (contextSnapshot.nextSteps && contextSnapshot.nextSteps.length > 0) {
            briefing.push(`**Next Steps:**`);
            briefing.push(...contextSnapshot.nextSteps.map(s => `- ${s}`));
          }
          briefing.push(``);
        }

        if (lastCheckpoint?.summary) {
          briefing.push(`## Last Summary`);
          briefing.push(lastCheckpoint.summary);
          briefing.push(``);
        }

        // Write briefing to disk for cross-session access
        const runDir = state.getRunDir(runsDir, newRunId);
        state.ensureDir(runDir);
        const briefingText = briefing.join("\n");
        const briefingPath = `${runDir}/resume-briefing.md`;
        fs.writeFileSync(briefingPath, briefingText);

        // Render progress bar
        const progressBar = renderProgressBar({
          taskDescription: newRunState.taskDescription,
          phase: newRunState.phase,
          completedFeatures,
          pendingFeatures,
          blockers,
          dodTotal: sourceDod.length,
          dodCompleted: completedFeatures.length,
          elapsedSeconds: 0,
        });

        const result: Record<string, unknown> = {
          success: true,
          resumed: true,
          newRunId,
          resumedFrom: sourceRun.runId,
          originalStatus: sourceRun.state.status,
          round: newRunState.round,
          phase: newRunState.phase,
          completedCount: completedFeatures.length,
          pendingCount: pendingFeatures.length,
          blockerCount: blockers.length,
          hasContextSnapshot: !!contextSnapshot,
          briefingPath,
          progressBar,
          briefing: briefingText,
        };

        if (newRunState.telegramChatId) {
          result.telegramAutoManaged = true;
          result.telegramChatId = newRunState.telegramChatId;
          if (newRunState.telegramThreadId) result.telegramThreadId = newRunState.telegramThreadId;
        }

        result.instruction = "Read the resume briefing above carefully. Continue from where the previous run stopped. " +
          "Call harness_checkpoint to record your progress. Do NOT restart completed features.";

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_resume failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_status ───

export function createHarnessStatusTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_status",
    label: "Harness Status",
    description:
      "Inspect current or past harness runs. Shows run state, phase, elapsed time, " +
      "completed/pending features, blockers, and checkpoint count. " +
      "Also lists the last 5 completed runs with grades and durations.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description:
            "Specific run ID to inspect. If omitted, shows the active run or most recent.",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const requestedRunId = validation.readOptionalStringParam(p, "runId");

        // Special case: runId=all → return summary of all runs
        if (requestedRunId === "all") {
          const allRuns = state.listAllRuns(runsDir);
          const summary = {
            totalRuns: allRuns.length,
            completed: allRuns.filter(r => r.status === "completed").length,
            cancelled: allRuns.filter(r => r.status === "cancelled").length,
            failed: allRuns.filter(r => r.status === "failed").length,
            active: allRuns.filter(r => r.status === "active").length,
            runs: allRuns.map(r => ({
              runId: r.runId,
              task: r.taskDescription.slice(0, 60),
              status: r.status,
              phase: r.phase,
            })),
          };
          return jsonResult(summary);
        }

        let target: { runId: string; state: state.RunState } | null = null;

        if (requestedRunId) {
          const s = state.readRunState(runsDir, requestedRunId);
          if (s) target = { runId: requestedRunId, state: s };
        } else {
          target = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey) ?? state.findMostRecentRun(runsDir);
        }

        if (!target) {
          return jsonResult({
            message: "No harness runs found.",
            runsDir,
          });
        }

        const { runId, state: runState } = target;
        const checkpoints = state.readCheckpoints(runsDir, runId);
        const latestCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
        const elapsed = elapsedSeconds(runState.startedAt);

        const result: Record<string, unknown> = {
          runId,
          status: runState.status,
          phase: runState.phase,
          round: runState.round,
          taskDescription: runState.taskDescription,
          startedAt: runState.startedAt,
          elapsed: formatDuration(elapsed),
          elapsedSeconds: elapsed,
          checkpointCount: checkpoints.length,
          sessionKey: runState.sessionKey ?? "unscoped (legacy)",
        };

        // Show how many concurrent runs are active
        const allActive = state.findAllActiveRuns(runsDir);
        if (allActive.length > 1) {
          result.concurrentRuns = allActive.map(r => ({
            runId: r.runId,
            task: r.state.taskDescription.slice(0, 60),
            sessionKey: r.state.sessionKey ?? "unscoped",
          }));
        }

        if (latestCheckpoint) {
          result.latestCheckpoint = {
            timestamp: latestCheckpoint.timestamp,
            phase: latestCheckpoint.phase,
            completedFeatures: latestCheckpoint.completedFeatures,
            pendingFeatures: latestCheckpoint.pendingFeatures,
            blockerCount: latestCheckpoint.blockers.length,
            summary: latestCheckpoint.summary,
          };
        }

        // Include feature status if available
        const features = state.readFeatures(runsDir, runId);
        if (features.length > 0) {
          const passed = features.filter(f => f.status === "passed").length;
          const failed2 = features.filter(f => f.status === "failed").length;
          const inProgress = features.filter(f => f.status === "in_progress").length;
          const pending = features.filter(f => f.status === "pending").length;
          const deferred = features.filter(f => f.status === "deferred").length;
          result.featureStatus = { passed, failed: failed2, inProgress, pending, deferred, total: features.length };
        }

        const completed = state.listCompletedRuns(runsDir, 5);
        if (completed.length > 0) {
          result.recentCompleted = completed.map((c) => ({
            runId: c.runId,
            taskDescription: c.state.taskDescription,
            evalGrade: c.delivery?.evalGrade ?? "unknown",
            elapsed: c.delivery ? formatDuration(c.delivery.elapsedSeconds) : "unknown",
            deliveredAt: c.delivery?.deliveredAt ?? "unknown",
          }));
        }

        // Show manifest progress if this run belongs to one
        const manifest = state.findManifestByRunId(runsDir, runId)
          ?? (runState.parentRunId ? state.readManifest(runsDir, runState.parentRunId) : null)
          ?? state.findActiveManifest(runsDir);
        if (manifest) {
          const completedPlans = manifest.plans.filter(p => p.status === "completed").length;
          const activePlans = manifest.plans.filter(p => p.status === "active").length;
          const pendingPlans = manifest.plans.filter(p => p.status === "pending").length;
          result.manifest = {
            manifestId: manifest.manifestId,
            project: manifest.projectDescription,
            totalPhases: manifest.plans.length,
            completedPhases: completedPlans,
            activePhases: activePlans,
            pendingPhases: pendingPlans,
            currentPhase: manifest.currentPhase,
            phases: manifest.plans.map(p => ({
              phase: p.phase,
              title: p.title,
              status: p.status,
              evalGrade: p.evalGrade,
            })),
          };
        }

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_status failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_plan ───

export function createHarnessPlanTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_plan",
    description:
      "Decompose a large project into N sequential plan files with a master manifest. " +
      "Each plan gets a title, context, Definition of Done, estimated duration, and dependencies. " +
      "The manifest tracks overall progress and enables auto-chaining between phases. " +
      "Use this BEFORE harness_start when a project is too big for a single run.",
    parameters: {
      type: "object" as const,
      properties: {
        projectDescription: {
          type: "string",
          description: "High-level description of the full project to decompose.",
        },
        plans: {
          type: "array",
          description: "Array of plan objects, each with: title, dod (array of DoD strings), estimatedMinutes, dependsOn (array of phase numbers, empty for first), parallel (bool).",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              context: { type: "string", description: "Context and background for this phase." },
              dod: { type: "array", items: { type: "string" }, description: "Definition of Done items (checkable)." },
              estimatedMinutes: { type: "number" },
              dependsOn: { type: "array", items: { type: "number" }, description: "Phase numbers this depends on (1-based). Empty array for independent." },
              parallel: { type: "boolean", description: "Can this run in parallel with other plans at the same dependency level?" },
            },
            required: ["title", "dod"],
          },
        },
        plansDir: {
          type: "string",
          description: "Directory to write plan files. Defaults to workspace/plans/<manifestId>/.",
        },
        autoStart: {
          type: "boolean",
          description: "If true, automatically trigger harness_start for the first plan.",
        },
      },
      required: ["projectDescription", "plans"],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const projectDescription = p.projectDescription as string;
        const planDefs = p.plans as Array<{
          title: string;
          context?: string;
          dod: string[];
          estimatedMinutes?: number;
          dependsOn?: number[];
          parallel?: boolean;
        }>;
        const customPlansDir = p.plansDir as string | undefined;
        const autoStart = p.autoStart as boolean | undefined;

        if (!projectDescription || !planDefs || planDefs.length === 0) {
          return jsonResult({
            error: "projectDescription and at least one plan are required.",
          });
        }

        // Generate manifest ID
        const manifestId = state.generateRunId();

        // Determine plans directory
        const workspaceDir = process.env.OPENCLAW_WORKSPACE
          ?? `${process.env.HOME ?? "/tmp"}/.openclaw/workspace`;
        const plansDir = customPlansDir
          ?? `${workspaceDir}/plans/${manifestId}`;
        state.ensureDir(plansDir);

        // Generate plan files and manifest entries
        const manifestPlans: state.ManifestPlan[] = [];

        for (let i = 0; i < planDefs.length; i++) {
          const def = planDefs[i];
          const phase = i + 1;
          const paddedPhase = String(phase).padStart(2, "0");
          const filename = `phase-${paddedPhase}.md`;
          const filePath = `${plansDir}/${filename}`;

          // Build plan markdown
          const lines: string[] = [
            `# Phase ${phase}: ${def.title}`,
            ``,
          ];
          if (def.context) {
            lines.push(`## Context`);
            lines.push(def.context);
            lines.push(``);
          }
          if (phase > 1 || (def.dependsOn && def.dependsOn.length > 0)) {
            const deps = def.dependsOn && def.dependsOn.length > 0
              ? def.dependsOn.map(d => `Phase ${d}`).join(", ")
              : `Phase ${phase - 1}`;
            lines.push(`**Depends on:** ${deps}`);
            lines.push(``);
          }
          if (def.estimatedMinutes) {
            lines.push(`**Estimated:** ~${def.estimatedMinutes} minutes`);
            lines.push(``);
          }
          lines.push(`## Definition of Done`);
          lines.push(``);
          for (const item of def.dod) {
            lines.push(`- [ ] ${item}`);
          }
          lines.push(``);

          fs.writeFileSync(filePath, lines.join("\n"));

          manifestPlans.push({
            phase,
            title: def.title,
            path: filePath,
            dependsOn: def.dependsOn ?? (phase > 1 ? [phase - 1] : []),
            parallel: def.parallel ?? false,
            estimatedMinutes: def.estimatedMinutes,
            status: "pending",
          });
        }

        // Create and write manifest
        const manifest: state.Manifest = {
          manifestId,
          projectDescription,
          createdAt: new Date().toISOString(),
          plansDir,
          plans: manifestPlans,
          currentPhase: 1,
          status: "active",
        };

        state.writeManifest(runsDir, manifest);

        // Write a summary manifest.md for human readability
        const summaryLines = [
          `# Project Manifest: ${projectDescription}`,
          ``,
          `**ID:** ${manifestId}`,
          `**Created:** ${manifest.createdAt}`,
          `**Phases:** ${manifestPlans.length}`,
          ``,
          `## Phase Overview`,
          ``,
          `| # | Title | Depends On | Parallel | Est. | Status |`,
          `|---|---|---|---|---|---|`,
        ];
        for (const plan of manifestPlans) {
          const deps = plan.dependsOn.length > 0 ? plan.dependsOn.join(", ") : "—";
          const par = plan.parallel ? "✅" : "—";
          const est = plan.estimatedMinutes ? `${plan.estimatedMinutes}m` : "—";
          summaryLines.push(`| ${plan.phase} | ${plan.title} | ${deps} | ${par} | ${est} | ${plan.status} |`);
        }
        summaryLines.push(``);
        fs.writeFileSync(`${plansDir}/manifest.md`, summaryLines.join("\n"));

        const result: Record<string, unknown> = {
          success: true,
          manifestId,
          plansDir,
          planCount: manifestPlans.length,
          plans: manifestPlans.map(p => ({
            phase: p.phase,
            title: p.title,
            path: p.path,
            dependsOn: p.dependsOn,
            parallel: p.parallel,
            estimatedMinutes: p.estimatedMinutes,
          })),
          firstPlanPath: manifestPlans[0]?.path,
        };

        // Auto-start first plan if requested
        if (autoStart && manifestPlans.length > 0) {
          result.autoStartHint =
            `🚀 AUTO-START: Call harness_start now with planPath="${manifestPlans[0].path}" ` +
            `and parentRunId="${manifestId}" to begin Phase 1.`;
        } else {
          result.hint =
            `To begin, call harness_start with planPath="${manifestPlans[0]?.path}" ` +
            `and parentRunId="${manifestId}".`;
        }

        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: `harness_plan failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
