import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as path from "node:path";
import * as os from "node:os";
import {
  createHarnessStartTool,
  createHarnessCheckpointTool,
  createHarnessSubmitTool,
  createHarnessStatusTool,
  createHarnessResetTool,
  createHarnessResumeTool,
  createHarnessPlanTool,
  createHarnessChallengeTool,
  createHarnessModifyTool,
} from "./src/tools.js";
import * as state from "./src/state.js";
import { renderProgressBar, renderFinalStatus } from "./src/progress.js";

function resolveRunsDir(api: OpenClawPluginApi): string {
  const cfg = api.config as Record<string, unknown> | undefined;
  if (cfg?.runsDir && typeof cfg.runsDir === "string") {
    return cfg.runsDir;
  }
  return path.join(os.homedir(), ".openclaw", "harness-enforcer", "runs");
}

const HARNESS_TOOLS = new Set([
  "harness_start",
  "harness_checkpoint",
  "harness_submit",
  "harness_reset",
  "harness_resume",
  "harness_status",
  "harness_plan",
  "harness_challenge",
  "harness_modify",
]);

// ─── Configuration ───
const TIMER_UPDATE_INTERVAL_MS = 30_000; // 30s between timer-only updates
const STALE_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h without checkpoint → auto-cancel
const STALE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check for stale runs every 5min
const HALLUCINATION_WINDOW_MS = 5 * 60 * 1000; // 5min window for detecting repeated outputs
const HALLUCINATION_THRESHOLD = 5; // Same tool+args 5x in window → hallucination
const TOOL_ERROR_WINDOW_MS = 5 * 60 * 1000; // 5min window for error accumulation
const TOOL_ERROR_THRESHOLD = 5; // 5 errors in window → escalate
const PROGRESS_STALL_THRESHOLD = 3; // 3 checkpoints with same completed count → stalled
const SAME_FILE_EDIT_THRESHOLD = 5; // Same file edited 5x without test → warn
const FORCED_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000; // 10 min → force checkpoint reminder
const ITEM_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per contract item default
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 min heartbeat with ETA

// ─── State ───
let lastTimerUpdateMs = 0;

// Tool call tracking for hallucination/loop detection
interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  timestamp: number;
  isError: boolean;
}
const recentToolCalls: ToolCallRecord[] = [];

function hashArgs(args: unknown): string {
  try {
    if (args === undefined || args === null) return "empty";
    const s = JSON.stringify(args);
    return s ? s.slice(0, 200) : "empty";
  } catch {
    return "unknown";
  }
}

function pruneOldRecords(windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  while (recentToolCalls.length > 0 && recentToolCalls[0].timestamp < cutoff) {
    recentToolCalls.shift();
  }
}

/**
 * Extract Telegram chatId and threadId from an OpenClaw session key.
 */
