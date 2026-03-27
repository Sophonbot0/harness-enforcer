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
import { renderProgressBar } from "./src/progress.js";

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

// ─── Throttled timer update ───
// Between harness_* calls, the agent makes many exec/read/write calls.
// We piggyback on ANY tool call to update the elapsed timer every 30s.
const TIMER_UPDATE_INTERVAL_MS = 30_000;
let lastTimerUpdateMs = 0;

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

    // Helper: edit existing Telegram progress message
    async function editProgressBar(
      chatId: string,
      messageId: string,
      text: string,
    ): Promise<void> {
      try {
        await api.runtime.channel.telegram.conversationActions.editMessage(
          chatId,
          messageId,
          text,
        );
      } catch (err) {
        api.logger.warn(
          `[harness-enforcer] Telegram edit failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Helper: send new Telegram progress message and persist messageId
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

    // Helper: build a timer-only progress bar from the persisted state
    function buildTimerProgressBar(
      active: { runId: string; state: state.RunState },
    ): string {
      const checkpoints = state.readCheckpoints(runsDir, active.runId);
      const lastCheckpoint = checkpoints.length > 0
        ? checkpoints[checkpoints.length - 1]
        : null;

      const elapsedSeconds = Math.round(
        (Date.now() - new Date(active.state.startedAt).getTime()) / 1000,
      );

      const dodItems = state.readDodItems(runsDir, active.runId);
      const dodCompleted = dodItems.filter((d) => d.checked).length;

      return renderProgressBar({
        taskDescription: active.state.taskDescription,
        phase: lastCheckpoint?.phase ?? active.state.phase,
        completedFeatures: lastCheckpoint?.completedFeatures ?? [],
        pendingFeatures: lastCheckpoint?.pendingFeatures ?? [],
        blockers: lastCheckpoint?.blockers ?? [],
        dodTotal: dodItems.length,
        dodCompleted,
        elapsedSeconds,
      });
    }

    // ─── HOOK 1: Harness tool calls → immediate update ───
    api.on("after_tool_call", async (event, ctx) => {
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

        // Persist telegram info if not already set
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
          await editProgressBar(
            chatId,
            active.state.telegramMessageId,
            progressBar,
          );
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

      // Build a fresh progress bar with updated timer
      const progressBar = buildTimerProgressBar(active);

      await editProgressBar(
        active.state.telegramChatId,
        active.state.telegramMessageId,
        progressBar,
      );

      lastTimerUpdateMs = now;
      api.logger.info(
        `[harness-enforcer] Timer update (${event.toolName})`,
      );
    });

    // ─── HOOK 2: Subagent lifecycle → immediate update ───
    // When a subagent spawns or completes during a harness run,
    // update the progress bar immediately with fresh timer.
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
  },
};
