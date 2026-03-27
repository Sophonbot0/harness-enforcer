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
    // This hook fires AFTER every tool call. When the tool is a harness_*
    // tool that returned a progressBar + telegram info, we send/edit the
    // Telegram message directly from the plugin — no agent cooperation needed.
    api.on("after_tool_call", async (event) => {
      if (!HARNESS_TOOLS.has(event.toolName)) return;

      // Parse the tool result to extract progressBar and telegram info
      let payload: Record<string, unknown> | null = null;
      try {
        if (event.result && typeof event.result === "object") {
          const r = event.result as Record<string, unknown>;
          // Tool results come as { content: [{type:"text", text:"..."}], details: {...} }
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
        // Parsing failed — skip silently
        return;
      }

      if (!payload?.progressBar || typeof payload.progressBar !== "string") return;

      const progressBar = payload.progressBar as string;
      const telegramAction = payload.telegramAction as string | undefined;
      const chatId = payload.telegramChatId as string | undefined;
      const messageId = payload.telegramMessageId as string | undefined;
      const threadId = payload.telegramThreadId as string | undefined;

      if (!chatId) return;

      const sendMsg = api.runtime.channel.telegram.sendMessageTelegram;
      const editMsg = api.runtime.channel.telegram.conversationActions.editMessage;

      try {
        if (telegramAction === "send") {
          // Initial send — store messageId in run state
          const result = await sendMsg(chatId, progressBar, {
            ...(threadId ? { messageThreadId: parseInt(threadId, 10) } : {}),
          });
          if (result?.messageId) {
            // Persist the messageId back into the run state
            const active = state.findActiveRun(runsDir);
            if (active) {
              active.state.telegramMessageId = String(result.messageId);
              state.writeRunState(runsDir, active.runId, active.state);
              api.logger.info(
                `[harness-enforcer] Progress bar sent: messageId=${result.messageId} chatId=${chatId}`,
              );
            }
          }
        } else if (telegramAction === "edit" && messageId) {
          // Edit existing message
          await editMsg(chatId, messageId, progressBar);
          api.logger.info(
            `[harness-enforcer] Progress bar updated: messageId=${messageId} chatId=${chatId}`,
          );
        }
      } catch (err) {
        // Best-effort — never block the pipeline
        api.logger.warn(
          `[harness-enforcer] Failed to update Telegram progress bar: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  },
};