function parseTelegramFromSessionKey(
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

export default {
  id: "harness-enforcer",
  name: "Harness Enforcer",
  register(api: OpenClawPluginApi) {
    const runsDir = resolveRunsDir(api);

    // Session context holder — set by before_tool_call, read by tools
    // This allows tools to know which session is calling them
    const sessionContext = { currentSessionKey: undefined as string | undefined };

    api.registerTool(() => createHarnessStartTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessCheckpointTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessSubmitTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessStatusTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessResetTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessResumeTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessPlanTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessChallengeTool(runsDir, sessionContext));
    api.registerTool(() => createHarnessModifyTool(runsDir, sessionContext));

    // ─── Helpers ───

    async function deleteProgressBar(
      chatId: string,
      messageId: string,
    ): Promise<boolean> {
      try {
        // Try the conversation actions API first
        if (api.runtime?.channel?.telegram?.conversationActions?.deleteMessage) {
          await api.runtime.channel.telegram.conversationActions.deleteMessage(
            chatId,
            messageId,
          );
          return true;
        }
        // Fallback: try sendMessageTelegram-style delete if available
        api.logger.warn(`[harness-enforcer] deleteMessage API not available, message ${messageId} will remain`);
        return false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.warn(`[harness-enforcer] Telegram delete failed: ${msg}`);
        return false;
      }
    }

    async function editProgressBar(
      chatId: string,
      messageId: string,
      text: string,
    ): Promise<boolean> {
      try {
        const fn = api.runtime?.channel?.telegram?.conversationActions?.editMessage;
        if (!fn || typeof fn !== 'function') {
          api.logger.warn(
            `[harness-enforcer] editProgressBar: editMessage not available (type=${typeof fn})`,
          );
          return true; // Don't clear messageId
        }
        const timeoutMs = 15_000;
        const result = await Promise.race([
          fn(chatId, messageId, text),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
        ]);
        if (result === 'timeout') {
          api.logger.warn(
            `[harness-enforcer] editProgressBar: timed out after ${timeoutMs}ms`,
          );
          return true; // Transient, keep trying
        }
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // If message is not modified (content identical), that's fine
        if (msg.includes("not modified")) return true;
        // If message not found (deleted), stop trying
        if (msg.includes("not found") || msg.includes("MESSAGE_ID_INVALID")) {
          api.logger.warn(
            `[harness-enforcer] Message ${messageId} no longer exists, clearing.`,
          );
          return false;
        }
        api.logger.warn(`[harness-enforcer] Telegram edit failed: ${msg}`);
        return true; // Transient error, keep trying
      }
    }

    async function sendProgressBar(
      chatId: string,
      threadId: string | undefined,
      text: string,
      runState: state.RunState,
      runId: string,
    ): Promise<void> {
      try {
        const fn = api.runtime?.channel?.telegram?.sendMessageTelegram;
        if (!fn || typeof fn !== 'function') {
          api.logger.warn(
            `[harness-enforcer] sendProgressBar: sendMessageTelegram not available (type=${typeof fn})`,
          );
          return;
        }
        api.logger.info(
          `[harness-enforcer] sendProgressBar: chatId=${chatId} threadId=${threadId ?? 'none'}`,
        );
        // Wrap in timeout to avoid hanging forever
        const timeoutMs = 15_000;
        const result = await Promise.race([
          fn(
            chatId,
            text,
            {
              ...(threadId ? { messageThreadId: parseInt(threadId, 10) } : {}),
            },
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (result === null) {
          api.logger.warn(
            `[harness-enforcer] sendProgressBar: timed out after ${timeoutMs}ms`,
          );
          return;
        }
        api.logger.info(
          `[harness-enforcer] sendProgressBar result: ${JSON.stringify(result)?.slice(0, 300)}`,
        );
        if (result?.messageId) {
          runState.telegramMessageId = String(result.messageId);
          state.writeRunState(runsDir, runId, runState);
          api.logger.info(
            `[harness-enforcer] Progress bar sent: msgId=${result.messageId}`,
          );
        } else {
          api.logger.warn(
            `[harness-enforcer] sendProgressBar: no messageId in result`,
          );
        }
      } catch (err) {
        api.logger.warn(
          `[harness-enforcer] Telegram send failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    function buildTimerProgressBar(
      active: { runId: string; state: state.RunState },
    ): string {
      const checkpoints = state.readCheckpoints(runsDir, active.runId);
      const lastCheckpoint =
        checkpoints.length > 0
          ? checkpoints[checkpoints.length - 1]
          : null;

      const elapsedSeconds = Math.round(
        (Date.now() - new Date(active.state.startedAt).getTime()) / 1000,
      );

      const dodItems = state.readDodItems(runsDir, active.runId);
      const dodCompleted = lastCheckpoint
        ? lastCheckpoint.completedFeatures.length
        : 0;

      // Check for manifest sprint info
      let sprintCurrent: number | undefined;
      let sprintTotal: number | undefined;
      const manifest = state.findManifestByRunId(runsDir, active.runId)
        ?? (active.state.parentRunId ? state.readManifest(runsDir, active.state.parentRunId) : null);
      if (manifest) {
        const thisPlan = manifest.plans.find(p => p.runId === active.runId);
        if (thisPlan) {
          sprintCurrent = thisPlan.phase;
          sprintTotal = manifest.plans.length;
        }
      }

      return renderProgressBar({
        taskDescription: active.state.taskDescription,
        phase: lastCheckpoint?.phase ?? active.state.phase,
        completedFeatures: lastCheckpoint?.completedFeatures ?? [],
        pendingFeatures: lastCheckpoint?.pendingFeatures ?? [],
        blockers: lastCheckpoint?.blockers ?? [],
        dodTotal: dodItems.length > 0
          ? dodItems.length
          : (lastCheckpoint
            ? lastCheckpoint.completedFeatures.length +
              lastCheckpoint.pendingFeatures.length
            : 0),
        dodCompleted,
        elapsedSeconds,
        sprintCurrent,
        sprintTotal,
        workLog: active.state.workLog,
      });
    }

    async function autoCancel(
      active: { runId: string; state: state.RunState },
      reason: string,
    ): Promise<void> {
      const elapsed = Math.round(
        (Date.now() - new Date(active.state.startedAt).getTime()) / 1000,
      );
      const checkpoints = state.readCheckpoints(runsDir, active.runId);
      const lastCheckpoint =
        checkpoints.length > 0
          ? checkpoints[checkpoints.length - 1]
          : null;

      active.state.status = "cancelled";
      state.writeRunState(runsDir, active.runId, active.state);

      const dodItems = state.readDodItems(runsDir, active.runId);

      const progressBar = renderFinalStatus({
        taskDescription: active.state.taskDescription,
        status: "cancelled",
        dodTotal: dodItems.length,
        dodCompleted: lastCheckpoint
          ? lastCheckpoint.completedFeatures.length
          : 0,
        elapsedSeconds: elapsed,
        completedFeatures: lastCheckpoint?.completedFeatures ?? [],
        pendingFeatures: lastCheckpoint?.pendingFeatures ?? [],
        blockers: [reason],
      });

      if (active.state.telegramMessageId && active.state.telegramChatId) {
        await editProgressBar(
          active.state.telegramChatId,
          active.state.telegramMessageId,
          progressBar,
        );
      }

      // Also send an alert
      const alertChatId =
        active.state.telegramChatId ?? "193902961";
      try {
        await api.runtime.channel.telegram.sendMessageTelegram(
          alertChatId,
          `⚠️ **Harness Auto-Cancel**\nRun: ${active.state.taskDescription}\nReason: ${reason}\nDuration: ${Math.round(elapsed / 60)}min`,
          {},
        );
      } catch {
        // Best effort
      }

      api.logger.warn(
        `[harness-enforcer] Auto-cancelled run ${active.runId}: ${reason}`,
      );
    }

    // ─── Watchdog: detect hallucination/loops ───

    function checkForHallucination(toolName: string, argsHash: string): string | null {
      pruneOldRecords(HALLUCINATION_WINDOW_MS);

      const matching = recentToolCalls.filter(
        (r) => r.toolName === toolName && r.argsHash === argsHash,
      );

      if (matching.length >= HALLUCINATION_THRESHOLD) {
        return `Loop detected: ${toolName} called ${matching.length}x with identical args in ${HALLUCINATION_WINDOW_MS / 1000}s`;
      }

      return null;
    }

    function checkForErrorBurst(): string | null {
      pruneOldRecords(TOOL_ERROR_WINDOW_MS);
      const errors = recentToolCalls.filter((r) => r.isError);
      if (errors.length >= TOOL_ERROR_THRESHOLD) {
        return `Error burst: ${errors.length} tool errors in ${TOOL_ERROR_WINDOW_MS / 1000}s`;
      }
      return null;
    }

    /** Detect progress stall: N consecutive checkpoints with same completed count */
    function checkProgressStall(runsDir2: string, runId: string): string | null {
      const checkpoints = state.readCheckpoints(runsDir2, runId);
      if (checkpoints.length < PROGRESS_STALL_THRESHOLD) return null;

      const recent = checkpoints.slice(-PROGRESS_STALL_THRESHOLD);
      const counts = recent.map(c => c.completedFeatures.length);
      const allSame = counts.every(c => c === counts[0]);

      if (allSame) {
        return `Progress stall: last ${PROGRESS_STALL_THRESHOLD} checkpoints all have ${counts[0]} completed features. Agent may be stuck.`;
      }
      return null;
    }

    /** Alert cooldown — prevent spam by only sending one alert per type per cooldown period */
    const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between alerts of same type
    const lastAlertSentMs = new Map<string, number>();

    function canSendAlert(alertType: string): boolean {
      const now = Date.now();
      const lastSent = lastAlertSentMs.get(alertType) ?? 0;
      if (now - lastSent < ALERT_COOLDOWN_MS) return false;
      lastAlertSentMs.set(alertType, now);
      return true;
    }

    /** Track file edits without tests (hallucination pattern v2) */
    const fileEditCounts = new Map<string, number>();
    let lastTestRunMs = 0;

    function trackFileEdit(toolName: string, args: unknown): void {
      if (toolName === "edit" || toolName === "write") {
        const a = args as Record<string, unknown>;
        const filePath = (a.file ?? a.filePath ?? a.file_path ?? a.path ?? "") as string;
        if (filePath) {
          const count = (fileEditCounts.get(filePath) ?? 0) + 1;
          fileEditCounts.set(filePath, count);
        }
      }
      // Reset counters when tests are run
      if (toolName === "exec") {
        const a = args as Record<string, unknown>;
        const cmd = (a.command ?? "") as string;
        if (/\b(test|vitest|jest|pytest|cargo test|go test|npm test)\b/i.test(cmd)) {
          fileEditCounts.clear();
          lastTestRunMs = Date.now();
        }
      }
    }

    function checkFileEditWithoutTest(): string | null {
      for (const [filePath, count] of fileEditCounts) {
        if (count >= SAME_FILE_EDIT_THRESHOLD) {
          return `File ${filePath} edited ${count}x without running tests. Consider verifying.`;
        }
      }
      return null;
    }

    /** Check for file conflicts across concurrent active runs */
    function checkFileConflicts(currentRunId: string, currentFiles: string[]): string | null {
      if (currentFiles.length === 0) return null;
      const activeRuns = state.findAllActiveRuns(runsDir);
      const conflicts: string[] = [];
      for (const other of activeRuns) {
        if (other.runId === currentRunId) continue;
        const otherSnapshot = other.state.lastContextSnapshot;
        if (!otherSnapshot?.filesModified) continue;
        const overlap = currentFiles.filter(f => otherSnapshot.filesModified!.includes(f));
        if (overlap.length > 0) {
          conflicts.push(
            `⚠️ Files ${overlap.join(", ")} also modified by run "${other.state.taskDescription}" (${other.runId})`
          );
        }
      }
      return conflicts.length > 0 ? conflicts.join("\n") : null;
    }

    // ─── Stale run check (periodic, piggybacked on tool calls) ───
    let lastStaleCheckMs = 0;

    async function checkStaleRun(): Promise<void> {
      const now = Date.now();
      if (now - lastStaleCheckMs < STALE_CHECK_INTERVAL_MS) return;
      lastStaleCheckMs = now;

      // Check ALL active runs for staleness (supports concurrent runs)
      const activeRuns = state.findAllActiveRuns(runsDir);
      for (const active of activeRuns) {
        const checkpoints = state.readCheckpoints(runsDir, active.runId);
        const lastActivity = checkpoints.length > 0
          ? new Date(checkpoints[checkpoints.length - 1].timestamp).getTime()
          : new Date(active.state.startedAt).getTime();

        const sinceLastActivity = now - lastActivity;

        // Subagent runs have shorter stale timeout (30min vs 2h)
        const staleTimeout = active.state.isSubagent
          ? 30 * 60 * 1000  // 30 minutes for subagents
          : STALE_RUN_TIMEOUT_MS;

        if (sinceLastActivity > staleTimeout) {
          await autoCancel(
            active,
            `Stale run: ${Math.round(sinceLastActivity / 60000)}min since last checkpoint (limit: ${Math.round(staleTimeout / 60000)}min)`,
          );
        }
      }
    }

    // ─── HOOK 0: before_tool_call — set session context for tools ───
    // Track hallucination state for blocking in before_tool_call
    let lastHallucinationToolName: string | null = null;
    let lastHallucinationArgsHash: string | null = null;

    api.on("before_tool_call", async (event, ctx) => {
      sessionContext.currentSessionKey = ctx.sessionKey;

      const toolEvent = event as { toolName?: string; params?: Record<string, unknown> };

      // Block repeated calls that were flagged as hallucination
      if (lastHallucinationToolName && toolEvent.toolName === lastHallucinationToolName) {
        const currentHash = hashArgs(toolEvent.params);
        if (currentHash === lastHallucinationArgsHash) {
          api.logger.info(`[harness-enforcer] BLOCKING hallucinated call: ${toolEvent.toolName}`);
          // Clear after blocking once — give agent a chance to try something else
          lastHallucinationToolName = null;
          lastHallucinationArgsHash = null;
          return {
            block: true,
            blockReason:
              `🛑 BLOCKED — Hallucination loop detected. You called ${toolEvent.toolName} with identical arguments too many times. ` +
              `STOP and try a completely different approach. If stuck, skip this step and move to the next feature. ` +
              `Call harness_checkpoint to record your new approach.`,
          };
        }
      }

      // Silent work mode: intercept message sends during active harness runs
      // Allow progress bar messages through (they contain harness progress patterns)
      if (toolEvent.toolName === "message") {
        const active = state.findActiveRunForSession(runsDir, ctx.sessionKey);
        if (active) {
          const msgText = (toolEvent.params as Record<string, unknown>)?.message as string | undefined;
          const isProgressBar = msgText && (
            msgText.startsWith("\u{1F527}") ||       // wrench emoji
            msgText.includes("\u25b6plan") ||          // phase indicator
            msgText.includes("\u2705 DELIVERED") ||    // delivered status
            msgText.includes("done | ") ||             // progress pattern
            msgText.includes("\u25b0\u25b0") ||        // filled progress bar
            msgText.includes("\u25b1\u25b1")           // empty progress bar
          );
          if (!isProgressBar) {
            return {
              block: true,
              blockReason:
                `🔇 SILENT WORK MODE — Message blocked. During a harness run, do NOT send messages. ` +
                `Use harness_checkpoint with currentAction instead. Work silently: read → edit → exec → checkpoint.`,
            };
          }
          // Progress bar messages are allowed through
        }
      }
    });

    // ─── HOOK 1: after_tool_call — main orchestrator ───
    api.on("after_tool_call", async (event, ctx) => {
      // Debug: log every tool call to verify hook is firing
      const argsHashDebug = hashArgs(event.params);
      const hasActiveRun = !!state.findActiveRunForSession(runsDir, ctx.sessionKey);
      api.logger.info(`[harness-enforcer] after_tool_call: ${event.toolName} session=${ctx.sessionKey} hash=${argsHashDebug} recentCalls=${recentToolCalls.length} activeRun=${hasActiveRun}`);
      const isError =
        event.result &&
        typeof event.result === "object" &&
        "content" in (event.result as Record<string, unknown>) &&
        Array.isArray((event.result as Record<string, unknown>).content) &&
        ((event.result as Record<string, unknown>).content as Array<Record<string, unknown>>).some(
          (b) => b.type === "text" && typeof b.text === "string" && (b.text as string).includes('"error"'),
        );

      recentToolCalls.push({
        toolName: event.toolName,
        argsHash: hashArgs(event.params),
        timestamp: Date.now(),
        isError: !!isError,
      });

      // Keep array bounded
      if (recentToolCalls.length > 200) {
        recentToolCalls.splice(0, recentToolCalls.length - 100);
      }

      // ── Stale run check (every 5min) ──
      await checkStaleRun();

      // ── Watchdog checks (only during active runs for this session) ──
      const activeForWatchdog = state.findActiveRunForSession(runsDir, ctx.sessionKey);
      if (activeForWatchdog && !HARNESS_TOOLS.has(event.toolName)) {
        // Track file edits
        trackFileEdit(event.toolName, event.params);

        const hallucination = checkForHallucination(
          event.toolName,
          hashArgs(event.params),
        );
        if (hallucination) {
          api.logger.info(`[harness-enforcer] HALLUCINATION DETECTED: ${hallucination}`);
          
          // Set blocking state for before_tool_call
          lastHallucinationToolName = event.toolName;
          lastHallucinationArgsHash = hashArgs(event.params);
          
          // Send Telegram alert ONCE per cooldown period (5 min)
          if (canSendAlert("hallucination")) {
            const alertChat = activeForWatchdog.state.telegramChatId ?? "193902961";
            const threadId = activeForWatchdog.state.telegramThreadId;
            try {
              await api.runtime.channel.telegram.sendMessageTelegram(
                alertChat,
                `🔄 **Hallucination Loop Detected**\n${hallucination}\nRun: ${activeForWatchdog.state.taskDescription}\n\n_Auto-correction active: next identical call will be blocked._`,
                {
                  ...(threadId ? { messageThreadId: parseInt(threadId, 10) } : {}),
                },
              );
              api.logger.info(`[harness-enforcer] Telegram hallucination alert sent`);
            } catch (err) {
              api.logger.info(`[harness-enforcer] Telegram send failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          // Reset the hallucination counter so it doesn't keep re-triggering
          recentToolCalls.length = 0;
        }

        const errorBurst = checkForErrorBurst();
        if (errorBurst) {
          api.logger.warn(`[harness-enforcer] ${errorBurst}`);
          if (canSendAlert("errorBurst")) {
            const alertChat = activeForWatchdog.state.telegramChatId ?? "193902961";
            try {
              await api.runtime.channel.telegram.sendMessageTelegram(
                alertChat,
                `⚠️ **Watchdog Alert**\n${errorBurst}\nRun: ${activeForWatchdog.state.taskDescription}`,
                {},
              );
            } catch { /* best effort */ }
          }
        }

        // Check for file edit without test
        const editWarn = checkFileEditWithoutTest();
        if (editWarn) {
          api.logger.warn(`[harness-enforcer] ${editWarn}`);
        }

        // Check for progress stall
        const stall = checkProgressStall(runsDir, activeForWatchdog.runId);
        if (stall) {
          api.logger.warn(`[harness-enforcer] ${stall}`);
          if (canSendAlert("stall")) {
            const alertChat = activeForWatchdog.state.telegramChatId ?? "193902961";
            try {
              await api.runtime.channel.telegram.sendMessageTelegram(
                alertChat,
                `⏸ **Progress Stalled**\n${stall}\nRun: ${activeForWatchdog.state.taskDescription}\n\n_${PROGRESS_STALL_THRESHOLD} checkpoints with no new features completed._`,
              {},
            );
          } catch { /* best effort */ }
          }
        }

        // Forced checkpoint reminder: if no checkpoint for 10 min
        const lastCpAt = activeForWatchdog.state.lastCheckpointAt
          ? new Date(activeForWatchdog.state.lastCheckpointAt).getTime()
          : new Date(activeForWatchdog.state.startedAt).getTime();
        const sinceLastCp = Date.now() - lastCpAt;
        if (sinceLastCp > FORCED_CHECKPOINT_INTERVAL_MS && canSendAlert("forced_checkpoint")) {
          api.logger.warn(
            `[harness-enforcer] No checkpoint for ${Math.round(sinceLastCp / 60000)}min. Injecting reminder.`,
          );
        }

        // Item timeout: if current contract item started >30 min ago
        if (activeForWatchdog.state.currentItemStartedAt && activeForWatchdog.state.currentContractItemId) {
          const itemStarted = new Date(activeForWatchdog.state.currentItemStartedAt).getTime();
          const contract = state.readContract(runsDir, activeForWatchdog.runId);
          const currentItem = contract.find(c => c.id === activeForWatchdog.state.currentContractItemId);
          const itemTimeout = (currentItem?.timeoutMinutes ?? 30) * 60 * 1000;
          const sinceItemStart = Date.now() - itemStarted;

          if (sinceItemStart > itemTimeout && canSendAlert(`item_timeout_${activeForWatchdog.state.currentContractItemId}`)) {
            const alertChat = activeForWatchdog.state.telegramChatId ?? "193902961";
            const itemDesc = currentItem?.description ?? activeForWatchdog.state.currentContractItemId;
            try {
              await api.runtime.channel.telegram.sendMessageTelegram(
                alertChat,
                `\u23f0 **Item Timeout**\n[${activeForWatchdog.state.currentContractItemId}] ${itemDesc}\n` +
                `Stuck for ${Math.round(sinceItemStart / 60000)} min (limit: ${Math.round(itemTimeout / 60000)} min)\n` +
                `Consider: skip, split, or try a different approach.`,
                {},
              );
            } catch { /* best effort */ }
          }
        }
      }

      // ── For harness_* tools: immediate progress bar send/edit ──
      if (HARNESS_TOOLS.has(event.toolName)) {
        let payload: Record<string, unknown> | null = null;
        try {
          if (event.result && typeof event.result === "object") {
            const r = event.result as Record<string, unknown>;
            if (r.details && typeof r.details === "object") {
              payload = r.details as Record<string, unknown>;
            } else if (r.content && Array.isArray(r.content)) {
              const textBlock = (
                r.content as Array<Record<string, unknown>>
              ).find((b) => b.type === "text" && typeof b.text === "string");
              if (textBlock) {
                payload = JSON.parse(textBlock.text as string);
              }
            }
          }
        } catch {
          return;
        }

        // ── harness_reset: delete the Telegram message instead of editing ──
        if (event.toolName === "harness_reset" && payload?.telegramDeleteOnReset) {
          // The run is already cancelled — find the message info from the payload
          const msgId = payload.telegramMessageId as string | undefined;
          const cId = payload.telegramChatId as string | undefined;
          // Try to get from the payload directly, or fall back to parsing
          let deleteChatId = cId;
          let deleteMsgId = msgId;
          
          if (!deleteChatId || !deleteMsgId) {
            // The run state was already updated — try to read from the payload's run info
            // The progressBar is in the payload, meaning the reset recorded the info
            // We need to get it from the cancelled run state which still has the IDs
            const cancelledRunId = payload.runId as string | undefined;
            if (cancelledRunId) {
              const cancelledState = state.readRunState(runsDir, cancelledRunId);
              if (cancelledState) {
                deleteChatId = deleteChatId ?? cancelledState.telegramChatId;
                deleteMsgId = deleteMsgId ?? cancelledState.telegramMessageId;
              }
            }
          }
          
          if (!deleteChatId) {
            const parsed = parseTelegramFromSessionKey(ctx.sessionKey);
            if (parsed) deleteChatId = parsed.chatId;
          }
          
          if (deleteChatId && deleteMsgId) {
            await deleteProgressBar(deleteChatId, deleteMsgId);
            api.logger.info(`[harness-enforcer] Deleted progress bar message ${deleteMsgId} on reset`);
          }
          
          lastTimerUpdateMs = Date.now();
          return;
        }

        if (!payload?.progressBar || typeof payload.progressBar !== "string")
          return;

        const progressBar = payload.progressBar as string;

        api.logger.debug(
          `[harness-enforcer] Progress bar: tool=${event.toolName} chatId=${payload.telegramChatId ?? 'none'}`,
        );

        let chatId = payload.telegramChatId as string | undefined;
        let threadId = payload.telegramThreadId as string | undefined;

        if (!chatId) {
          const parsed = parseTelegramFromSessionKey(ctx.sessionKey);
          if (parsed) {
            chatId = parsed.chatId;
            threadId = parsed.threadId;
          }
        }
        if (!chatId) return;

        // For harness_submit / harness_reset, the run may already be completed/cancelled
        // so findActiveRunForSession won't find it. Use payload fields + fallback.
        const messageId = payload.telegramMessageId as string | undefined;
        const runId = payload.runId as string | undefined;

        // Try session-scoped active run first, then fall back to reading the specific run from payload
        let runState: state.RunState | null = null;
        let resolvedRunId: string | undefined;
        const active = state.findActiveRunForSession(runsDir, ctx.sessionKey);
        if (active) {
          runState = active.state;
          resolvedRunId = active.runId;
        } else if (runId) {
          // Run already completed/cancelled — read its state directly
          runState = state.readRunState(runsDir, runId);
          resolvedRunId = runId;
        }

        if (runState && resolvedRunId && !runState.telegramChatId) {
          runState.telegramChatId = chatId;
          if (threadId) runState.telegramThreadId = threadId;
          state.writeRunState(runsDir, resolvedRunId, runState);
        }

        // Resolve which messageId to use: payload > runState > none
        const resolvedMsgId = messageId ?? runState?.telegramMessageId;

        api.logger.debug(
          `[harness-enforcer] Progress bar resolve: msgId=${resolvedMsgId ?? 'null'} hasState=${!!runState}`,
        );

        if (!resolvedMsgId) {
          // No existing message — send a new one
          api.logger.debug(
            `[harness-enforcer] Sending new progress bar: chatId=${chatId} runId=${resolvedRunId ?? 'none'}`,
          );
          if (runState && resolvedRunId) {
            await sendProgressBar(
              chatId,
              threadId,
              progressBar,
              runState,
              resolvedRunId,
            );
          }
        } else {
          const ok = await editProgressBar(
            chatId,
            resolvedMsgId,
            progressBar,
          );
          if (!ok && runState && resolvedRunId) {
            // Message was deleted — clear ID and send a NEW message
            runState.telegramMessageId = undefined;
            state.writeRunState(runsDir, resolvedRunId, runState);
            await sendProgressBar(
              chatId,
              threadId,
              progressBar,
              runState,
              resolvedRunId,
            );
          }
        }

        lastTimerUpdateMs = Date.now();
        return;
      }

      // ── For ANY other tool: throttled timer update (every 30s) ──
      // Update the progress bar for THIS session's active run
      const now = Date.now();
      if (now - lastTimerUpdateMs < TIMER_UPDATE_INTERVAL_MS) return;

      const activeForTimer = state.findActiveRunForSession(runsDir, ctx.sessionKey);
      if (!activeForTimer) return;
      if (!activeForTimer.state.telegramMessageId || !activeForTimer.state.telegramChatId)
        return;

      const progressBar = buildTimerProgressBar(activeForTimer);

      const ok = await editProgressBar(
        activeForTimer.state.telegramChatId,
        activeForTimer.state.telegramMessageId,
        progressBar,
      );
      if (!ok) {
        // Message deleted — send new one
        activeForTimer.state.telegramMessageId = undefined;
        state.writeRunState(runsDir, activeForTimer.runId, activeForTimer.state);
        const threadId2 = activeForTimer.state.telegramThreadId;
        await sendProgressBar(
          activeForTimer.state.telegramChatId,
          threadId2,
          progressBar,
          activeForTimer.state,
          activeForTimer.runId,
        );
      }

      lastTimerUpdateMs = now;
      api.logger.debug(
        `[harness-enforcer] Timer update (${event.toolName})`,
      );
    });

    // ─── HOOK 2: Subagent lifecycle → immediate update ───
    api.on("subagent_spawned", async (_event, _ctx) => {
      // Update all active runs (subagents may belong to any session)
      const activeRuns = state.findAllActiveRuns(runsDir);
      for (const active of activeRuns) {
        if (!active.state.telegramMessageId || !active.state.telegramChatId) continue;
        const progressBar = buildTimerProgressBar(active);
        await editProgressBar(
          active.state.telegramChatId,
          active.state.telegramMessageId,
          progressBar,
        );
      }
      lastTimerUpdateMs = Date.now();
    });

    api.on("subagent_ended", async (_event, _ctx) => {
      const activeRuns = state.findAllActiveRuns(runsDir);
      for (const active of activeRuns) {
        if (!active.state.telegramMessageId || !active.state.telegramChatId) continue;
        const progressBar = buildTimerProgressBar(active);
        await editProgressBar(
          active.state.telegramChatId,
          active.state.telegramMessageId,
          progressBar,
        );
      }
      lastTimerUpdateMs = Date.now();
    });

    // ─── TIMER: setInterval fallback for elapsed time updates ───
    // Updates the progress bar timer every 30s even when no tool calls happen.
    // This ensures the ⏱ display stays current during long-running operations.
    const timerInterval = setInterval(async () => {
      try {
        // Don't duplicate if a tool-based update happened recently
        const now = Date.now();
        if (now - lastTimerUpdateMs < TIMER_UPDATE_INTERVAL_MS) return;

        // Update ALL active runs' progress bars
        const activeRuns = state.findAllActiveRuns(runsDir);
        if (activeRuns.length === 0) return;

        for (const active of activeRuns) {
          if (!active.state.telegramMessageId || !active.state.telegramChatId) continue;

          const progressBar = buildTimerProgressBar(active);

          const ok = await editProgressBar(
            active.state.telegramChatId,
            active.state.telegramMessageId,
            progressBar,
          );
          if (!ok) {
            active.state.telegramMessageId = undefined;
            state.writeRunState(runsDir, active.runId, active.state);
          }
        }

        lastTimerUpdateMs = now;
        api.logger.debug(`[harness-enforcer] Timer tick (interval, ${activeRuns.length} active runs)`);
      } catch (err) {
        api.logger.debug(
          `[harness-enforcer] Timer tick error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, TIMER_UPDATE_INTERVAL_MS);

    // ─── HEARTBEAT TIMER: periodic status with ETA (every 15 min) ───
    let lastHeartbeatMs = 0;
    const heartbeatInterval = setInterval(async () => {
      try {
        const now = Date.now();
        if (now - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) return;

        const activeRuns = state.findAllActiveRuns(runsDir);
        if (activeRuns.length === 0) return;

        for (const active of activeRuns) {
          if (!active.state.telegramChatId) continue;

          const elapsed = Math.round((now - new Date(active.state.startedAt).getTime()) / 1000);
          const contract = state.readContract(runsDir, active.runId);
          const checkpoints = state.readCheckpoints(runsDir, active.runId);

          // Calculate ETA based on average item completion time
          let eta = "unknown";
          if (contract.length > 0) {
            const passed = contract.filter(c => c.status === "passed").length;
            const remaining = contract.filter(c => c.status === "pending" || c.status === "in_progress").length;
            if (passed > 0) {
              const avgSecondsPerItem = elapsed / passed;
              const etaSeconds = avgSecondsPerItem * remaining;
              const etaMin = Math.round(etaSeconds / 60);
              eta = etaMin > 60 ? `~${Math.round(etaMin / 60)}h ${etaMin % 60}m` : `~${etaMin}m`;
            }
          }

          const contractSummary = contract.length > 0
            ? `Contract: ${contract.filter(c => c.status === "passed").length}/${contract.length} items`
            : `Checkpoints: ${checkpoints.length}`;

          const currentItem = active.state.currentContractItemId
            ? contract.find(c => c.id === active.state.currentContractItemId)
            : null;

          const heartbeatMsg =
            `\ud83d\udc93 **Heartbeat** \u2014 ${Math.round(elapsed / 60)}min elapsed\n` +
            `Task: ${active.state.taskDescription.slice(0, 60)}\n` +
            `${contractSummary} | ETA: ${eta}\n` +
            (currentItem ? `Working on: [${currentItem.id}] ${currentItem.description.slice(0, 50)}` : "");

          // Only send heartbeat if there's been no checkpoint recently
          const lastCpTime = active.state.lastCheckpointAt
            ? new Date(active.state.lastCheckpointAt).getTime()
            : new Date(active.state.startedAt).getTime();
          const sinceLastCp = now - lastCpTime;

          // Send heartbeat only if no checkpoint in last 15 min (avoids spam when active)
          if (sinceLastCp > HEARTBEAT_INTERVAL_MS) {
            const threadId = active.state.telegramThreadId;
            try {
              await api.runtime.channel.telegram.sendMessageTelegram(
                active.state.telegramChatId,
                heartbeatMsg,
                {
                  ...(threadId ? { messageThreadId: parseInt(threadId, 10) } : {}),
                },
              );
            } catch { /* best effort */ }
          }
        }

        lastHeartbeatMs = now;
      } catch (err) {
        api.logger.debug(
          `[harness-enforcer] Heartbeat error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (typeof heartbeatInterval === "object" && heartbeatInterval && "unref" in heartbeatInterval) {
      (heartbeatInterval as NodeJS.Timeout).unref();
    }

    // Prevent the interval from keeping the process alive
    if (typeof timerInterval === "object" && timerInterval && "unref" in timerInterval) {
      (timerInterval as NodeJS.Timeout).unref();
    }

    // Log startup
    api.logger.info(
      `[harness-enforcer] Plugin loaded. Stale timeout: ${STALE_RUN_TIMEOUT_MS / 60000}min, Timer interval: ${TIMER_UPDATE_INTERVAL_MS / 1000}s`,
    );

    // ─── HOOK 3: session_start — crash recovery & context bootstrap ───
    api.on("session_start", async (_event, ctx) => {
      const active = state.findActiveRunForSession(runsDir, ctx.sessionKey);
      if (!active) return;

      const progressContent = state.readProgressFile(runsDir, active.runId);
      const features = state.readFeatures(runsDir, active.runId);
      const checkpoints = state.readCheckpoints(runsDir, active.runId);
      const lastCheckpoint = checkpoints.length > 0
        ? checkpoints[checkpoints.length - 1]
        : null;

      if (!progressContent && features.length === 0) return;

      const featureSummary = features.length > 0
        ? `Features: ${features.filter(f => f.status === "passed").length}/${features.length} passed`
        : "";

      // Load contract for recovery
      const contractItems = state.readContract(runsDir, active.runId);
      const contractSummary = contractItems.length > 0
        ? `Contract: ${contractItems.filter(c => c.status === "passed").length}/${contractItems.length} items passed`
        : "";
      const nextContractItem = contractItems.length > 0
        ? state.getNextContractItem(contractItems)
        : null;

      // Build comprehensive recovery context
      const bootstrapParts: string[] = [
        `📋 **Active Harness Run Detected — Auto-Recovery**`,
        `Task: ${active.state.taskDescription}`,
        `Phase: ${active.state.phase}`,
        `Run ID: ${active.runId}`,
        `Round: ${active.state.round}`,
        featureSummary,
        contractSummary,
        ``,
      ];

      // Include completed/pending features for immediate awareness
      if (lastCheckpoint) {
        if (lastCheckpoint.completedFeatures.length > 0) {
          bootstrapParts.push(`**Completed:** ${lastCheckpoint.completedFeatures.join(", ")}`);
        }
        if (lastCheckpoint.pendingFeatures.length > 0) {
          bootstrapParts.push(`**Pending:** ${lastCheckpoint.pendingFeatures.join(", ")}`);
        }
        if (lastCheckpoint.blockers.length > 0) {
          bootstrapParts.push(`**Blockers:** ${lastCheckpoint.blockers.join(", ")}`);
        }
        bootstrapParts.push(`**Last summary:** ${lastCheckpoint.summary}`);
        bootstrapParts.push(``);
      }

      // Include context snapshot if available
      const contextSnapshot = active.state.lastContextSnapshot ?? lastCheckpoint?.contextSnapshot;
      if (contextSnapshot) {
        bootstrapParts.push(`**── Context Snapshot ──**`);
        if (contextSnapshot.currentApproach) {
          bootstrapParts.push(`Approach: ${contextSnapshot.currentApproach}`);
        }
        if (contextSnapshot.keyDecisions && contextSnapshot.keyDecisions.length > 0) {
          bootstrapParts.push(`Key decisions: ${contextSnapshot.keyDecisions.join("; ")}`);
        }
        if (contextSnapshot.filesModified && contextSnapshot.filesModified.length > 0) {
          bootstrapParts.push(`Files modified: ${contextSnapshot.filesModified.join(", ")}`);
        }
        if (contextSnapshot.nextSteps && contextSnapshot.nextSteps.length > 0) {
          bootstrapParts.push(`Next steps: ${contextSnapshot.nextSteps.join("; ")}`);
        }
        bootstrapParts.push(``);
      }

      bootstrapParts.push(
        `**Instructions:** Continue the active harness run from where it left off.`,
        `Do NOT restart completed features. Call harness_checkpoint to record progress.`,
        ``,
        `Files on disk:`,
        `- Progress: ~/.openclaw/harness-enforcer/runs/${active.runId}/progress.md`,
        `- Features: ~/.openclaw/harness-enforcer/runs/${active.runId}/features.json`,
        active.state.verifyCommand ? `- Verify command: ${active.state.verifyCommand}` : "",
      );

      if (active.state.resumedFrom) {
        bootstrapParts.push(`- Resume briefing: ~/.openclaw/harness-enforcer/runs/${active.runId}/resume-briefing.md`);
      }

      // Contract recovery: tell agent exactly what to do next
      if (nextContractItem) {
        bootstrapParts.push(``);
        bootstrapParts.push(`**\u2500\u2500 NEXT CONTRACT ITEM \u2500\u2500**`);
        bootstrapParts.push(`[${nextContractItem.id}] ${nextContractItem.description}`);
        bootstrapParts.push(`Acceptance: ${nextContractItem.acceptanceCriteria.join("; ")}`);
        if (nextContractItem.verifyCommand) {
          bootstrapParts.push(`Verify: ${nextContractItem.verifyCommand}`);
        }
      }

      const bootstrapMsg = bootstrapParts.filter(Boolean).join("\n");

      api.logger.info(`[harness-enforcer] Session bootstrap: injecting recovery context for ${active.runId} (checkpoint #${checkpoints.length})`);

      // Inject context as a system note (if the API supports it)
      try {
        if (ctx.injectSystemNote) {
          await ctx.injectSystemNote(bootstrapMsg);
        }
      } catch {
        // Not all session types support system note injection — that's fine
      }
    });
  },
};
