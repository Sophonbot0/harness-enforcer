# Plan: Telegram Progress Bar for Harness Runs

## Status: READY

## User Request (verbatim)
"Implementa. Usa o harness e depois no fim fazemos um teste. Se eu aprovar fazemos commit no GitHub para o projeto"

Context: Unicode progress bar approach (Option A from analysis). Edit a single Telegram message with visual progress as harness runs.

## Extracted Requirements
1. [Explicit] Send a visual progress bar message to Telegram when a harness run starts
2. [Explicit] Update (edit) that message as DoD items are completed
3. [Explicit] Use Unicode block characters for the progress bar
4. [Implicit] Show: phase, DoD progress per feature, elapsed time, blockers
5. [Implicit] The message edit must use OpenClaw's `message` tool with `action: "edit"`
6. [Implicit] Must work in the current Telegram channel (topic:1 of Ultron Channel)
7. [Implicit] Must not break existing harness functionality
8. [Implicit] The progress is updated whenever `harness_checkpoint` is called

## Context
- Harness skill: /Users/jbelo/.openclaw/skills/harness/
- Plugin: /Users/jbelo/.openclaw/extensions/harness-enforcer/
- Telegram channel: Ultron Channel id:-1003868711850 topic:1
- OpenClaw message tool supports: send, edit, delete, poll, react
- Message edit needs: messageId (from send response), action: "edit"
- The orchestrator (main agent) calls harness_checkpoint and can also call message edit

## Features

### Feature 1: Progress Bar Rendering Function
- **Description:** A function that takes harness run state and returns a formatted Unicode progress bar string for Telegram.
- **Covers requirements:** #1, #3, #4
- **DoD:**
  - [ ] Function exists that accepts: taskDescription, phase, completedFeatures[], pendingFeatures[], blockers[], dodTotal, dodCompleted, elapsedSeconds
  - [ ] Returns formatted string with: title, phase indicator, Unicode bar, DoD percentage, per-feature status, elapsed time, blockers
  - [ ] Unicode bar uses █ for filled, ░ for empty, 20 characters wide
  - [ ] Phase shows: ✅ for completed phases, ⏳ for current, ⬜ for pending
  - [ ] Features show: ✅ for completed, ⏳ for in-progress, ⬜ for pending
  - [ ] String is under 4096 chars (Telegram limit)

### Feature 2: Update SKILL.md with Progress Bar Instructions
- **Description:** Add instructions to SKILL.md telling the orchestrator to send and edit a progress message during harness runs.
- **Covers requirements:** #2, #5, #6, #8
- **DoD:**
  - [ ] SKILL.md has a "Progress Bar" section explaining the flow
  - [ ] Instructions: at harness_start, send initial progress message and save the messageId
  - [ ] Instructions: at each harness_checkpoint, edit the message with updated progress
  - [ ] Instructions: at harness_submit/harness_reset, edit with final status (PASS/FAIL/CANCELLED)
  - [ ] Example message format included in SKILL.md

### Feature 3: Smoke Test
- **Description:** Test the rendering function produces correct output.
- **Covers requirements:** #7
- **DoD:**
  - [ ] Test that rendering function produces valid output for: 0% progress, 50% progress, 100% progress
  - [ ] Test that output is under 4096 chars even with 10 features
  - [ ] Test that all special characters render correctly

## Requirements Coverage Matrix
| Requirement | Covered by Feature(s) | DoD items |
|---|---|---|
| #1 Send progress bar | Feature 1, 2 | 1.1, 2.2 |
| #2 Update on progress | Feature 2 | 2.3 |
| #3 Unicode bar | Feature 1 | 1.3 |
| #4 Show phase/DoD/time | Feature 1 | 1.2, 1.4, 1.5 |
| #5 Message edit | Feature 2 | 2.3 |
| #6 Works in channel | Feature 2 | 2.2 |
| #7 No break existing | Feature 3 | 3.1 |
| #8 Update on checkpoint | Feature 2 | 2.3 |

## Technical Notes
- The rendering function goes in the plugin (src/progress.ts) so it's reusable
- The orchestration (send/edit) stays in SKILL.md as instructions for the main agent
- The main agent uses `message` tool with `action: "send"` first, captures messageId, then `action: "edit"` with same messageId on each checkpoint

## Out of Scope
- Telegram Mini App / Web App
- Image generation
- Real-time streaming (only updates on checkpoint)
- Inline keyboards
