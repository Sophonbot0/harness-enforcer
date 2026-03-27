# Harness Progress Bar — Telegram Visual Progress Analysis

**Date:** 2026-03-27  
**Status:** ANALYSIS ONLY — no implementation  
**Author:** Planner subagent

---

## 1. Telegram Platform Capabilities

### 1.1 Message Editing

**Yes — fully supported.** Telegram Bot API exposes `editMessageText`, `editMessageMedia`, and `editMessageReplyMarkup`. Key facts:

- Bots can edit their own messages at any time (no time window limitation like regular users)
- Requires `chat_id` + `message_id` (returned when the message is first sent)
- Supports `parse_mode: "HTML"` or `"MarkdownV2"` on edit
- The edited message replaces the original in-place — no flickering or new message

### 1.2 HTML Formatting Subset

Telegram supports a **limited but sufficient** subset of HTML:

| Tag | Purpose |
|-----|---------|
| `<b>`, `<strong>` | Bold |
| `<i>`, `<em>` | Italic |
| `<u>`, `<ins>` | Underline |
| `<s>`, `<strike>`, `<del>` | Strikethrough |
| `<code>` | Inline monospace |
| `<pre>` | Code block (monospace, preserves whitespace) |
| `<pre><code class="language-X">` | Syntax-highlighted code block |
| `<a href="...">` | Hyperlinks |
| `<tg-spoiler>` | Spoiler text |
| `<tg-emoji>` | Custom emoji (Premium bots) |
| `<blockquote>` | Block quotes |

**Not supported:** `<div>`, `<span>`, `<table>`, `<img>`, CSS, colors, backgrounds, fonts, or any layout tags.

**Key insight:** `<pre>` forces monospace rendering, which is critical for aligned progress bars. Unicode block characters render correctly in monospace.

### 1.3 Unicode Progress Bars

**Yes — works well.** Telegram renders Unicode block characters correctly across all platforms:

| Character | Code Point | Description |
|-----------|------------|-------------|
| `█` | U+2588 | Full block (filled) |
| `░` | U+2591 | Light shade (empty) |
| `▓` | U+2593 | Dark shade (partial) |
| `▒` | U+2592 | Medium shade |
| `▰` | U+25B0 | Black parallelogram |
| `▱` | U+25B1 | White parallelogram |
| `━` | U+2501 | Heavy horizontal line |

**Best pattern for Telegram:**
```
████████░░░░░░░░░░░░ 40%
```
Using `█` for filled and `░` for empty, wrapped in `<pre>` or backtick fences for monospace alignment.

**Emoji approach (no monospace needed):**
```
🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ 40%
```
Emoji renders at a consistent width but takes more horizontal space. Good for status indicators but less precise for bars.

### 1.4 Rate Limits

Telegram rate limits are **per bot, per chat**:

| Scope | Limit | Notes |
|-------|-------|-------|
| Per chat | ~1 message/second | Both send and edit count |
| Global (all chats) | ~30 requests/second | Across all API calls |
| Group chats | ~20 messages/minute per group | More restrictive for groups |
| Edit same message | No additional limit beyond per-chat | Same as sending |

**For our use case:** A harness run typically has 4-10 checkpoints over 5-30 minutes. That's 1 edit every few minutes — **zero rate limit concern.** Even if we polled and edited every 5 seconds, we'd be well within limits.

### 1.5 Telegram Mini Apps (Web Apps)

- Requires an HTTPS-served HTML page (needs a running web server with a public URL or tunnel)
- Opens in an in-app browser overlay — user must tap a button to open
- Full HTML5/CSS3/JS with access to `Telegram.WebApp` JS API
- Real-time updates via WebSocket/SSE are possible
- **Not passively visible** — user has to actively open the Mini App each time

### 1.6 Inline Keyboards

- Bots can attach inline keyboard buttons to messages
- Buttons can have callback data (triggers bot webhook) or URLs
- Buttons can be updated via `editMessageReplyMarkup`
- Style parameter available (primary, secondary, success, danger) as of Bot API 9.4
- **Cannot display progress** — buttons are interactive controls, not visual indicators

### 1.7 Animated/Updating Content

