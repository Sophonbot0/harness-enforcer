import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface RunState {
  runId: string;
  planPath: string;
  taskDescription: string;
  startedAt: string;
  phase: string;
  round: number;
  checkpoints: string[];
  status: "active" | "completed" | "failed" | "cancelled";
  sessionKey?: string;  // Session that owns this run — enables concurrent runs
  telegramChatId?: string;
  telegramThreadId?: string;
  telegramMessageId?: string;
  verifyCommand?: string;
  workLog?: string[];  // Last N action entries for progress bar
  parentRunId?: string;  // Links sub-plans to a parent run for orchestration
  isSubagent?: boolean;  // Running inside a subagent — shorter stale timeout
  resumedFrom?: string;  // If this run was resumed from a cancelled/stale run
  lastContextSnapshot?: ContextSnapshot;  // Latest context snapshot for recovery
  // ─── Autonomy enhancements ───
  lastCheckpointAt?: string;       // ISO timestamp of last checkpoint (for forced checkpoint detection)
  currentContractItemId?: string;  // Which contract item the agent is working on
  currentItemStartedAt?: string;   // When the current item started (for per-item timeout)
  gitSnapshotBranch?: string;      // Branch used for per-item git snapshots
  workingDirectory?: string;       // Project working directory for git operations
  learningLog?: LearningEntry[];   // What worked / what didn't
}

export interface Checkpoint {
  timestamp: string;
  phase: string;
  completedFeatures: string[];
  pendingFeatures: string[];
  blockers: string[];
  summary: string;
  verificationLog?: string;
  contextSnapshot?: ContextSnapshot;
}

/** Cross-session context preservation — survives crashes and compaction */
export interface ContextSnapshot {
  keyDecisions?: string[];       // Important decisions made during this run
  filesModified?: string[];      // Files touched so far
  currentApproach?: string;      // What strategy is being used
  blockerHistory?: string[];     // Blockers that were resolved (for learning)
  nextSteps?: string[];          // What should happen next (for resume)
}

/** Learning entry — records what worked and what didn't across items */
export interface LearningEntry {
  timestamp: string;
  itemId: string;
  description: string;
  approach: string;
  outcome: "success" | "failure";
  lesson: string;               // What we learned
  durationSeconds?: number;
}

export interface Delivery {
  deliveredAt: string;
  evalGrade: string;
  totalRounds: number;
  elapsedSeconds: number;
  checkpointCount: number;
}

/** A plan within a multi-phase manifest */
export interface ManifestPlan {
  phase: number;           // 1-based sequence number
  title: string;
  path: string;            // Absolute path to the plan .md file
  dependsOn: number[];     // Phase numbers this plan depends on
  parallel: boolean;       // Can run in parallel with other plans at same level
  estimatedMinutes?: number;
  status: "pending" | "active" | "completed" | "failed" | "skipped";
  runId?: string;          // Harness run ID once started
  evalGrade?: string;      // Grade once completed
  completedAt?: string;
}

/** Master manifest for multi-phase project decomposition */
export interface Manifest {
  manifestId: string;
  projectDescription: string;
  createdAt: string;
  plansDir: string;        // Directory containing the generated plan files
  plans: ManifestPlan[];
  currentPhase: number;    // Which phase is currently active/next
  status: "active" | "completed" | "failed";
}

export interface DodItem {
  text: string;
  checked: boolean;
}

export interface Feature {
  id: string;
  category: string;
  description: string;
  status: "pending" | "in_progress" | "passed" | "failed" | "deferred";
  verifiedAt?: string;
  verifiedBy?: string;  // "test" | "build" | "manual" | "lint"
}

