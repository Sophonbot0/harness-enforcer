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
 * 
 * Session key formats:
 *   agent:main:telegram:group:<chatId>:topic:<threadId>
 *   agent:main:telegram:dm:<chatId>
 *   agent:main:subagent:<uuid>  ← not telegram, skip
 */
function parseTelegramFromSessionKey(
  sessionKey: string | undefined,
): { chatId: string; threadId?: string } | null {
  if (!sessionKey) return null;

  // Forum group: agent:main:telegram:group:-1003868711850:topic:1
  const forumMatch = sessionKey.match(
    /telegram:group:([-\d]+):topic:(\d+)/,
  );
  if (forumMatch) {
    return { chatId: forumMatch[1], threadId: forumMatch[2] };
  }

  // Regular group: agent:main:telegram:group:-1003868711850
  const groupMatch = sessionKey.match(/telegram:group:([-\d]+)$/);
  if (groupMatch) {
    return { chatId: groupMatch[1] };
  }

  // DM: agent:main:telegram:dm:193902961
  const dmMatch = sessionKey.match(/telegram:dm:([-\d]+)/);
  if (dmMatch) {
    return { chatId: dmMatch[1] };
  }

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

    // ─── Auto-update Telegram progress bar via after_tool_call hook ───
    //
    // This hook fires AFTER every harness_* tool call. It:
    // 1. Extracts chatId/threadId from the session key (no agent help needed)
    // 2. Parses the progressBar from the tool result
    // 3. Sends or edits the Telegram message directly via runtime API
    //
    // The agent doesn't need to do anything — the plugin handles it all.
    api.on("after_tool_call", async (event, ctx) => {
      if (!HARNESS_TOOLS.has(event.toolName)) return;

      // Parse tool result to extract progressBar
      let payload: Record<string, unknown> | null = null;
      try {
        if (event.result && typeof event.result === "object") {
          const r = event.result as Record<string, unknown>;
          if (r.details && typeof r.details === "object") {
            payload = r.details as Record<string, unknown>;
          } else if (r.content && Array.isArray(r.content)) {
            const textBlock = (r.content as Array<Record<string, unknown>>).find(
              (b) => b.type === "text" && typeof b.text === "string",
            );
            if (textBlock) {
              payload = JSON.parse(textBlock.text as string);
            }
          }
        }
      } catch {
        return;
      }

      if (!payload?.progressBar || typeof payload.progressBar !== "string") return;

      const progressBar = payload.progressBar as string;

      // Resolve Telegram target from session key OR tool result
      let chatId = payload.telegramChatId as string | undefined;
      let threadId = payload.telegramThreadId as string | undefined;

      if (!chatId) {
        // Auto-detect from session key
        const parsed = parseTelegramFromSessionKey(ctx.sessionKey);
        if (parsed) {
          chatId = parsed.chatId;
          threadId = parsed.threadId;
        }
      }

      if (!chatId) return; // Not a Telegram session — skip

      // Get current run state for messageId
      const active = state.findActiveRun(runsDir);
      if (!active) return;

      // Ensure telegram info is persisted in run state
      if (!active.state.telegramChatId) {
        active.state.telegramChatId = chatId;
        if (threadId) active.state.telegramThreadId = threadId;
        state.writeRunState(runsDir, active.runId, active.state);
      }

      const sendMsg = api.runtime.channel.telegram.sendMessageTelegram;
      const editMsg = api.runtime.channel.telegram.conversationActions.editMessage;
      const existingMessageId = active.state.telegramMessageId;

      try {
        if (!existingMessageId) {
          // First call — send initial progress bar
          const result = await sendMsg(chatId, progressBar, {
            ...(threadId ? { messageThreadId: parseInt(threadId, 10) } : {}),
          });
          if (result?.messageId) {
            active.state.telegramMessageId = String(result.messageId);
            state.writeRunState(runsDir, active.runId, active.state);
            api.logger.info(
              `[harness-enforcer] Progress bar sent: msgId=${result.messageId} chat=${chatId}`,
            );
          }
        } else {
          // Subsequent calls — edit existing message
          await editMsg(chatId, existingMessageId, progressBar);
          api.logger.info(
            `[harness-enforcer] Progress bar updated: msgId=${existingMessageId} chat=${chatId}`,
          );
        }
      } catch (err) {
        // Best-effort — never block the pipeline
        api.logger.warn(
          `[harness-enforcer] Telegram progress update failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  },
};
