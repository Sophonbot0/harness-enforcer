# harness-enforcer

A contract-driven quality enforcement system for [OpenClaw](https://github.com/openclaw/openclaw) — automated planning, building, adversarial challenge, and evaluation for complex development tasks with **full autonomy support**.

## What is this?

Two components that work together:

1. **Plugin** (`harness-enforcer`) — OpenClaw runtime tools that enforce quality gates
2. **Skill** (`harness`) — Orchestration instructions for the 4-agent pipeline

### The Pipeline

```
PLAN → BUILD → CHALLENGE → EVAL
                              ↓
                         DONE? → ✅ deliver
                         NOT DONE? → retry BUILD
                         STUCK? → skip / split / escalate
```

| Phase | Agent | Role |
|---|---|---|
| **PLAN** | Planner | Extracts ALL requirements, writes plan with DoD items |
| **BUILD** | Generator | Implements features, runs tests, commits |
| **CHALLENGE** | Adversary | Devil's advocate — finds holes, overconfidence, untested assumptions |
| **EVAL** | Evaluator | Tests against DoD, produces progress delta for loop control |

### Plugin Tools

| Tool | Purpose |
|---|---|
| `harness_start` | Initialise run, generate Contract Document from plan, enforce one-active-run per session |
| `harness_checkpoint` | Save progress, auto-verify contract items, advance to next item |
| `harness_submit` | Quality gate — validates eval PASS + DoD checked + all contract items passed |
| `harness_status` | Inspect active/past runs (session-scoped), view contract status |
| `harness_reset` | Cancel active run, clean up Telegram progress bar |
| `harness_resume` | Resume cancelled/stale/failed runs with full context recovery |
| `harness_plan` | Multi-phase project decomposition with manifest and auto-chaining |
| `harness_challenge` | Automated quality checks (file existence, syntax, verify command) |
| `harness_modify` | Dynamic re-planning: add, skip, split, or update contract items mid-run |

### v2 Autonomy Features

#### 1. 📝 Contract Document System
Every DoD item becomes a **contract item** with acceptance criteria, verify commands, and retry limits. The contract is the single source of truth — each item is auto-verified on checkpoint.

#### 2. 🧠 Context Budget Management
- Forced checkpoint reminders after 10 minutes of inactivity
- Session bootstrap on restart: injects contract status + next item + learning history
- Full context recovery after crashes/compaction via `contract.json`

#### 3. 🚨 Self-Healing / Auto-Recovery
- Auto-skip items that exhaust max attempts (if no downstream dependencies)
- Escalation with actionable instructions when items block others
- Proactive hints: "search the web", "try different approach", "use harness_modify"
- Learning log prevents repeating failed approaches

#### 4. 📊 Heartbeat & Watchdog
- Heartbeat every 15 min: % progress, ETA, current item
- Item timeout alerts (30 min default per item)
- Stale run auto-cancel (2h timeout)
- Progress stall detection

#### 5. 🔀 Parallel Contract Items
- `getParallelContractItems()` detects items without dependencies
- `parallelGroup` for explicit grouping
- Parallel hints with spawn instructions on start/checkpoint

#### 6. 📝 Dynamic Re-planning (`harness_modify`)
- **add**: new contract items mid-run
- **skip**: skip with documented reason
- **split**: break item into sub-items with auto-adjusted dependencies
- **update**: change acceptance criteria or verify command

#### 7. 💾 Git Rollback per Item
- Snapshots `HEAD` before each new item
- Rollback hints on failure: `git checkout <tag>`
- Working directory auto-detected from plan path

#### 8. 📈 Learning Loop
- `learning.jsonl` per run — each success/failure logged with approach + lesson
- Cross-run learning: `readGlobalLearning()` reads ALL past runs
- Past failures shown on `harness_start` to avoid repeating mistakes

### Session Isolation

Runs are scoped to their originating session (Telegram channel/topic). Multiple concurrent runs across different sessions never interfere:

- Session key derived from `telegramChatId` + `telegramThreadId` (takes priority over gateway `ctx.sessionKey`)
- `harness_status` only shows runs from the current session
- `listCompletedRuns` filtered by session
- `findMostRecentRun` scoped to session

### Progress Bar (Telegram)

A live-updating message shows contract progress:

```
🔧 My Task
●plan→▶build→○challenge→○eval
▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱ 67% ⏱5m 30s
✅ Database schema
✅ API endpoints
⬜ Frontend integration
2/3 done | 0 blockers

📝 › Implementing API endpoints
```

The agent sends the initial bar via `message` tool (whitelisted through silent mode), then edits it on each checkpoint.

## Install

### 1. Clone the repo

```bash
git clone https://github.com/Sophonbot0/harness-enforcer.git
```

### 2. Install the plugin

```bash
# Option A: Symlink (recommended for dev)
ln -s /path/to/harness-enforcer ~/.openclaw/extensions/harness-enforcer

# Option B: Copy
cp -r /path/to/harness-enforcer ~/.openclaw/extensions/harness-enforcer
```

### 3. Install the skill

```bash
cp -r /path/to/harness-enforcer/skill ~/.openclaw/skills/harness
```

### 4. Enable the plugin

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["harness-enforcer"],
    "entries": {
      "harness-enforcer": {
        "enabled": true
      }
    }
  }
}
```

### 5. Restart OpenClaw

The plugin loads on gateway start.

## Configuration

Optional settings in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "harness-enforcer": {
        "enabled": true,
        "config": {
          "runsDir": "~/.openclaw/harness-enforcer/runs"
        }
      }
    }
  }
}
```