/** Contract item — single source of truth for each deliverable */
export interface ContractItem {
  id: string;                    // e.g. "c001"
  description: string;           // What to build/do
  acceptanceCriteria: string[];   // How to verify it's done (human-readable)
  verifyCommand?: string;         // Optional shell command to verify (exit 0 = pass)
  verifyFileExists?: string[];    // Optional files that must exist when done
  status: "pending" | "in_progress" | "passed" | "failed" | "skipped";
  attempts: number;               // How many times we tried
  maxAttempts: number;            // Max retries (default 3)
  evidence?: string;              // Output/proof of completion (last 1000 chars)
  failureLog?: string;            // Why it failed last time
  startedAt?: string;
  completedAt?: string;
  dependsOn?: string[];           // IDs of contract items this depends on
  skipReason?: string;            // Why this item was skipped
  gitTag?: string;                // Git tag/commit before this item started (for rollback)
  timeoutMinutes?: number;        // Per-item timeout (default 30)
  alternativeApproaches?: string[]; // Approaches to try if primary fails
  parallelGroup?: string;         // Items with same group can run in parallel
}

// ─── Concurrency Lock (MEDIUM 3) ───

const locks = new Map<string, boolean>();

function acquireLock(runId: string): void {
  if (locks.get(runId)) {
    throw new Error(`Concurrent write rejected for run '${runId}'. Another operation is in progress.`);
  }
  locks.set(runId, true);
}

function releaseLock(runId: string): void {
  locks.delete(runId);
}

/** Execute a function with an in-memory lock on runId. */
export function withLock<T>(runId: string, fn: () => T): T {
  acquireLock(runId);
  try {
    return fn();
  } finally {
    releaseLock(runId);
  }
}

// ─── Safe JSON parse (HIGH 2) ───

