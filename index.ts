import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import * as path from "node:path";
import * as os from "node:os";
import {
  createHarnessStartTool,
  createHarnessCheckpointTool,
  createHarnessSubmitTool,
  createHarnessStatusTool,
  createHarnessResetTool,
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
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return "?";
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
  const dmMatch = sessionKey.match(/telegram:dm:([-\d]+)/);
  if (dmMatch) return { chatId: dmMatch[1] };
  return null;
}

export default {
  id: "harness-enforcer",
  name: "Harness Enforcer",
  register(api: OpenClawPluginApi) {
    const runsDir = resolveRunsDir(api);

    api.registerTool(() => createHarnessStartTool(runsDir));
    api.registerTool(() => createHarnessCheckpointTool(runsDir));
    api.registerTool(() => createHarnessSubmitTool(runsDir));
    api.registerTool(() => createHarnessStatusTool(runsDir));
    api.registerTool(() => createHarnessResetTool(runsDir));

    // ─── Helpers ───

    async function editProgressBar(
      chatId: string,
      messageId: string,
      text: string,
    ): Promise<boolean> {
      try {
        await api.runtime.channel.telegram.conversationActions.editMessage(
          chatId,
          messageId,
          text,
        );
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
        const result = await api.runtime.channel.telegram.sendMessageTelegram(
          chatId,
          text,
          {
            ...(threadId ? { messageThreadId: parseInt(threadId, 10) } : {}),
          },
        );
        if (result?.messageId) {
          runState.telegramMessageId = String(result.messageId);
          state.writeRunState(runsDir, runId, runState);
          api.logger.info(
            `[harness-enforcer] Progress bar sent: msgId=${result.messageId}`,
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

    // ─── Stale run check (periodic, piggybacked on tool calls) ───
    let lastStaleCheckMs = 0;

    async function checkStaleRun(): Promise<void> {
      const now = Date.now();
      if (now - lastStaleCheckMs < STALE_CHECK_INTERVAL_MS) return;
      lastStaleCheckMs = now;

      const active = state.findActiveRun(runsDir);
      if (!active) return;

      const checkpoints = state.readCheckpoints(runsDir, active.runId);
      const lastActivity = checkpoints.length > 0
        ? new Date(checkpoints[checkpoints.length - 1].timestamp).getTime()
        : new Date(active.state.startedAt).getTime();

      const sinceLastActivity = now - lastActivity;

      if (sinceLastActivity > STALE_RUN_TIMEOUT_MS) {
        await autoCancel(
          active,
          `Stale run: ${Math.round(sinceLastActivity / 60000)}min since last checkpoint (limit: ${STALE_RUN_TIMEOUT_MS / 60000}min)`,
        );
      }
    }

    // ─── HOOK 1: after_tool_call — main orchestrator ───
    api.on("after_tool_call", async (event, ctx) => {
      // Track tool call for watchdog
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
        argsHash: hashArgs(event.arguments),
        timestamp: Date.now(),
        isError: !!isError,
      });

      // Keep array bounded
      if (recentToolCalls.length > 200) {
        recentToolCalls.splice(0, recentToolCalls.length - 100);
      }

      // ── Stale run check (every 5min) ──
      await checkStaleRun();

      // ── Watchdog checks (only during active runs) ──
      const activeForWatchdog = state.findActiveRun(runsDir);
      if (activeForWatchdog && !HARNESS_TOOLS.has(event.toolName)) {
        // Track file edits
        trackFileEdit(event.toolName, event.arguments);

        const hallucination = checkForHallucination(
          event.toolName,
          hashArgs(event.arguments),
        );
        if (hallucination) {
          api.logger.warn(`[harness-enforcer] ${hallucination}`);
        }

        const errorBurst = checkForErrorBurst();
        if (errorBurst) {
          api.logger.warn(`[harness-enforcer] ${errorBurst}`);
          // Send Telegram alert on error burst
          const alertChat = activeForWatchdog.state.telegramChatId ?? "193902961";
          try {
            await api.runtime.channel.telegram.sendMessageTelegram(
              alertChat,
              `⚠️ **Watchdog Alert**\n${errorBurst}\nRun: ${activeForWatchdog.state.taskDescription}`,
              {},
            );
          } catch { /* best effort */ }
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

        if (!payload?.progressBar || typeof payload.progressBar !== "string")
          return;

        const progressBar = payload.progressBar as string;

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

        const active = state.findActiveRun(runsDir);
        if (!active) return;

        if (!active.state.telegramChatId) {
          active.state.telegramChatId = chatId;
          if (threadId) active.state.telegramThreadId = threadId;
          state.writeRunState(runsDir, active.runId, active.state);
        }

        if (!active.state.telegramMessageId) {
          await sendProgressBar(
            chatId,
            threadId,
            progressBar,
            active.state,
            active.runId,
          );
        } else {
          const ok = await editProgressBar(
            chatId,
            active.state.telegramMessageId,
            progressBar,
          );
          if (!ok) {
            // Message was deleted — clear the ID so next call sends a new one
            active.state.telegramMessageId = undefined;
            state.writeRunState(runsDir, active.runId, active.state);
          }
        }

        lastTimerUpdateMs = Date.now();
        return;
      }

      // ── For ANY other tool: throttled timer update (every 30s) ──
      const now = Date.now();
      if (now - lastTimerUpdateMs < TIMER_UPDATE_INTERVAL_MS) return;

      const active = state.findActiveRun(runsDir);
      if (!active) return;
      if (!active.state.telegramMessageId || !active.state.telegramChatId)
        return;

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

      lastTimerUpdateMs = now;
      api.logger.debug(
        `[harness-enforcer] Timer update (${event.toolName})`,
      );
    });

    // ─── HOOK 2: Subagent lifecycle → immediate update ───
    api.on("subagent_spawned", async (_event, _ctx) => {
      const active = state.findActiveRun(runsDir);
      if (!active) return;
      if (!active.state.telegramMessageId || !active.state.telegramChatId)
        return;

      const progressBar = buildTimerProgressBar(active);
      await editProgressBar(
        active.state.telegramChatId,
        active.state.telegramMessageId,
        progressBar,
      );
      lastTimerUpdateMs = Date.now();
    });

    api.on("subagent_ended", async (_event, _ctx) => {
      const active = state.findActiveRun(runsDir);
      if (!active) return;
      if (!active.state.telegramMessageId || !active.state.telegramChatId)
        return;

      const progressBar = buildTimerProgressBar(active);
      await editProgressBar(
        active.state.telegramChatId,
        active.state.telegramMessageId,
        progressBar,
      );
      lastTimerUpdateMs = Date.now();
    });

    // Log startup
    api.logger.info(
      `[harness-enforcer] Plugin loaded. Stale timeout: ${STALE_RUN_TIMEOUT_MS / 60000}min, Timer interval: ${TIMER_UPDATE_INTERVAL_MS / 1000}s`,
    );
  },
};