## Project Structure

```
harness-enforcer/
├── index.ts                          # Plugin entry point + hooks (watchdog, heartbeat, session bootstrap)
├── openclaw.plugin.json              # Plugin manifest
├── package.json
├── tsconfig.json
├── test-smoke.ts                     # Smoke tests
│
├── src/
│   ├── tools.ts                      # 9 tool implementations (start, checkpoint, submit, status, reset, resume, plan, challenge, modify)
│   ├── state.ts                      # Run state, contract, learning, manifest management
│   ├── validation.ts                 # Input validation, DoD/contract parsing
│   └── progress.ts                   # Telegram progress bar renderer
│
└── skill/                            # Harness orchestration skill
    ├── SKILL.md
    ├── prompts/
    │   ├── planner-system.md
    │   ├── generator-system.md
    │   ├── adversary-system.md
    │   └── evaluator-system.md
    ├── templates/
    │   ├── plan-template.md
    │   ├── eval-report-template.md
    │   └── challenge-report-template.md
    └── references/
        └── grading-criteria.md
```

## State Storage

```
runs/{runId}/
  run-state.json      # Run metadata, phase, status, session key, Telegram IDs
  dod-items.json      # Extracted DoD checkboxes
  features.json       # Feature tracking with verification status
  contract.json       # Contract items with acceptance criteria, attempts, status
  checkpoints.jsonl   # Append-only progress log with context snapshots
  learning.jsonl      # Success/failure log per item (approach + lesson)
  delivery.json       # Final delivery record
  contract.md         # Human-readable contract document
  progress.md         # Latest progress summary
```

## How It Works

### Contract-Driven Workflow

```
1. harness_start(plan.md)
   → Extract DoD items → Generate contract items
   → Each item gets: acceptance criteria, verify command, max attempts
   → Show first item to agent

2. Agent implements item → harness_checkpoint(completedFeatures=[...])
   → Auto-verify against contract (run verify command, check criteria)
   → If PASS → advance to next item
   → If FAIL → retry instructions with alternative approaches
   → If exhausted → auto-skip or escalate

3. All items done → harness_submit(eval-report.md)
   → Validate: PASS grade + all DoD checked + all contract items passed
   → If OK → DELIVERED ✅
   → If not → iteration with fix instructions

4. If stuck → harness_modify(action=skip|split|add|update)
   → Dynamic re-planning without restarting the run
```

### Multi-Phase Projects

```
harness_plan(plans=[...])
  → Phase 1 → harness_start → ... → harness_submit ✅
  → Phase 2 → auto-start → ... → harness_submit ✅
  → Phase N → auto-start → ... → harness_submit ✅
```

## License

MIT