- Telegram does **not** support live-streaming text or animations within messages
- `sendMessageDraft` (Bot API 9.3+) allows streaming partial messages while being generated — but this is for LLM-style streaming, not persistent progress
- The only way to "animate" is to repeatedly call `editMessageText` on the same message
- GIFs and animations are supported as media, but not useful for dynamic data

---

## 2. Approach Analysis

### Option A: Unicode Progress Bar (Message Edit)

**Concept:** Send a single Telegram message at harness start. On each `harness_checkpoint`, edit that message with an updated Unicode progress bar.

**Example render:**
```
🔧 Harness Run: feature-xyz
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 

📋 Phase: BUILD ⏳  |  ⏱ 3m 42s
████████████░░░░░░░░ 60%

DoD Progress (3/5):
✅ Schema types defined
✅ API endpoint created  
✅ Unit tests passing
⏳ Integration tests
⬜ Documentation updated

🚧 Blockers: none
```

| Criterion | Assessment |
|-----------|------------|
| **Complexity** | 🟢 Very low — ~50 lines of formatting code |
| **Dependencies** | 🟢 Only needs OpenClaw's `message` tool (edit action) |
| **Rate limits** | 🟢 Zero concern (1 edit per checkpoint, minutes apart) |
| **UX quality** | 🟡 Good — clear, informative, always visible in chat |
| **Cross-platform** | 🟢 Works on mobile, desktop, web Telegram |
| **Passive visibility** | 🟢 Always visible in chat — no interaction needed |
| **Real-time** | 🟡 Updates only on checkpoint (not continuously) |

**Pros:**
- Simplest to implement by far
- No external dependencies (no server, no tunnel, no web hosting)
- Message stays visible in chat history — user sees progress without interaction
- Unicode block chars render consistently across Telegram platforms
- Can include rich context: phase, DoD items, blockers, elapsed time
- Natural fit with harness_checkpoint events
- OpenClaw's `message` tool already supports `edit` action

**Cons:**
- Not "real-time" in the animated sense — updates only when checkpoints fire
- Limited formatting (no colors, no CSS, no charts)
- Long DoD lists might make the message tall (Telegram has ~4096 char message limit)
- No interaction/drill-down capability

### Option B: Telegram Web App (Mini App)

**Concept:** Host an HTML5 dashboard with real-time WebSocket updates. Attach it to a message via inline keyboard button.

| Criterion | Assessment |
|-----------|------------|
| **Complexity** | 🔴 Very high — needs HTTP server, WebSocket, HTML/CSS/JS app, public URL |
| **Dependencies** | 🔴 Web server, ngrok/tunnel or public hosting, HTTPS cert |
| **Rate limits** | 🟢 N/A — WebSocket bypasses Telegram API |
| **UX quality** | 🟢 Excellent — full CSS animations, charts, real-time |
| **Cross-platform** | 🟡 Works but UX varies (mobile WebView vs desktop) |
| **Passive visibility** | 🔴 User must tap button to view — not passively visible |
| **Real-time** | 🟢 True real-time via WebSocket |

**Pros:**
- Richest possible visuals (CSS progress bars, animations, charts)
- True real-time updates without Telegram API calls
- Could show historical data, phase timeline, click-to-expand details
- Full interactivity (filters, drill-downs, refresh)

