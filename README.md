# harness-enforcer

Runtime enforcement plugin for the OpenClaw 4-agent harness pipeline (Plan → Build → Challenge → Eval).

## What it does

The harness-enforcer plugin provides 4 tools that enforce quality gates during development pipelines:

| Tool | Purpose |
|---|---|
| `harness_start` | Initialise a run, extract DoD items from plan.md, enforce one-active-run policy |
| `harness_checkpoint` | Save progress to disk (survives context compaction) |
| `harness_submit` | Quality gate — validates eval PASS + DoD checked + no unresolved CRITICALs |
| `harness_status` | Inspect active/past runs, view progress and grades |
| `harness_reset` | Cancel the active run, mark as cancelled, allow a fresh `harness_start` |

## Key Features

- **File-based state** — JSON/JSONL, no database, fully inspectable
- **Path sanitisation** — rejects traversal attacks, restricts to `~/.openclaw`
- **Robust I/O** — all file operations wrapped in try-catch with structured errors
- **Concurrency protection** — in-memory locks prevent parallel state corruption
- **Flexible DoD parsing** — supports `- [ ]`, `* [ ]`, indented checkboxes, ignores code blocks

## Install

Copy or symlink to your OpenClaw extensions directory:

```bash
# Clone
git clone https://github.com/Sophonbot0/harness-enforcer.git ~/.openclaw/extensions/harness-enforcer

# Or symlink
ln -s /path/to/harness-enforcer ~/.openclaw/extensions/harness-enforcer
```

The plugin is auto-discovered by OpenClaw from the extensions directory.

## Configuration

In your OpenClaw config, you can optionally set:

```json
{
  "harness-enforcer": {
    "enabled": true,
    "runsDir": "~/.openclaw/harness-enforcer/runs"
  }
}
```

## State Storage

Run state is persisted at `~/.openclaw/harness-enforcer/runs/{runId}/`:

```
runs/
  2026-03-27T13-30-00-000Z/
    run-state.json      # Run metadata, phase, status
    dod-items.json      # Extracted DoD checkboxes
    checkpoints.jsonl   # Append-only progress log
    delivery.json       # Final delivery record (on completion)
```

## Development

```bash
# Run smoke tests
npx tsx test-smoke.ts
```

## License

MIT