function safeParseJson<T>(content: string, filePath: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    throw new Error(`Corrupted JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function safeWriteFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content);
  } catch (err) {
    throw new Error(`Failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function safeAppendFile(filePath: string, content: string): void {
  try {
    fs.appendFileSync(filePath, content);
  } catch (err) {
    throw new Error(`Failed to append to ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Core functions ───

function defaultRunsDir(): string {
  return path.join(os.homedir(), ".openclaw", "harness-enforcer", "runs");
}

export function getRunsDir(configDir?: string): string {
  return configDir ?? defaultRunsDir();
}

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export function getRunDir(runsDir: string, runId: string): string {
  return path.join(runsDir, runId);
}

export function writeRunState(runsDir: string, runId: string, state: RunState): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeWriteFile(path.join(dir, "run-state.json"), JSON.stringify(state, null, 2));
}

export function readRunState(runsDir: string, runId: string): RunState | null {
  const p = path.join(getRunDir(runsDir, runId), "run-state.json");
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf-8");
  return safeParseJson<RunState>(content, p);
}

export function writeDodItems(runsDir: string, runId: string, items: DodItem[]): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeWriteFile(path.join(dir, "dod-items.json"), JSON.stringify(items, null, 2));
}

export function readDodItems(runsDir: string, runId: string): DodItem[] {
  const p = path.join(getRunDir(runsDir, runId), "dod-items.json");
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf-8");
  return safeParseJson<DodItem[]>(content, p);
}

// ─── Features (structured JSON, Anthropic pattern) ───

export function writeFeatures(runsDir: string, runId: string, features: Feature[]): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeWriteFile(path.join(dir, "features.json"), JSON.stringify(features, null, 2));
}

export function readFeatures(runsDir: string, runId: string): Feature[] {
  const p = path.join(getRunDir(runsDir, runId), "features.json");
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf-8");
  return safeParseJson<Feature[]>(content, p);
}

// ─── Contract Document ───

export function writeContract(runsDir: string, runId: string, items: ContractItem[]): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeWriteFile(path.join(dir, "contract.json"), JSON.stringify(items, null, 2));
}

export function readContract(runsDir: string, runId: string): ContractItem[] {
  const p = path.join(getRunDir(runsDir, runId), "contract.json");
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf-8");
  return safeParseJson<ContractItem[]>(content, p);
}

/** Get the next actionable contract item (respects dependencies). */
export function getNextContractItem(items: ContractItem[]): ContractItem | null {
  for (const item of items) {
    if (item.status !== "pending" && item.status !== "failed") continue;
    if (item.status === "failed" && item.attempts >= item.maxAttempts) continue;
    // Check dependencies are satisfied
    if (item.dependsOn && item.dependsOn.length > 0) {
      const depsOk = item.dependsOn.every(depId => {
        const dep = items.find(i => i.id === depId);
        return dep && dep.status === "passed";
      });
      if (!depsOk) continue;
    }
    return item;
  }
  return null;
}

/** Update a single contract item by ID. */
export function updateContractItem(
  runsDir: string,
  runId: string,
  itemId: string,
  update: Partial<Omit<ContractItem, "id">>,
): ContractItem | null {
  const items = readContract(runsDir, runId);
  const item = items.find(i => i.id === itemId);
  if (!item) return null;
  Object.assign(item, update);
  writeContract(runsDir, runId, items);
  return item;
}

/** Generate a contract.md document from contract items (human-readable). */
export function renderContractMarkdown(items: ContractItem[], taskDescription: string): string {
  const lines: string[] = [
    `# Contract Document`,
    ``,
    `**Task:** ${taskDescription}`,
    `**Generated:** ${new Date().toISOString()}`,
    `**Total items:** ${items.length}`,
    ``,
    `| # | Status | Description | Attempts | Evidence |`,
    `|---|--------|-------------|----------|----------|`,
  ];
  for (const item of items) {
    const statusIcon = item.status === "passed" ? "✅"
      : item.status === "failed" ? "❌"
      : item.status === "in_progress" ? "⏳"
      : item.status === "skipped" ? "⏭️"
      : "⬜";
    const evidence = item.evidence ? item.evidence.slice(0, 50) + "..." : "—";
    lines.push(`| ${item.id} | ${statusIcon} ${item.status} | ${item.description.slice(0, 60)} | ${item.attempts}/${item.maxAttempts} | ${evidence} |`);
  }
  lines.push(``);

  // Details for each item
  for (const item of items) {
    lines.push(`## ${item.id}: ${item.description}`);
    lines.push(``);
    if (item.acceptanceCriteria.length > 0) {
      lines.push(`**Acceptance Criteria:**`);
      for (const ac of item.acceptanceCriteria) {
        lines.push(`- ${ac}`);
      }
    }
    if (item.verifyCommand) {
      lines.push(`**Verify:** \`${item.verifyCommand}\``);
    }
    if (item.verifyFileExists && item.verifyFileExists.length > 0) {
      lines.push(`**Required files:** ${item.verifyFileExists.join(", ")}`);
    }
    if (item.evidence) {
      lines.push(`**Evidence:** ${item.evidence.slice(0, 200)}`);
    }
    if (item.failureLog) {
      lines.push(`**Last failure:** ${item.failureLog.slice(0, 200)}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Update feature statuses based on completed/pending feature names.
 * Only changes status field — never adds/removes features (immutable list).
 */
export function syncFeaturesFromCheckpoint(
  runsDir: string,
  runId: string,
  completedFeatures: string[],
  pendingFeatures: string[],
  inProgressFeature?: string,
): void {
  const features = readFeatures(runsDir, runId);
  if (features.length === 0) return;

  const completedSet = new Set(completedFeatures.map(f => f.toLowerCase()));
  const inProgressLower = inProgressFeature?.toLowerCase();

  for (const feature of features) {
    const descLower = feature.description.toLowerCase();

    if (completedSet.has(descLower) || completedFeatures.some(c => descLower.includes(c.toLowerCase().slice(0, 30)))) {
      if (feature.status !== "passed") {
        feature.status = "passed";
        if (!feature.verifiedAt) feature.verifiedAt = new Date().toISOString();
      }
    } else if (inProgressLower && descLower.includes(inProgressLower.slice(0, 30))) {
      feature.status = "in_progress";
    } else if (feature.status === "passed") {
      // Don't revert passed features
    } else if (feature.status !== "deferred") {
      feature.status = "pending";
    }
  }

  writeFeatures(runsDir, runId, features);
}

// ─── Progress File (cross-session memory) ───

export function writeProgressFile(
  runsDir: string,
  runId: string,
  runState: RunState,
  checkpoint: Checkpoint,
  features: Feature[],
): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);

  const passed = features.filter(f => f.status === "passed").length;
  const failed = features.filter(f => f.status === "failed").length;
  const inProgress = features.filter(f => f.status === "in_progress").length;
  const pending = features.filter(f => f.status === "pending").length;
  const deferred = features.filter(f => f.status === "deferred").length;

  const lines: string[] = [
    `# Progress — ${runState.taskDescription}`,
    ``,
    `**Run ID:** ${runState.runId}`,
    `**Phase:** ${runState.phase}`,
    `**Started:** ${runState.startedAt}`,
    `**Last checkpoint:** ${checkpoint.timestamp}`,
    `**Checkpoints:** ${runState.checkpoints.length}`,
    ``,
    `## Feature Status`,
    `- ✅ Passed: ${passed}`,
    `- ❌ Failed: ${failed}`,
    `- ⏳ In Progress: ${inProgress}`,
    `- ⬜ Pending: ${pending}`,
    ...(deferred > 0 ? [`- ⏭️ Deferred: ${deferred}`] : []),
    `- **Total: ${features.length}**`,
    ``,
    `## Completed`,
    ...checkpoint.completedFeatures.map(f => `- ✅ ${f}`),
    ``,
    `## In Progress / Next`,
    ...checkpoint.pendingFeatures.slice(0, 5).map(f => `- ⬜ ${f}`),
    ``,
  ];

  if (checkpoint.blockers.length > 0) {
    lines.push(`## Blockers`);
    lines.push(...checkpoint.blockers.map(b => `- 🚫 ${b}`));
    lines.push(``);
  }

  lines.push(`## Summary`);
  lines.push(checkpoint.summary);
  lines.push(``);

  // Context snapshot for cross-session recovery
  if (checkpoint.contextSnapshot) {
    const cs = checkpoint.contextSnapshot;
    lines.push(`## Context Snapshot`);
    if (cs.currentApproach) {
      lines.push(`**Approach:** ${cs.currentApproach}`);
    }
    if (cs.keyDecisions && cs.keyDecisions.length > 0) {
      lines.push(`**Key Decisions:**`);
      lines.push(...cs.keyDecisions.map(d => `- ${d}`));
    }
    if (cs.filesModified && cs.filesModified.length > 0) {
      lines.push(`**Files Modified:**`);
      lines.push(...cs.filesModified.map(f => `- \`${f}\``));
    }
    if (cs.nextSteps && cs.nextSteps.length > 0) {
      lines.push(`**Next Steps:**`);
      lines.push(...cs.nextSteps.map(s => `- ${s}`));
    }
    lines.push(``);
  }

  safeWriteFile(path.join(dir, "progress.md"), lines.join("\n"));
}

export function readProgressFile(runsDir: string, runId: string): string | null {
  const p = path.join(getRunDir(runsDir, runId), "progress.md");
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export function appendCheckpoint(runsDir: string, runId: string, checkpoint: Checkpoint): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeAppendFile(path.join(dir, "checkpoints.jsonl"), JSON.stringify(checkpoint) + "\n");
}

export function readCheckpoints(runsDir: string, runId: string): Checkpoint[] {
  const p = path.join(getRunDir(runsDir, runId), "checkpoints.jsonl");
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const results: Checkpoint[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as Checkpoint);
    } catch {
      // Skip corrupted checkpoint lines but don't crash
      continue;
    }
  }
  return results;
}

export function writeDelivery(runsDir: string, runId: string, delivery: Delivery): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeWriteFile(path.join(dir, "delivery.json"), JSON.stringify(delivery, null, 2));
}

function readDelivery(runsDir: string, runId: string): Delivery | null {
  const dp = path.join(getRunDir(runsDir, runId), "delivery.json");
  if (!fs.existsSync(dp)) return null;
  const content = fs.readFileSync(dp, "utf-8");
  return safeParseJson<Delivery>(content, dp);
}

/** Find the active run, or null if none. Returns first active run (any session). */
export function findActiveRun(runsDir: string): { runId: string; state: RunState } | null {
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();
  for (const d of dirs) {
    try {
      const state = readRunState(runsDir, d);
      if (state && state.status === "active") return { runId: d, state };
    } catch {
      // Skip corrupted run directories
      continue;
    }
  }
  return null;
}

/**
 * Find the active run for a specific session, or fall back to any unscoped active run.
 * This enables concurrent runs across different sessions.
 */
export function findActiveRunForSession(
  runsDir: string,
  sessionKey: string | undefined,
): { runId: string; state: RunState } | null {
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();

  // First pass: find an active run scoped to this session
  if (sessionKey) {
    for (const d of dirs) {
      try {
        const state = readRunState(runsDir, d);
        if (state && state.status === "active" && state.sessionKey === sessionKey) {
          return { runId: d, state };
        }
      } catch {
        continue;
      }
    }
  }

  // Second pass: find an active run with no session scope (legacy/unscoped)
  for (const d of dirs) {
    try {
      const state = readRunState(runsDir, d);
      if (state && state.status === "active" && !state.sessionKey) {
        return { runId: d, state };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** Get all active runs (for timer updates across sessions). */
export function findAllActiveRuns(runsDir: string): Array<{ runId: string; state: RunState }> {
  if (!fs.existsSync(runsDir)) return [];
  const dirs = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();
  const results: Array<{ runId: string; state: RunState }> = [];
  for (const d of dirs) {
    try {
      const state = readRunState(runsDir, d);
      if (state && state.status === "active") results.push({ runId: d, state });
    } catch {
      continue;
    }
  }
  return results;
}

/** Get the most recent run (any status). Optionally scoped to a session. */
export function findMostRecentRun(runsDir: string, sessionKey?: string): { runId: string; state: RunState } | null {
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();

  // First pass: find most recent run for this session
  if (sessionKey) {
    for (const d of dirs) {
      try {
        const state = readRunState(runsDir, d);
        if (state && state.sessionKey === sessionKey) return { runId: d, state };
      } catch {
        continue;
      }
    }
  }

  // Second pass: find any unscoped run (legacy)
  for (const d of dirs) {
    try {
      const state = readRunState(runsDir, d);
      if (state && !state.sessionKey) return { runId: d, state };
    } catch {
      continue;
    }
  }

  // Last resort: return the most recent regardless (for explicit runId lookups in status)
  if (!sessionKey) {
    for (const d of dirs) {
      try {
        const state = readRunState(runsDir, d);
        if (state) return { runId: d, state };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/** List completed runs, most recent first. */
export function listCompletedRuns(runsDir: string, limit: number = 5, sessionKey?: string): Array<{ runId: string; state: RunState; delivery: Delivery | null }> {
  if (!fs.existsSync(runsDir)) return [];
  const dirs = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();
  const results: Array<{ runId: string; state: RunState; delivery: Delivery | null }> = [];
  for (const d of dirs) {
    if (results.length >= limit) break;
    try {
      const state = readRunState(runsDir, d);
      if (state && state.status === "completed") {
        // Session scoping: only show runs from this session (or unscoped legacy runs)
        if (sessionKey && state.sessionKey && state.sessionKey !== sessionKey) continue;
        const delivery = readDelivery(runsDir, d);
        results.push({ runId: d, state, delivery });
      }
    } catch {
      continue;
    }
  }
  return results;
}

/** List all runs with basic info, most recent first. */
export function listAllRuns(runsDir: string): Array<{ runId: string; taskDescription: string; status: string; phase: string }> {
  if (!fs.existsSync(runsDir)) return [];
  const dirs = fs
    .readdirSync(runsDir)
    .filter((d) => {
      try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
    })
    .sort()
    .reverse();
  const results: Array<{ runId: string; taskDescription: string; status: string; phase: string }> = [];
  for (const d of dirs) {
    try {
      const s = readRunState(runsDir, d);
      if (s) {
        results.push({
          runId: d,
          taskDescription: s.taskDescription,
          status: s.status,
          phase: s.phase,
        });
      }
    } catch {
      continue;
    }
  }
  return results;
}

// ─── Manifest helpers ───

export function getManifestsDir(runsDir: string): string {
  return path.join(runsDir, "..", "manifests");
}

export function writeManifest(runsDir: string, manifest: Manifest): void {
  const dir = getManifestsDir(runsDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${manifest.manifestId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

export function readManifest(runsDir: string, manifestId: string): Manifest | null {
  const filePath = path.join(getManifestsDir(runsDir), `${manifestId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function findManifestByRunId(runsDir: string, runId: string): Manifest | null {
  const dir = getManifestsDir(runsDir);
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m: Manifest = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (m.plans.some(p => p.runId === runId)) return m;
    } catch { continue; }
  }
  return null;
}

export function findActiveManifest(runsDir: string): Manifest | null {
  const dir = getManifestsDir(runsDir);
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m: Manifest = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (m.status === "active") return m;
    } catch { continue; }
  }
  return null;
}

export function getNextPendingPlan(manifest: Manifest): ManifestPlan | null {
  for (const plan of manifest.plans) {
    if (plan.status !== "pending") continue;
    const depsOk = plan.dependsOn.every(dep => {
      const depPlan = manifest.plans.find(p => p.phase === dep);
      return depPlan && depPlan.status === "completed";
    });
    if (depsOk) return plan;
  }
  return null;
}

export function getParallelReadyPlans(manifest: Manifest): ManifestPlan[] {
  const ready: ManifestPlan[] = [];
  for (const plan of manifest.plans) {
    if (plan.status !== "pending") continue;
    const depsOk = plan.dependsOn.every(dep => {
      const depPlan = manifest.plans.find(p => p.phase === dep);
      return depPlan && depPlan.status === "completed";
    });
    if (depsOk) ready.push(plan);
  }
  return ready;
}

// ─── Learning Log ───

export function appendLearning(runsDir: string, runId: string, entry: LearningEntry): void {
  const dir = getRunDir(runsDir, runId);
  ensureDir(dir);
  safeAppendFile(path.join(dir, "learning.jsonl"), JSON.stringify(entry) + "\n");
}

export function readLearningLog(runsDir: string, runId: string): LearningEntry[] {
  const p = path.join(getRunDir(runsDir, runId), "learning.jsonl");
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf-8");
  const lines = content.split("\n").filter(l => l.trim().length > 0);
  const results: LearningEntry[] = [];
  for (const line of lines) {
    try { results.push(JSON.parse(line)); } catch { continue; }
  }
  return results;
}

/** Read learning from ALL past runs for cross-run knowledge. */
export function readGlobalLearning(runsDir: string): LearningEntry[] {
  if (!fs.existsSync(runsDir)) return [];
  const entries: LearningEntry[] = [];
  const dirs = fs.readdirSync(runsDir).filter(d => {
    try { return fs.statSync(path.join(runsDir, d)).isDirectory(); } catch { return false; }
  });
  for (const d of dirs) {
    const logPath = path.join(runsDir, d, "learning.jsonl");
    if (!fs.existsSync(logPath)) continue;
    try {
      const content = fs.readFileSync(logPath, "utf-8");
      for (const line of content.split("\n").filter(l => l.trim())) {
        try { entries.push(JSON.parse(line)); } catch { continue; }
      }
    } catch { continue; }
  }
  return entries;
}

// ─── Dynamic Re-planning ───

/** Add a new contract item mid-run. */
export function addContractItem(runsDir: string, runId: string, item: ContractItem): void {
  const items = readContract(runsDir, runId);
  items.push(item);
  writeContract(runsDir, runId, items);
}

/** Skip a contract item with reason. */
export function skipContractItem(runsDir: string, runId: string, itemId: string, reason: string): ContractItem | null {
  return updateContractItem(runsDir, runId, itemId, {
    status: "skipped",
    skipReason: reason,
    completedAt: new Date().toISOString(),
  });
}

/** Split a contract item into sub-items. Original becomes "skipped" with reference to children. */
export function splitContractItem(
  runsDir: string,
  runId: string,
  itemId: string,
  subItems: Array<{ description: string; acceptanceCriteria?: string[]; verifyCommand?: string }>,
): ContractItem[] {
  const items = readContract(runsDir, runId);
  const parent = items.find(i => i.id === itemId);
  if (!parent) return [];

  const newItems: ContractItem[] = [];
  for (let i = 0; i < subItems.length; i++) {
    const sub = subItems[i];
    const newId = `${itemId}.${i + 1}`;
    const newItem: ContractItem = {
      id: newId,
      description: sub.description,
      acceptanceCriteria: sub.acceptanceCriteria ?? [`"${sub.description}" is implemented and working`],
      verifyCommand: sub.verifyCommand ?? parent.verifyCommand,
      status: "pending",
      attempts: 0,
      maxAttempts: parent.maxAttempts,
      dependsOn: i > 0 ? [`${itemId}.${i}`] : parent.dependsOn,
    };
    newItems.push(newItem);
  }

  // Mark parent as skipped
  parent.status = "skipped";
  parent.skipReason = `Split into ${newItems.length} sub-items: ${newItems.map(i => i.id).join(", ")}`;

  // Insert new items after the parent
  const parentIndex = items.indexOf(parent);
  items.splice(parentIndex + 1, 0, ...newItems);

  // Update dependencies: anything that depended on parent now depends on the last sub-item
  const lastSubId = newItems[newItems.length - 1].id;
  for (const item of items) {
    if (item.dependsOn?.includes(itemId) && item.id !== itemId) {
      item.dependsOn = item.dependsOn.map(d => d === itemId ? lastSubId : d);
    }
  }

  writeContract(runsDir, runId, items);
  return newItems;
}

/** Get contract items that can run in parallel (same parallelGroup, all deps satisfied). */
export function getParallelContractItems(items: ContractItem[]): ContractItem[] {
  const actionable = items.filter(item => {
    if (item.status !== "pending" && item.status !== "failed") return false;
    if (item.status === "failed" && item.attempts >= item.maxAttempts) return false;
    if (item.dependsOn && item.dependsOn.length > 0) {
      return item.dependsOn.every(depId => {
        const dep = items.find(i => i.id === depId);
        return dep && (dep.status === "passed" || dep.status === "skipped");
      });
    }
    return true;
  });

  // Group by parallelGroup
  if (actionable.length <= 1) return actionable;
  
  // Items with same parallelGroup can run together
  const grouped = actionable.filter(i => i.parallelGroup);
  if (grouped.length > 1) {
    const firstGroup = grouped[0].parallelGroup;
    return grouped.filter(i => i.parallelGroup === firstGroup);
  }
  
  // Items without explicit dependencies on each other can run in parallel
  const independent = actionable.filter(item => {
    return !actionable.some(other => 
      other.id !== item.id && item.dependsOn?.includes(other.id)
    );
  });
  
  return independent.length > 1 ? independent : [actionable[0]].filter(Boolean);
}