**Cons:**
- Massive implementation overhead for a progress bar
- Requires running a persistent HTTP server with public accessibility
- Requires HTTPS (self-signed won't work — Telegram validates certs)
- User must actively open the Mini App each time — not passively visible in chat
- Overkill for the problem at hand
- Maintenance burden: another service to keep running

### Option C: Inline Keyboard with Status Buttons

**Concept:** Attach inline keyboard buttons showing phase status. Update buttons as phases complete.

**Example render:**
```
Message text: "Harness Run: feature-xyz (3/5 DoD items)"
Buttons:
[✅ Plan] [🔧 Build] [⬜ Challenge] [⬜ Eval]
```

| Criterion | Assessment |
|-----------|------------|
| **Complexity** | 🟡 Low-medium — needs button management + callback handling |
| **Dependencies** | 🟡 OpenClaw message tool + callback handling infrastructure |
| **Rate limits** | 🟢 Same as Option A |
| **UX quality** | 🔴 Poor for progress — buttons are action controls, not progress indicators |
| **Cross-platform** | 🟢 Works everywhere |
| **Passive visibility** | 🟡 Partially visible (buttons visible but small) |
| **Real-time** | 🟡 Same as Option A (checkpoint-driven) |

**Pros:**
- Interactive — could tap a phase button to expand details
- Compact representation of pipeline phases
- Could combine with text progress (buttons below a text summary)

**Cons:**
- Buttons are meant for user actions, not status display — semantic mismatch
- Limited space for information (button labels are short)
- Callback handling infrastructure doesn't exist in harness-enforcer
- Can't show granular progress (e.g., "3 of 5 features done") in button labels
- Users may be confused about whether buttons are tappable actions

### Option D: Image Generation

**Concept:** Generate a PNG progress image (using `image_generate` tool or canvas/HTML rendering) and send/update it.

| Criterion | Assessment |
|-----------|------------|
| **Complexity** | 🟡 Medium — need image generation pipeline |
| **Dependencies** | 🟡 Image generation tool or HTML-to-image renderer |
| **Rate limits** | 🟡 Slightly higher concern — image edits are heavier |
| **UX quality** | 🟢 Very good — actual visual charts, colors, branding |
| **Cross-platform** | 🟢 Works everywhere (it's just a photo) |
| **Passive visibility** | 🟢 Image visible in chat like any photo |
| **Real-time** | 🔴 Slowest updates — image generation adds latency |

**Pros:**
- Rich visuals: actual rounded progress bars, charts, color coding
- Full design control (fonts, colors, layout)
- Looks professional

**Cons:**
- Image generation adds 2-5 seconds latency per update
- Editing a photo message replaces the image (slight flicker)
- Heavier on bandwidth and storage
- More complex pipeline: generate image → upload → edit message
- OpenClaw's `image_generate` is AI-based (DALL-E etc.) — not suited for dashboards
- Would need a separate tool (canvas-to-PNG, Puppeteer, or SVG renderer)
- Overkill for the frequency of updates

---

## 3. Integration Architecture

### 3.1 Current Harness Plugin Flow

```
harness_start → creates run, extracts DoD
    ↓
harness_checkpoint (×N) → saves phase, completed/pending, blockers
    ↓
harness_submit → validates gates, delivers
```

The checkpoint tool already records:
- `phase` (plan/build/challenge/eval)
- `completedFeatures[]`
- `pendingFeatures[]`
- `blockers[]`
- `summary`

This is **exactly** the data needed to render a progress bar.

### 3.2 Integration Approach: Plugin-Side Hook

**Option 1: Hook inside `harness_checkpoint` tool (RECOMMENDED)**

Add a post-checkpoint hook in the plugin that calls the OpenClaw message tool to edit the progress message.

Flow:
```
Agent calls harness_start
  → Plugin creates run
  → Plugin sends initial Telegram message via message tool
  → Plugin stores message_id in run state

Agent calls harness_checkpoint
  → Plugin saves checkpoint (existing logic)
  → Plugin renders progress text from checkpoint data
  → Plugin calls message.edit with stored message_id
  → Updated progress visible in Telegram
```

**Feasibility concern:** The plugin currently only uses file I/O (`fs.writeFileSync`). It does NOT call the message tool. The plugin API (`OpenClawPluginApi`) would need to expose a method for sending/editing messages, or the plugin would need to return structured data that the orchestrator acts on.

**Option 2: Agent-side rendering (SIMPLER)**

Instead of modifying the plugin, add instructions in the harness system prompt:

> "After each `harness_checkpoint`, send or edit a Telegram message with a formatted progress bar."

The agent would:
1. On `harness_start`: call `message send` to Telegram → note the `message_id`
2. On each `harness_checkpoint`: call `message edit` with the progress text
3. On `harness_submit`: send final completion message

**Pros of agent-side:** No plugin code changes. Uses existing tools. Agent can format flexibly.  
**Cons of agent-side:** Relies on agent remembering to update. Message ID must survive context compaction. More token overhead per checkpoint.

**Option 3: Hybrid — plugin returns render data, agent sends**

The plugin's checkpoint response already includes `completedCount`, `pendingCount`, `phase`, `elapsed`. The agent could use this structured data to format and send the message.

### 3.3 OpenClaw Message Tool — Edit Support

The OpenClaw `message` tool schema shows an `edit` action is available:

```
action: "edit"
messageId: string  — the message to edit
message: string    — new text
```

This confirms **message editing is already supported** in OpenClaw's Telegram integration. The key requirement is capturing the `message_id` from the initial send and persisting it.

### 3.4 Message ID Persistence

The `message_id` returned by the initial `message send` call must be stored so that subsequent edits target the correct message. Options:

- **In run state:** Add a `telegramMessageId` field to `RunState` interface — cleanest, survives context compaction
- **In agent memory:** Agent remembers it — fragile, may be lost on compaction
- **In a sidecar file:** `progress-msg.json` in the run directory — simple, no schema change

---

## 4. Feasibility Assessment Summary

| Criterion | A: Unicode | B: Web App | C: Buttons | D: Image |
|-----------|-----------|------------|------------|----------|
| Implementation effort | **~2 hours** | ~2-3 days | ~4 hours | ~6 hours |
| External dependencies | None | Server, HTTPS, tunnel | Callback infra | Renderer |
| Rate limit risk | None | N/A | None | Low |
| UX quality | Good | Excellent | Poor | Very good |
| Passive visibility | ✅ Yes | ❌ No | Partial | ✅ Yes |
| Maintenance burden | Minimal | High | Low | Medium |
| OpenClaw tool support | ✅ Full | ❌ None | Partial | Partial |
| Fits harness cadence | ✅ Perfect | Overkill | Awkward | Overkill |

---

## 5. Recommendation

### 🏆 Start with Option A: Unicode Progress Bar

**Why:**

1. **Lowest implementation cost** — can be done in a single session
2. **Perfect fit for the update cadence** — harness runs produce 4-10 checkpoints over minutes, not continuous updates; message editing at each checkpoint is ideal
3. **Zero infrastructure** — no servers, no HTTPS, no tunnels; just text formatting
4. **Passively visible** — the message sits in the chat, always showing current status; user doesn't need to tap anything
5. **Already supported** — OpenClaw's `message` tool has `edit` action, Telegram's `editMessageText` API has no meaningful rate limits for this use case
6. **Rich enough** — Unicode block characters, emoji, and monospace formatting provide a clear, informative progress display

### Proposed Message Format

```
🔧 Harness: feature-xyz
━━━━━━━━━━━━━━━━━━━━━━━━━

📋 PLAN → BUILD → Challenge → Eval
████████████░░░░░░░░ 60%  ⏱ 3m 42s

DoD (3/5):
 ✅ Schema types defined
 ✅ API endpoint created
 ✅ Unit tests passing
 ⏳ Integration tests
 ⬜ Documentation updated

📌 0 blockers
```

### Implementation Path

1. **Add `telegramMessageId` field to `RunState`** — 1 line in state.ts
2. **Create progress renderer function** — takes checkpoint data → returns formatted string (~30 lines)
3. **In `harness_start` tool** — after creating run, send initial Telegram message, store returned message_id
4. **In `harness_checkpoint` tool** — after saving checkpoint, render progress text, edit the Telegram message
5. **In `harness_submit` tool** — send final "✅ Delivered" message (or edit to show final state)
6. **In `harness_reset` tool** — edit to show "❌ Cancelled"

### Future Upgrade Path

Option A provides an 80/20 solution. If richer visuals are needed later:

- **A+C hybrid:** Add inline keyboard buttons below the text for drill-down (tap "Build" to see sub-tasks)
- **A→D upgrade:** Replace text with generated images for richer charts (when the cadence warrants it)
- **A→B upgrade:** If a full dashboard is eventually needed, the Mini App can reuse the same state data

---

## 6. Open Questions for Implementation

1. **Plugin API access:** Can the harness-enforcer plugin call `api.message()` or similar to send/edit Telegram messages? If not, should the progress update be agent-side (via system prompt instructions)?

2. **Target chat:** Should the progress message go to the same chat the harness was triggered from? Or a dedicated "monitoring" chat/channel?

3. **Multiple concurrent watchers:** If multiple people are watching, should the progress update go to a channel rather than a DM?

4. **Message character limit:** Telegram's 4096 char limit per message. For plans with 20+ DoD items, should we truncate or paginate?

5. **Completion notification:** Should `harness_submit` also send a separate notification (e.g., with a celebratory emoji) in addition to updating the progress bar?
