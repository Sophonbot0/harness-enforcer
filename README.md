# harness-enforcer

A 4-agent quality enforcement system for [OpenClaw](https://github.com/openclaw/openclaw) — automated planning, building, adversarial challenge, and evaluation for complex development tasks.

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
                         STUCK? → escalate to owner
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
| `harness_start` | Initialise run, extract DoD from plan.md, enforce one-active-run |
| `harness_checkpoint` | Save progress to disk (survives context compaction) |
| `harness_submit` | Quality gate — validates eval PASS + DoD checked + no CRITICALs |
| `harness_status` | Inspect active/past runs, view progress |
| `harness_reset` | Cancel active run, mark as cancelled, allow fresh start |

### Key Features

- **Intelligent loop control** — continues if progress is made, escalates to owner if stuck (no dumb round limits)
- **Sprint-aware planning** — large projects (>8 features) auto-split into sprints of 3-5 features each
- **Telegram progress bar** — live-updating Unicode progress bar via message editing
- **Planner Q&A** — planner can ask clarifying questions before writing the plan
- **Path sanitisation** — input validation, path traversal protection
- **Concurrency protection** — in-memory locks prevent parallel state corruption
- **130 smoke tests** passing

## Install

### 1. Clone the repo

```bash
git clone https://github.com/Sophonbot0/harness-enforcer.git
```

### 2. Install the plugin

Copy or symlink the repo root to your OpenClaw extensions directory:

```bash
# Option A: Symlink (recommended for dev)
ln -s /path/to/harness-enforcer ~/.openclaw/extensions/harness-enforcer

# Option B: Copy
cp -r /path/to/harness-enforcer ~/.openclaw/extensions/harness-enforcer
```

### 3. Install the skill

Copy the skill directory to your OpenClaw skills directory:

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

The plugin loads on gateway start. Restart your OpenClaw gateway to activate.

## Configuration

Optional settings in `openclaw.json` under `plugins.entries.harness-enforcer.config`:

```json
{
  "enabled": true,
  "runsDir": "~/.openclaw/harness-enforcer/runs"
}
```

## Project Structure

```
harness-enforcer/
├── index.ts                          # Plugin entry point
├── openclaw.plugin.json              # Plugin manifest
├── package.json
├── tsconfig.json
├── test-smoke.ts                     # 130 smoke tests
│
├── src/
│   ├── tools.ts                      # All 5 tool implementations
│   ├── state.ts                      # Run state management (JSON files)
│   ├── validation.ts                 # Input validation, DoD parsing
│   └── progress.ts                   # Telegram progress bar renderer
│
└── skill/                            # Harness orchestration skill
    ├── SKILL.md                      # Main skill definition (4-agent workflow)
    ├── prompts/
    │   ├── planner-system.md         # Planner agent prompt (Q&A + sprint-aware)
    │   ├── generator-system.md       # Generator agent prompt
    │   ├── adversary-system.md       # Adversary agent prompt (devil's advocate)
    │   └── evaluator-system.md       # Evaluator agent prompt (progress delta)
    ├── templates/
    │   ├── plan-template.md          # Plan output format (sprint-aware)
    │   ├── eval-report-template.md   # Eval report format
    │   └── challenge-report-template.md  # Challenge report format
    └── references/
        └── grading-criteria.md       # Domain-specific grading criteria
```

## State Storage

Run state persists at `~/.openclaw/harness-enforcer/runs/{runId}/`:

```
runs/
  2026-03-27T14-22-14-245Z-9v9pji/
    run-state.json      # Run metadata, phase, status
    dod-items.json      # Extracted DoD checkboxes from plan
    checkpoints.jsonl   # Append-only progress log
    delivery.json       # Final delivery record (on completion)
```

No database — plain JSON files. Easy to inspect and debug.

## How It Works

### For small projects (≤8 features)

```
User request → PLAN → BUILD → CHALLENGE → EVAL → DONE
```

### For large projects (>8 features)

```
User request → MASTER PLAN (all features)
  → Sprint 1 (3-5 features) → PLAN → BUILD → CHALLENGE → EVAL ✅
  → Sprint 2 (3-5 features) → PLAN → BUILD → CHALLENGE → EVAL ✅
  → Sprint 3 (3-5 features) → PLAN → BUILD → CHALLENGE → EVAL ✅
  → Integration eval (if >2 sprints)
```

### Progress Bar (Telegram)

A live-updating message shows progress during runs:

```
🔧 Sprint Architecture
●plan→●build→▶challenge→○eval
▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱ 66% ⏱2m 30s
✅ Planner prompt
✅ Plan template
⏳ SKILL.md
⬜ Progress bar
2/4 done | 0 blockers
```

Updates at every phase transition (minimum 8 per cycle).

## Development

```bash
# Run smoke tests
npx tsx test-smoke.ts
```

## License

MIT
