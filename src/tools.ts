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

function parseTelegramSessionKey(
  sessionKey: string | undefined,
): { chatId: string; threadId?: string } | null {
  if (!sessionKey) return null;
  const forumMatch = sessionKey.match(/telegram:group:([-\d]+):topic:(\d+)/);
  if (forumMatch) return { chatId: forumMatch[1], threadId: forumMatch[2] };
  const groupMatch = sessionKey.match(/telegram:group:([-\d]+)$/);
  if (groupMatch) return { chatId: groupMatch[1] };
  const dmMatch = sessionKey.match(/telegram:(?:dm|direct):([-\d]+)/);
  if (dmMatch) return { chatId: dmMatch[1] };
  return null;
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
      "Initialise a new harness run. Creates a run directory, records the plan, extracts DoD items, and generates a Contract Document. " +
      "The Contract Document is the single source of truth: each DoD item becomes a contract item with acceptance criteria, " +
      "verify commands, and retry limits. The agent works through items one-by-one; each is auto-verified on checkpoint. " +
      "Call this at the start of every harness pipeline. Only one active run is allowed at a time. " +
      "SILENT WORK MODE: During a harness run, do NOT send separate progress messages. " +
      "Do NOT send any text messages to the chat. Do NOT use the message tool. " +
      "Use harness_checkpoint with currentAction to update the progress bar instead. " +
      "Work silently: read, edit, exec, checkpoint. Only speak after harness_submit.",
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
        isSubagent: {
          type: "boolean",
          description: "Set to true when running inside a subagent. Enables shorter stale timeout and auto-report to parent manifest.",
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
        const telegramChatId = validation.readOptionalStringParam(p, "telegramChatId");
        const telegramThreadId = validation.readOptionalStringParam(p, "telegramThreadId");
        const verifyCommand = validation.readOptionalStringParam(p, "verifyCommand");
        const parentRunId = validation.readOptionalStringParam(p, "parentRunId");
        const isSubagent = p.isSubagent as boolean | undefined;

        // Check for already-active run ON THIS SESSION (allows concurrent runs on different sessions)
        const sessionKey = sessionCtx.currentSessionKey;
        // When Telegram params are explicitly provided, derive session key from them
        // (more reliable than ctx.sessionKey which may come from cron/subagent context)
        // Also try to parse Telegram IDs from sessionKey when params not provided
        let resolvedChatId = telegramChatId;
        let resolvedThreadId = telegramThreadId;
        if (!resolvedChatId && sessionKey) {
          const parsed = parseTelegramSessionKey(sessionKey);
          if (parsed) {
            resolvedChatId = parsed.chatId;
            resolvedThreadId = resolvedThreadId || parsed.threadId;
          }
        }
        const effectiveSessionKey = 
          (resolvedChatId && resolvedThreadId 
            ? `agent:main:telegram:group:${resolvedChatId}:topic:${resolvedThreadId}`
            : resolvedChatId 
              ? `agent:main:telegram:direct:${resolvedChatId}`
              : null)
          || sessionKey;
        const active = state.findActiveRunForSession(runsDir, effectiveSessionKey);
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

        const runState: state.RunState = {
          runId,
          planPath,
          taskDescription,
          startedAt: now,
          phase: "plan",
          round: 1,
          checkpoints: [],
          status: "active",
          ...(effectiveSessionKey ? { sessionKey: effectiveSessionKey } : {}),
          ...(resolvedChatId ? { telegramChatId: resolvedChatId } : {}),
          ...(resolvedThreadId ? { telegramThreadId: resolvedThreadId } : {}),
          ...(verifyCommand ? { verifyCommand } : {}),
          ...(parentRunId ? { parentRunId } : {}),
          ...(isSubagent ? { isSubagent: true } : {}),
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

        // Generate contract document from plan
        const contractItems = validation.extractContractItems(planContent);
        if (contractItems.length > 0) {
          // Apply global verifyCommand to items without their own
          if (verifyCommand) {
            for (const item of contractItems) {
              if (!item.verifyCommand) {
                item.verifyCommand = verifyCommand;
              }
            }
          }
          state.writeContract(runsDir, runId, contractItems);

          // Write human-readable contract.md
          const contractMd = state.renderContractMarkdown(contractItems, taskDescription);
          const runDir = state.getRunDir(runsDir, runId);
          fs.writeFileSync(`${runDir}/contract.md`, contractMd);
        }

        // Load cross-run learning for context
        const globalLearning = state.readGlobalLearning(runsDir);
        const relevantLessons = globalLearning
          .filter(l => l.outcome === "failure")
          .slice(-10)
          .map(l => `⚠️ [${l.itemId}] ${l.lesson}`);

        // Detect project working directory from plan path
        const planDir = planPath.substring(0, planPath.lastIndexOf("/"));
        const projectDir = planDir.includes("/plans/") ? planDir.split("/plans/")[0] : planDir;
        runState.workingDirectory = projectDir;
        state.writeRunState(runsDir, runId, runState);

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
          contractItemCount: contractItems.length,
          progressBar,
        };

        // Contract-driven workflow: tell agent what to do first
        if (contractItems.length > 0) {
          const firstItem = state.getNextContractItem(contractItems);
          if (firstItem) {
            result.contractMode = true;
            result.nextItem = {
              id: firstItem.id,
              description: firstItem.description,
              acceptanceCriteria: firstItem.acceptanceCriteria,
              verifyCommand: firstItem.verifyCommand,
              verifyFileExists: firstItem.verifyFileExists,
            };
            result.contractInstruction =
              `\ud83d\udcdd CONTRACT MODE: Work through items one-by-one.\n` +
              `\ud83d\udd34 CURRENT ITEM: [${firstItem.id}] ${firstItem.description}\n` +
              `\ud83c\udfaf Acceptance criteria:\n${firstItem.acceptanceCriteria.map(ac => `  - ${ac}`).join("\n")}\n` +
              (firstItem.verifyCommand ? `\ud83e\uddea Verify: ${firstItem.verifyCommand}\n` : "") +
              (firstItem.verifyFileExists ? `\ud83d\udcc1 Required files: ${firstItem.verifyFileExists.join(", ")}\n` : "") +
              `\n\u2705 When done, call harness_checkpoint with completedFeatures=["${firstItem.description}"].\n` +
              `The system will auto-verify and advance to the next item.\n` +
              `\n\ud83d\udca1 AUTONOMY RULES:\n` +
              `- If stuck on an item for >3 attempts, use harness_modify to skip it and continue\n` +
              `- If you discover the plan is wrong, use harness_modify to add/split/skip items\n` +
              `- If you hit an error you don't understand, search the web before retrying\n` +
              `- Checkpoint frequently (every major change) — the system enforces this\n` +
              `- Git snapshots are taken before each item for safe rollback`;

            // Check for parallel items
            const parallelItems = state.getParallelContractItems(contractItems);
            if (parallelItems.length > 1) {
              result.parallelItems = parallelItems.map(i => ({ id: i.id, description: i.description }));
              result.parallelHint =
                `\ud83d\udd00 ${parallelItems.length} items can run in parallel: ${parallelItems.map(i => i.id).join(", ")}. ` +
                `Consider spawning subagents for the others.`;
            }
          }
        }

        // Include learning from past runs
        if (relevantLessons.length > 0) {
          result.learningFromPastRuns = relevantLessons;
          result.learningHint = `\ud83d\udcda Past failures to avoid:\n${relevantLessons.join("\n")}`;
        }

        if (telegramChatId) {
          result.telegramAutoManaged = true;
          result.telegramChatId = telegramChatId;
          if (telegramThreadId) result.telegramThreadId = telegramThreadId;
          result.silentWorkMode =
            "⚠️ SILENT WORK MODE ACTIVE — ZERO MESSAGES ALLOWED\n\n" +
            "During this harness run:\n" +
            "• Do NOT send ANY text messages to the chat\n" +
            "• Do NOT call the message tool\n" +
            "• Do NOT explain what you're doing in chat\n" +
            "• ALL status updates go through harness_checkpoint with currentAction field\n" +
            "• The progress bar auto-updates on every checkpoint — that IS your communication channel\n" +
            "• Work silently: read → edit → exec → checkpoint. Repeat.\n" +
            "• Only speak when the run is DELIVERED (after harness_submit)";
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
      "blockers, and a summary. Data persists to disk and survives context compaction. " +
      "In CONTRACT MODE: when you mark a feature as completed, the system auto-verifies it against " +
      "the Contract Document (runs verify commands, checks file existence). If verification fails, " +
      "it returns retry instructions. If it passes, it advances to the next contract item.",
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
        gate: {
          type: "string",
          description: "Optional quality gate level: lint, unit, integration, e2e. Gates must progress sequentially — can't skip from lint to e2e.",
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
        const gate = validation.readOptionalStringParam(p, "gate") as "lint" | "unit" | "integration" | "e2e" | undefined;

        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (!active) {
          return jsonResult({
            error: "No active harness run found.",
            hint: "Call harness_start first to initialise a run.",
          });
        }

        const { runId, state: runState } = active;

        // Quality gate validation — enforce sequential progression
        const GATE_ORDER = ["lint", "unit", "integration", "e2e"] as const;
        if (gate) {
          const gateIndex = GATE_ORDER.indexOf(gate);
          if (gateIndex === -1) {
            return jsonResult({
              error: `Invalid gate "${gate}". Valid gates: ${GATE_ORDER.join(", ")}`,
            });
          }
          // Check previous checkpoints for the highest gate reached
          const checkpoints = state.readCheckpoints(runsDir, runId);
          let highestGateIndex = -1;
          for (const cp of checkpoints) {
            const cpGate = (cp as Record<string, unknown>).gate as string | undefined;
            if (cpGate) {
              const idx = GATE_ORDER.indexOf(cpGate as typeof GATE_ORDER[number]);
              if (idx > highestGateIndex) highestGateIndex = idx;
            }
          }
          // Can only advance by 1 gate at a time (or start at lint)
          if (gateIndex > highestGateIndex + 1) {
            const expectedGate = GATE_ORDER[highestGateIndex + 1];
            return jsonResult({
              error: `Gate skip detected: trying "${gate}" but "${expectedGate}" hasn't passed yet.`,
              hint: `Gates must progress sequentially: ${GATE_ORDER.join(" → ")}. Complete "${expectedGate}" first.`,
              currentGate: highestGateIndex >= 0 ? GATE_ORDER[highestGateIndex] : "none",
              requestedGate: gate,
            });
          }
        }

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
          runState.lastCheckpointAt = now;  // Track for forced checkpoint detection
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
            ...(gate ? { gate } : {}),
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

          // ─── Contract verification: auto-verify completed items ───
          const contract = state.readContract(runsDir, runId);
          const contractVerification: Array<{ id: string; description: string; result: "passed" | "failed"; evidence?: string; error?: string }> = [];
          let nextContractItem: state.ContractItem | null = null;

          if (contract.length > 0) {
            // Match completed features to contract items
            for (const featureName of completedFeatures) {
              const featureLower = featureName.toLowerCase();
              // Find matching contract item
              const item = contract.find(c =>
                c.status !== "passed" && c.status !== "skipped" && (
                  c.description.toLowerCase() === featureLower ||
                  c.description.toLowerCase().includes(featureLower.slice(0, 30)) ||
                  featureLower.includes(c.description.toLowerCase().slice(0, 30))
                )
              );
              if (!item) continue;

              // Mark as in_progress if first attempt
              if (item.status === "pending") {
                item.status = "in_progress";
                item.startedAt = item.startedAt ?? new Date().toISOString();
              }
              item.attempts += 1;

              let verified = true;
              const evidenceParts: string[] = [];

              // 1. Check required files exist
              if (item.verifyFileExists && item.verifyFileExists.length > 0) {
                for (const filePath of item.verifyFileExists) {
                  if (fs.existsSync(filePath)) {
                    evidenceParts.push(`✅ File exists: ${filePath}`);
                  } else {
                    verified = false;
                    evidenceParts.push(`❌ File missing: ${filePath}`);
                  }
                }
              }

              // 2. Run verify command if specified
              if (item.verifyCommand && verified) {
                try {
                  const { execSync } = require("node:child_process");
                  const output = execSync(item.verifyCommand, {
                    timeout: 60_000,
                    encoding: "utf-8" as const,
                    stdio: ["pipe", "pipe", "pipe"] as const,
                  });
                  evidenceParts.push(`✅ Verify passed: ${item.verifyCommand}`);
                  evidenceParts.push(String(output).slice(-300));
                } catch (verifyErr: unknown) {
                  verified = false;
                  const errMsg = verifyErr instanceof Error
                    ? (verifyErr as { stderr?: string }).stderr ?? verifyErr.message
                    : String(verifyErr);
                  evidenceParts.push(`❌ Verify failed: ${String(errMsg).slice(-300)}`);
                }
              }

              if (verified) {
                item.status = "passed";
                item.completedAt = new Date().toISOString();
                item.evidence = evidenceParts.join("\n").slice(0, 1000);
                contractVerification.push({
                  id: item.id,
                  description: item.description,
                  result: "passed",
                  evidence: item.evidence,
                });

                // Learning: record success
                const itemDuration = item.startedAt
                  ? Math.round((Date.now() - new Date(item.startedAt).getTime()) / 1000)
                  : undefined;
                state.appendLearning(runsDir, runId, {
                  timestamp: new Date().toISOString(),
                  itemId: item.id,
                  description: item.description,
                  approach: contextSnapshot?.currentApproach ?? "direct implementation",
                  outcome: "success",
                  lesson: `Completed in ${item.attempts} attempt(s)${itemDuration ? ` (${Math.round(itemDuration / 60)}min)` : ""}`,
                  durationSeconds: itemDuration,
                });
              } else {
                item.status = "failed";
                item.failureLog = evidenceParts.join("\n").slice(0, 1000);
                contractVerification.push({
                  id: item.id,
                  description: item.description,
                  result: "failed",
                  error: item.failureLog,
                });

                // Learning: record failure
                state.appendLearning(runsDir, runId, {
                  timestamp: new Date().toISOString(),
                  itemId: item.id,
                  description: item.description,
                  approach: contextSnapshot?.currentApproach ?? "unknown",
                  outcome: "failure",
                  lesson: `Attempt ${item.attempts}/${item.maxAttempts} failed: ${item.failureLog?.slice(0, 200) ?? "unknown"}`,
                });

                // Self-healing: if max attempts exhausted, auto-skip if possible
                if (item.attempts >= item.maxAttempts) {
                  const canSkip = contract.some(c =>
                    c.id !== item.id &&
                    c.status === "pending" &&
                    (!c.dependsOn || !c.dependsOn.includes(item.id))
                  );
                  if (canSkip) {
                    item.status = "skipped";
                    item.skipReason = `Auto-skipped after ${item.maxAttempts} failed attempts. Will revisit.`;
                    state.appendLearning(runsDir, runId, {
                      timestamp: new Date().toISOString(),
                      itemId: item.id,
                      description: item.description,
                      approach: "auto-skip",
                      outcome: "failure",
                      lesson: `Exhausted ${item.maxAttempts} attempts. Auto-skipped to unblock progress.`,
                    });
                  }
                }

                // Git rollback hint if available
                if (item.gitTag && runState.workingDirectory) {
                  evidenceParts.push(`Git rollback: git checkout ${item.gitTag} in ${runState.workingDirectory}`);
                }
              }
            }

            // Git snapshot before next item
            const nextForSnapshot = state.getNextContractItem(contract);
            if (nextForSnapshot && runState.workingDirectory) {
              try {
                const { execSync } = require("node:child_process");
                try {
                  execSync(`git rev-parse --git-dir`, {
                    cwd: runState.workingDirectory,
                    timeout: 5_000,
                    stdio: ["pipe", "pipe", "pipe"],
                  });
                  const commitHash = execSync(`git rev-parse HEAD`, {
                    cwd: runState.workingDirectory,
                    timeout: 5_000,
                    encoding: "utf-8",
                    stdio: ["pipe", "pipe", "pipe"],
                  }).trim();
                  nextForSnapshot.gitTag = commitHash;
                } catch {
                  // Not a git repo — skip snapshot
                }
              } catch {
                // Git not available
              }
            }

            // Save updated contract
            state.writeContract(runsDir, runId, contract);

            // Track current item for timeout detection
            const nextActionable = state.getNextContractItem(contract);
            if (nextActionable) {
              runState.currentContractItemId = nextActionable.id;
              runState.currentItemStartedAt = new Date().toISOString();
              state.writeRunState(runsDir, runId, runState);
            }

            // Find next item to work on
            nextContractItem = nextActionable;
          }

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

          // Contract verification results + next item instruction
          if (contractVerification.length > 0) {
            res.contractVerification = contractVerification;

            const failed = contractVerification.filter(v => v.result === "failed");
            const passed2 = contractVerification.filter(v => v.result === "passed");

            if (failed.length > 0) {
              // Item(s) failed verification — instruct agent to retry or self-heal
              const failedItem = failed[0];
              const contractItem = contract.find(c => c.id === failedItem.id);
              const remaining = contractItem ? contractItem.maxAttempts - contractItem.attempts : 0;

              if (remaining > 0) {
                // Still has retries — try to fix
                res.contractInstruction =
                  `\u274c CONTRACT ITEM [${failedItem.id}] FAILED VERIFICATION\n` +
                  `Description: ${failedItem.description}\n` +
                  `Error: ${failedItem.error?.slice(0, 300) ?? "Unknown"}\n` +
                  `Attempts: ${contractItem?.attempts ?? "?"}/${contractItem?.maxAttempts ?? 3} (${remaining} remaining)\n` +
                  `\n\ud83d\udd27 FIX the issue and call harness_checkpoint again with this item in completedFeatures.\n` +
                  `\ud83d\udca1 If stuck, try:\n` +
                  `  1. Search the web for the error message\n` +
                  `  2. Try a different approach (use harness_modify to update acceptance criteria)\n` +
                  `  3. If truly blocked, call harness_modify action=skip to skip and continue`;
              } else if (contractItem?.status === "skipped") {
                // Auto-skipped — moved to next item
                res.contractInstruction =
                  `\u23ed\ufe0f ITEM [${failedItem.id}] AUTO-SKIPPED (exhausted ${contractItem.maxAttempts} attempts)\n` +
                  `Reason: ${contractItem.skipReason ?? "max retries"}\n` +
                  `Continuing with next available item...\n` +
                  (nextContractItem ? `\ud83d\udd34 NEXT: [${nextContractItem.id}] ${nextContractItem.description}` : "No more items.");
              } else {
                // Exhausted and can't skip (dependencies block)
                res.contractInstruction =
                  `\ud83d\uded1 ITEM [${failedItem.id}] BLOCKED \u2014 ${contractItem?.attempts}/${contractItem?.maxAttempts} attempts failed\n` +
                  `Other items depend on this one. Cannot auto-skip.\n` +
                  `\ud83d\udea8 ESCALATION: Alert the user or try a fundamentally different approach.\n` +
                  `Consider: harness_modify action=split to break this into smaller sub-tasks.`;
                res.escalationNeeded = true;
              }
            } else if (passed2.length > 0 && nextContractItem) {
              // Item(s) passed, advance to next
              const contractStats = contract.length > 0 ? {
                total: contract.length,
                passed: contract.filter(c => c.status === "passed").length,
                failed: contract.filter(c => c.status === "failed").length,
                pending: contract.filter(c => c.status === "pending").length,
              } : undefined;

              res.contractProgress = contractStats;
              res.contractInstruction =
                `\u2705 Item(s) verified! Progress: ${contractStats?.passed}/${contractStats?.total}\n` +
                `\n\ud83d\udd34 NEXT ITEM: [${nextContractItem.id}] ${nextContractItem.description}\n` +
                `\ud83c\udfaf Acceptance criteria:\n${nextContractItem.acceptanceCriteria.map(ac => `  - ${ac}`).join("\n")}\n` +
                (nextContractItem.verifyCommand ? `\ud83e\uddea Verify: ${nextContractItem.verifyCommand}\n` : "") +
                (nextContractItem.verifyFileExists ? `\ud83d\udcc1 Required files: ${nextContractItem.verifyFileExists.join(", ")}\n` : "") +
                `\nImplement this item and call harness_checkpoint with completedFeatures=["${nextContractItem.description}"].`;

              // Check for parallel items
              const parallelItems = state.getParallelContractItems(contract);
              if (parallelItems.length > 1) {
                res.parallelItems = parallelItems.map(i => ({ id: i.id, description: i.description }));
                res.parallelHint =
                  `\ud83d\udd00 ${parallelItems.length} items can run in parallel: ${parallelItems.map(i => i.id).join(", ")}. ` +
                  `Spawn subagents for the others if possible.`;
              }
            } else if (passed2.length > 0 && !nextContractItem) {
              // All items done!
              res.contractComplete = true;
              res.contractInstruction =
                `\ud83c\udf89 ALL CONTRACT ITEMS COMPLETE! (${contract.filter(c => c.status === "passed").length}/${contract.length})\n` +
                `Write the eval report and call harness_submit.`;
            }
          } else if (contract.length > 0 && nextContractItem) {
            // No verification happened but contract exists — show next item
            res.contractInstruction =
              `\ud83d\udd34 NEXT ITEM: [${nextContractItem.id}] ${nextContractItem.description}\n` +
              `\ud83c\udfaf Acceptance criteria:\n${nextContractItem.acceptanceCriteria.map(ac => `  - ${ac}`).join("\n")}\n` +
              (nextContractItem.verifyCommand ? `\ud83e\uddea Verify: ${nextContractItem.verifyCommand}\n` : "") +
              `\nImplement and call harness_checkpoint with completedFeatures=["${nextContractItem.description}"].`;
          }

          // Telegram is auto-managed by the plugin hook — pass IDs so it can send/edit
          if (runState.telegramChatId) {
            res.telegramAutoManaged = true;
            res.telegramChatId = runState.telegramChatId;
            if (runState.telegramMessageId) res.telegramMessageId = runState.telegramMessageId;
            if (runState.telegramThreadId) res.telegramThreadId = runState.telegramThreadId;
          }

          // File conflict detection across concurrent runs
          if (contextSnapshot?.filesModified && contextSnapshot.filesModified.length > 0) {
            const allActive = state.findAllActiveRuns(runsDir);
            const conflicts: string[] = [];
            for (const other of allActive) {
              if (other.runId === runId) continue;
              const otherFiles = other.state.lastContextSnapshot?.filesModified;
              if (!otherFiles) continue;
              const overlap = contextSnapshot.filesModified.filter(f => otherFiles.includes(f));
              if (overlap.length > 0) {
                conflicts.push(
                  `Run "${other.state.taskDescription}" also modifies: ${overlap.join(", ")}`
                );
              }
            }
            if (conflicts.length > 0) {
              res.fileConflictWarning = `⚠️ FILE CONFLICTS DETECTED:\n${conflicts.join("\n")}\nCoordinate changes to avoid overwrites.`;
            }
          }

          // Auto-fix instruction when verification log shows failures
          if (verificationLog) {
            const hasFailure = /fail|error|FAIL|ERROR|✗|✘|FAILED/i.test(verificationLog)
              && !/0 fail/i.test(verificationLog);
            if (hasFailure) {
              res.autoFixInstruction =
                `🔧 AUTO-FIX: Test failures detected in verification log. ` +
                `Fix the failing tests before calling harness_checkpoint again. ` +
                `Do NOT mark features as complete until tests pass. ` +
                `Run the verify command again after fixing: ${runState.verifyCommand ?? "check your tests"}`;
            }
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
        const warnings: string[] = [];

        // 0. Auto-run verify command if set
        if (runState.verifyCommand) {
          try {
            const { execSync } = await import("node:child_process");
            const verifyOutput = execSync(runState.verifyCommand, {
              timeout: 120_000,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
              env: { ...process.env, CI: "true" },
            });
            // Check for test failures in output
            const hasFailure = /fail|error|FAIL|ERROR|\u2717|\u2718|FAILED/i.test(verifyOutput)
              && !/0 fail/i.test(verifyOutput) && !/0 error/i.test(verifyOutput);
            if (hasFailure) {
              errors.push(`Verify command failed:\n${verifyOutput.slice(-500)}`);
            }
          } catch (verifyErr) {
            const msg = verifyErr instanceof Error ? (verifyErr as { stderr?: string }).stderr ?? verifyErr.message : String(verifyErr);
            errors.push(`Verify command '${runState.verifyCommand}' failed:\n${String(msg).slice(-500)}`);
          }
        }

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

        // 2b. Check contract items (all must be passed)
        const contractItems = state.readContract(runsDir, runId);
        if (contractItems.length > 0) {
          const notPassed = contractItems.filter(c => c.status !== "passed" && c.status !== "skipped");
          if (notPassed.length > 0) {
            errors.push(
              `${notPassed.length} contract item(s) not completed:\n` +
                notPassed.map(c => `  [❌ ${c.id}] ${c.description} (status: ${c.status}, attempts: ${c.attempts}/${c.maxAttempts})`).join("\n"),
            );
          }

          // Check for items that exhausted retries
          const exhausted = contractItems.filter(c => c.status === "failed" && c.attempts >= c.maxAttempts);
          if (exhausted.length > 0) {
            warnings.push(
              `${exhausted.length} contract item(s) exhausted max attempts:\n` +
                exhausted.map(c => `  [${c.id}] ${c.description} — ${c.failureLog?.slice(0, 100) ?? "no log"}`).join("\n"),
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
          const MAX_ROUNDS = 3;
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

          // Iterative loop: increment round, return to build phase
          if (runState.round < MAX_ROUNDS) {
            runState.round += 1;
            runState.phase = "build";
            state.writeRunState(runsDir, runId, runState);

            // Append iteration checkpoint
            const iterCheckpoint: state.Checkpoint = {
              timestamp: new Date().toISOString(),
              phase: "iteration",
              completedFeatures: [],
              pendingFeatures: errors.map(e => e.slice(0, 100)),
              blockers: errors.slice(0, 3),
              summary: `Round ${runState.round - 1} failed eval. Iterating (round ${runState.round}/${MAX_ROUNDS}).`,
            };
            state.appendCheckpoint(runsDir, runId, iterCheckpoint);

            const dodItems = state.readDodItems(runsDir, runId);
            const lastCp = state.readCheckpoints(runsDir, runId);
            const prevCp = lastCp.length > 1 ? lastCp[lastCp.length - 2] : null;
            const elapsed2 = elapsedSeconds(runState.startedAt);
            const progressBar = renderProgressBar({
              taskDescription: runState.taskDescription,
              phase: `iteration ${runState.round}/${MAX_ROUNDS}`,
              completedFeatures: prevCp?.completedFeatures ?? [],
              pendingFeatures: prevCp?.pendingFeatures ?? [],
              blockers: errors.slice(0, 3),
              dodTotal: dodItems.length,
              dodCompleted: prevCp?.completedFeatures.length ?? 0,
              elapsedSeconds: elapsed2,
              workLog: [`⚠️ Round ${runState.round - 1} failed — iterating`],
            });

            const iterResult: Record<string, unknown> = {
              delivered: false,
              iteration_needed: true,
              runId,
              round: runState.round,
              maxRounds: MAX_ROUNDS,
              errors,
              recoveryHints: hints,
              progressBar,
              instruction:
                `🔄 ITERATION ${runState.round}/${MAX_ROUNDS}: Eval failed. Fix the issues below and call harness_submit again.\n` +
                `Do NOT start a new run. Stay in the current run and fix:\n` +
                errors.map((e, i) => `${i + 1}. ${e}`).join("\n") + "\n" +
                hints.join("\n"),
            };
            if (runState.telegramChatId) {
              iterResult.telegramAutoManaged = true;
              iterResult.telegramChatId = runState.telegramChatId;
              if (runState.telegramMessageId) iterResult.telegramMessageId = runState.telegramMessageId;
              if (runState.telegramThreadId) iterResult.telegramThreadId = runState.telegramThreadId;
            }
            return jsonResult(iterResult);
          }

          // Max rounds reached — hard fail
          runState.status = "failed";
          state.writeRunState(runsDir, runId, runState);

          return jsonResult({
            delivered: false,
            runId,
            failed: true,
            round: runState.round,
            errors,
            recoveryHints: hints,
            hint: `Max iterations (${MAX_ROUNDS}) reached. Run failed. Use harness_reset to start fresh.`,
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
                  // Build spawn instructions for each parallel plan
                  const spawnInstructions = parallelReady
                    .filter(p => p.phase !== nextPlan.phase) // Exclude the one we're auto-chaining to
                    .map(p =>
                      `sessions_spawn({ task: "Execute harness plan: ${p.title}", ` +
                      `label: "harness-phase-${p.phase}" }) — then inside the subagent: ` +
                      `harness_start({ planPath: "${p.path}", parentRunId: "${manifest.manifestId}", ` +
                      `isSubagent: true })`
                    );
                  res.parallelHint =
                    `🔀 ${parallelReady.length} plans can run in parallel! ` +
                    `You are auto-chaining to Phase ${nextPlan.phase}. ` +
                    `Spawn subagents for the rest:\n` +
                    spawnInstructions.join("\n");
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
          sourceRun = state.findMostRecentRun(runsDir, sessionCtx.currentSessionKey);
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
        // Carry over contract
        const sourceContract = state.readContract(runsDir, sourceRun.runId);
        if (sourceContract.length > 0) {
          state.writeContract(runsDir, newRunId, sourceContract);
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
          target = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey) ?? state.findMostRecentRun(runsDir, sessionCtx.currentSessionKey);
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

        // Include contract status if available
        const contractItems = state.readContract(runsDir, runId);
        if (contractItems.length > 0) {
          const cPassed = contractItems.filter(c => c.status === "passed").length;
          const cFailed = contractItems.filter(c => c.status === "failed").length;
          const cPending = contractItems.filter(c => c.status === "pending").length;
          const cInProgress = contractItems.filter(c => c.status === "in_progress").length;
          const nextItem = state.getNextContractItem(contractItems);
          result.contractStatus = {
            passed: cPassed,
            failed: cFailed,
            pending: cPending,
            inProgress: cInProgress,
            total: contractItems.length,
            nextItem: nextItem ? { id: nextItem.id, description: nextItem.description } : null,
            items: contractItems.map(c => ({
              id: c.id,
              description: c.description.slice(0, 60),
              status: c.status,
              attempts: c.attempts,
              maxAttempts: c.maxAttempts,
            })),
          };
        }

        const completed = state.listCompletedRuns(runsDir, 5, sessionCtx.currentSessionKey);
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

// ─── harness_challenge ───

export function createHarnessChallengeTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_challenge",
    label: "Harness Challenge",
    description:
      "Run automated quality checks on the current harness run. " +
      "Validates modified files exist, runs verify command, checks for common issues. " +
      "Returns structured findings (CRITICAL/WARNING/INFO) that must be addressed before submit.",
    parameters: {
      type: "object",
      properties: {
        checks: {
          type: "array",
          items: { type: "string" },
          description: "Optional specific checks to run: 'files', 'verify', 'syntax', 'all'. Default: 'all'.",
        },
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const checks = (p.checks as string[] | undefined) ?? ["all"];
        const runAll = checks.includes("all");

        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (!active) {
          return jsonResult({
            error: "No active harness run found.",
            hint: "Call harness_start first.",
          });
        }

        const { runId, state: runState } = active;
        const findings: Array<{ level: "CRITICAL" | "WARNING" | "INFO"; check: string; message: string }> = [];

        // 1. File existence check
        if (runAll || checks.includes("files")) {
          const snapshot = runState.lastContextSnapshot;
          if (snapshot?.filesModified) {
            for (const f of snapshot.filesModified) {
              if (!fs.existsSync(f)) {
                findings.push({ level: "CRITICAL", check: "files", message: `Modified file missing: ${f}` });
              }
            }
            if (snapshot.filesModified.length === 0) {
              findings.push({ level: "WARNING", check: "files", message: "No files recorded as modified." });
            }
          } else {
            findings.push({ level: "WARNING", check: "files", message: "No contextSnapshot.filesModified recorded." });
          }
        }

        // 2. Verify command
        if ((runAll || checks.includes("verify")) && runState.verifyCommand) {
          try {
            const { execSync } = await import("node:child_process");
            execSync(runState.verifyCommand, {
              timeout: 120_000,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
              env: { ...process.env, CI: "true" },
            });
            findings.push({ level: "INFO", check: "verify", message: `Verify passed: ${runState.verifyCommand}` });
          } catch (err) {
            const msg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
            findings.push({ level: "CRITICAL", check: "verify", message: `Verify failed: ${String(msg).slice(-300)}` });
          }
        }

        // 3. DoD progress
        if (runAll) {
          const checkpoints = state.readCheckpoints(runsDir, runId);
          const lastCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
          const dodItems = state.readDodItems(runsDir, runId);
          if (lastCp) {
            const completed = lastCp.completedFeatures.length;
            const total = dodItems.length || (completed + lastCp.pendingFeatures.length);
            if (completed < total) {
              findings.push({
                level: "WARNING",
                check: "progress",
                message: `${completed}/${total} features done. Pending: ${lastCp.pendingFeatures.slice(0, 3).join(", ")}`,
              });
            }
            if (lastCp.blockers.length > 0) {
              findings.push({ level: "CRITICAL", check: "blockers", message: `Unresolved blockers: ${lastCp.blockers.join(", ")}` });
            }
          }
        }

        // 4. Plan file + unchecked DoD
        if (runAll) {
          const planContent = validation.safeReadFile(runState.planPath);
          if (!planContent) {
            findings.push({ level: "CRITICAL", check: "plan", message: `Plan missing: ${runState.planPath}` });
          } else {
            const unchecked = validation.findUncheckedDod(planContent);
            if (unchecked.length > 0) {
              findings.push({ level: "WARNING", check: "dod", message: `${unchecked.length} unchecked DoD items` });
            }
          }
        }

        // 5. Contract validation
        if (runAll) {
          const contractItems = state.readContract(runsDir, runId);
          if (contractItems.length > 0) {
            const notPassed = contractItems.filter(c => c.status !== "passed" && c.status !== "skipped");
            if (notPassed.length > 0) {
              findings.push({
                level: "CRITICAL",
                check: "contract",
                message: `${notPassed.length}/${contractItems.length} contract items not completed: ` +
                  notPassed.map(c => `[${c.id}] ${c.description.slice(0, 40)}`).join(", "),
              });
            }
            const exhausted = contractItems.filter(c => c.status === "failed" && c.attempts >= c.maxAttempts);
            if (exhausted.length > 0) {
              findings.push({
                level: "CRITICAL",
                check: "contract",
                message: `${exhausted.length} item(s) exhausted max retries: ` +
                  exhausted.map(c => `[${c.id}] ${c.description.slice(0, 40)}`).join(", "),
              });
            }
            const passed3 = contractItems.filter(c => c.status === "passed").length;
            findings.push({
              level: "INFO",
              check: "contract",
              message: `Contract progress: ${passed3}/${contractItems.length} items passed`,
            });
          }
        }

        const criticals = findings.filter(f => f.level === "CRITICAL").length;
        const warningCount = findings.filter(f => f.level === "WARNING").length;

        runState.phase = "challenge";
        state.writeRunState(runsDir, runId, runState);

        return jsonResult({
          success: true,
          runId,
          round: runState.round,
          findings,
          summary: { critical: criticals, warning: warningCount, info: findings.length - criticals - warningCount, total: findings.length },
          canSubmit: criticals === 0,
          instruction: criticals > 0
            ? `\ud83d\uded1 ${criticals} CRITICAL issue(s) found. Fix before harness_submit.`
            : warningCount > 0
              ? `\u26a0\ufe0f ${warningCount} warning(s). May proceed to harness_submit.`
              : "\u2705 All checks passed. Ready for harness_submit.",
        });
      } catch (err) {
        return jsonResult({
          error: `harness_challenge failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}

// ─── harness_modify ───

export function createHarnessModifyTool(runsDir: string, sessionCtx: SessionContext): AnyAgentTool {
  return {
    name: "harness_modify",
    label: "Harness Modify",
    description:
      "Dynamic re-planning: modify the contract during a run. " +
      "Actions: 'add' new items, 'skip' items with reason, 'split' items into sub-tasks, " +
      "'update' acceptance criteria. Use when the plan is wrong or incomplete.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform: 'add', 'skip', 'split', 'update'.",
        },
        itemId: {
          type: "string",
          description: "Contract item ID to modify (for skip/split/update).",
        },
        reason: {
          type: "string",
          description: "Reason for the modification.",
        },
        description: {
          type: "string",
          description: "Description for new item (add action).",
        },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" },
          description: "Acceptance criteria for new/updated item.",
        },
        verifyCommand: {
          type: "string",
          description: "Verify command for new/updated item.",
        },
        subItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              acceptanceCriteria: { type: "array", items: { type: "string" } },
              verifyCommand: { type: "string" },
            },
            required: ["description"],
          },
          description: "Sub-items for split action.",
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId, params) {
      try {
        const p = params as Record<string, unknown>;
        const action = validation.readStringParam(p, "action");
        const itemId = validation.readOptionalStringParam(p, "itemId");
        const reason = validation.readOptionalStringParam(p, "reason");

        const active = state.findActiveRunForSession(runsDir, sessionCtx.currentSessionKey);
        if (!active) {
          return jsonResult({
            error: "No active harness run found.",
            hint: "Call harness_start first.",
          });
        }

        const { runId, state: runState } = active;
        const contract = state.readContract(runsDir, runId);

        if (action === "add") {
          const description = validation.readStringParam(p, "description");
          const acceptanceCriteria = (p.acceptanceCriteria as string[] | undefined) ?? [`"${description}" is implemented and working`];
          const verifyCommand = validation.readOptionalStringParam(p, "verifyCommand") ?? runState.verifyCommand;

          const existingIds = contract.map(c => parseInt(c.id.replace("c", ""), 10)).filter(n => !isNaN(n));
          const nextNum = (Math.max(0, ...existingIds) + 1);
          const newId = `c${String(nextNum).padStart(3, "0")}`;

          const newItem: state.ContractItem = {
            id: newId,
            description,
            acceptanceCriteria,
            verifyCommand,
            status: "pending",
            attempts: 0,
            maxAttempts: 3,
          };

          state.addContractItem(runsDir, runId, newItem);

          state.appendLearning(runsDir, runId, {
            timestamp: new Date().toISOString(),
            itemId: newId,
            description,
            approach: "dynamic-add",
            outcome: "success",
            lesson: `Added mid-run: ${reason ?? "plan adjustment"}`,
          });

          return jsonResult({
            success: true,
            action: "add",
            newItem: { id: newId, description, acceptanceCriteria },
            contractSize: contract.length + 1,
            instruction: `Added [${newId}] "${description}". Continue with current work.`,
          });
        }

        if (action === "skip") {
          if (!itemId) return jsonResult({ error: "itemId required for skip action." });
          const skipReason = reason ?? "Skipped by agent during execution";
          const skipped = state.skipContractItem(runsDir, runId, itemId, skipReason);
          if (!skipped) return jsonResult({ error: `Item ${itemId} not found.` });

          state.appendLearning(runsDir, runId, {
            timestamp: new Date().toISOString(),
            itemId,
            description: skipped.description,
            approach: "manual-skip",
            outcome: "failure",
            lesson: `Skipped: ${skipReason}`,
          });

          const nextItem = state.getNextContractItem(state.readContract(runsDir, runId));
          return jsonResult({
            success: true,
            action: "skip",
            skippedItem: { id: itemId, description: skipped.description, reason: skipReason },
            nextItem: nextItem ? { id: nextItem.id, description: nextItem.description } : null,
            instruction: nextItem
              ? `Skipped [${itemId}]. Next: [${nextItem.id}] ${nextItem.description}`
              : `Skipped [${itemId}]. No more items — ready for harness_submit.`,
          });
        }

        if (action === "split") {
          if (!itemId) return jsonResult({ error: "itemId required for split action." });
          const subItems = p.subItems as Array<{ description: string; acceptanceCriteria?: string[]; verifyCommand?: string }> | undefined;
          if (!subItems || subItems.length === 0) {
            return jsonResult({ error: "subItems array required for split action (at least 1 sub-item)." });
          }

          const newItems = state.splitContractItem(runsDir, runId, itemId, subItems);
          if (newItems.length === 0) return jsonResult({ error: `Item ${itemId} not found.` });

          state.appendLearning(runsDir, runId, {
            timestamp: new Date().toISOString(),
            itemId,
            description: `Split into ${newItems.length} sub-items`,
            approach: "dynamic-split",
            outcome: "success",
            lesson: `Item was too complex. Split into: ${newItems.map(i => i.id).join(", ")}`,
          });

          const nextItem = state.getNextContractItem(state.readContract(runsDir, runId));
          return jsonResult({
            success: true,
            action: "split",
            originalItem: itemId,
            newItems: newItems.map(i => ({ id: i.id, description: i.description })),
            nextItem: nextItem ? { id: nextItem.id, description: nextItem.description } : null,
            instruction: `Split [${itemId}] into ${newItems.length} sub-items. ` +
              (nextItem ? `Next: [${nextItem.id}] ${nextItem.description}` : "Ready for submit."),
          });
        }

        if (action === "update") {
          if (!itemId) return jsonResult({ error: "itemId required for update action." });
          const updates: Partial<Omit<state.ContractItem, "id">> = {};
          if (p.acceptanceCriteria) updates.acceptanceCriteria = p.acceptanceCriteria as string[];
          if (p.verifyCommand !== undefined) updates.verifyCommand = p.verifyCommand as string;
          if (p.description) updates.description = p.description as string;

          const updated = state.updateContractItem(runsDir, runId, itemId, updates);
          if (!updated) return jsonResult({ error: `Item ${itemId} not found.` });

          return jsonResult({
            success: true,
            action: "update",
            updatedItem: { id: itemId, description: updated.description },
            instruction: `Updated [${itemId}]. Continue working on it.`,
          });
        }

        return jsonResult({ error: `Unknown action: ${action}. Use: add, skip, split, update.` });
      } catch (err) {
        return jsonResult({
          error: `harness_modify failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
