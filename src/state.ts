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

/** Get the most recent run (any status). */
export function findMostRecentRun(runsDir: string): { runId: string; state: RunState } | null {
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
      if (state) return { runId: d, state };
    } catch {
      continue;
    }
  }
  return null;
}

/** List completed runs, most recent first. */
export function listCompletedRuns(runsDir: string, limit: number = 5): Array<{ runId: string; state: RunState; delivery: Delivery | null }> {
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
