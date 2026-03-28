// ─── Progress Bar Rendering for Telegram ───
//
// Generates a Unicode progress bar string suitable for Telegram messages.
// Respects the 4096-char Telegram message limit.

const PHASES = ["plan", "build", "challenge", "eval"] as const;
const BAR_WIDTH = 15;
const TELEGRAM_CHAR_LIMIT = 4096;

// Max feature name length before truncation (leaves room for status + counter)
const MAX_FEATURE_NAME = 40;

export interface ProgressBarParams {
  taskDescription: string;
  phase: string;
  completedFeatures: string[];
  pendingFeatures: string[];
  inProgressFeature?: string;
  blockers: string[];
  dodTotal: number;
  dodCompleted: number;
  elapsedSeconds: number;
  sprintCurrent?: number;  // e.g. 2 (1-indexed)
  sprintTotal?: number;    // e.g. 4
  workLog?: string[];      // Last N action lines shown at bottom
}

function formatDuration(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

function renderPhaseIndicator(currentPhase: string): string {
  const normalised = currentPhase.toLowerCase();
  const currentIdx = PHASES.indexOf(normalised as (typeof PHASES)[number]);

  return PHASES.map((p, i) => {
    if (currentIdx < 0) return `○${p}`;
    if (i < currentIdx) return `●${p}`;
    if (i === currentIdx) return `▶${p}`;
    return `○${p}`;
  }).join("→");
}

function renderBar(percentage: number): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "▰".repeat(filled) + "▱".repeat(empty);
}

function renderFeatureList(
  completedFeatures: string[],
  pendingFeatures: string[],
  inProgressFeature?: string,
): string {
  const lines: string[] = [];

  for (const f of completedFeatures) {
    lines.push(`✅ ${truncate(f, MAX_FEATURE_NAME)}`);
  }

  if (inProgressFeature) {
    lines.push(`⏳ ${truncate(inProgressFeature, MAX_FEATURE_NAME)}`);
  }

  for (const f of pendingFeatures) {
    // Don't duplicate inProgressFeature if it's also in pendingFeatures
    if (inProgressFeature && f === inProgressFeature) continue;
    lines.push(`⬜ ${truncate(f, MAX_FEATURE_NAME)}`);
  }

  return lines.join("\n");
}

function renderBlockers(blockers: string[]): string {
  if (blockers.length === 0) return "";
  const lines = blockers.map((b) => `  🚫 ${truncate(b, MAX_FEATURE_NAME)}`);
  return `\n⚠️ Blockers:\n${lines.join("\n")}`;
}

function renderWorkLog(workLog: string[] | undefined): string {
  if (!workLog || workLog.length === 0) return "";
  // Show last 5 entries max, truncate each
  const entries = workLog.slice(-5).map(l => `› ${truncate(l, 50)}`);
  return `\n📝 ${entries.join("\n📝 ")}`;
}

function renderSprintStatusLine(current: number, total: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= total; i++) {
    if (i < current) parts.push("✅");
    else if (i === current) parts.push("⏳");
    else parts.push("⬜");
  }
  return parts.join("");
}

function computeOverallPercentage(
  sprintCurrent: number,
  sprintTotal: number,
  currentSprintPercentage: number,
): number {
  const completedSprints = sprintCurrent - 1;
  const overall = (completedSprints * 100 + currentSprintPercentage) / sprintTotal;
  return Math.round(Math.max(0, Math.min(100, overall)));
}

export function renderProgressBar(params: ProgressBarParams): string {
  const {
    taskDescription,
    phase,
    completedFeatures,
    pendingFeatures,
    inProgressFeature,
    blockers,
    dodTotal,
    dodCompleted,
    elapsedSeconds,
    sprintCurrent,
    sprintTotal,
    workLog,
  } = params;

  const safeDodTotal = Math.max(dodTotal, 0);
  const safeDodCompleted = Math.max(0, Math.min(dodCompleted, safeDodTotal));
  const sprintPercentage = safeDodTotal === 0 ? 0 : Math.round((safeDodCompleted / safeDodTotal) * 100);

  const inSprintMode = sprintCurrent != null && sprintTotal != null && sprintTotal > 0;
  const displayPercentage = inSprintMode
    ? computeOverallPercentage(sprintCurrent!, sprintTotal!, sprintPercentage)
    : sprintPercentage;

  const bar = renderBar(displayPercentage);
  const phaseIndicator = renderPhaseIndicator(phase);
  const elapsed = formatDuration(elapsedSeconds);
  const featureList = renderFeatureList(completedFeatures, pendingFeatures, inProgressFeature);
  const blockerSection = renderBlockers(blockers);

  const parts: string[] = [];

  if (inSprintMode) {
    parts.push(`🔧 ${truncate(taskDescription, 80)}`);
    parts.push(`📦 Sprint ${sprintCurrent}/${sprintTotal}`);
    parts.push(`${phaseIndicator}`);
    parts.push(`${bar} ${displayPercentage}% ⏱${elapsed}`);
    parts.push(featureList);
    parts.push(`${renderSprintStatusLine(sprintCurrent!, sprintTotal!)}`);
    parts.push(`${safeDodCompleted}/${safeDodTotal} done | ${blockers.length} blockers`);
  } else {
    parts.push(`🔧 ${truncate(taskDescription, 80)}`);
    parts.push(`${phaseIndicator}`);
    parts.push(`${bar} ${displayPercentage}% ⏱${elapsed}`);
    parts.push(featureList);
    parts.push(`${safeDodCompleted}/${safeDodTotal} done | ${blockers.length} blockers`);
  }

  if (blockerSection) {
    parts.push(blockerSection);
  }

  const workLogSection = renderWorkLog(workLog);
  if (workLogSection) {
    parts.push(workLogSection);
  }

  let result = parts.join("\n");

  // Safety: truncate if over Telegram limit (should never happen in practice)
  if (result.length > TELEGRAM_CHAR_LIMIT) {
    result = result.slice(0, TELEGRAM_CHAR_LIMIT - 4) + "\n…";
  }

  return result;
}

export function renderFinalStatus(params: {
  taskDescription: string;
  status: "pass" | "fail" | "cancelled";
  evalGrade?: string;
  dodTotal: number;
  dodCompleted: number;
  elapsedSeconds: number;
  completedFeatures: string[];
  pendingFeatures: string[];
  blockers: string[];
  sprintCurrent?: number;
  sprintTotal?: number;
}): string {
  const {
    taskDescription,
    status,
    evalGrade,
    dodTotal,
    dodCompleted,
    elapsedSeconds,
    completedFeatures,
    pendingFeatures,
    blockers,
    sprintCurrent,
    sprintTotal,
  } = params;

  const safeDodTotal = Math.max(dodTotal, 0);
  const safeDodCompleted = Math.max(0, Math.min(dodCompleted, safeDodTotal));
  const percentage = safeDodTotal === 0 ? 0 : Math.round((safeDodCompleted / safeDodTotal) * 100);
  const elapsed = formatDuration(elapsedSeconds);
  const bar = renderBar(percentage);

  let statusLine: string;
  switch (status) {
    case "pass":
      statusLine = `✅ DELIVERED — Grade: ${evalGrade ?? "PASS"}`;
      break;
    case "fail":
      statusLine = `❌ FAILED — Grade: ${evalGrade ?? "FAIL"}`;
      break;
    case "cancelled":
      statusLine = "🚫 CANCELLED";
      break;
  }

  const featureList = renderFeatureList(completedFeatures, pendingFeatures);
  const blockerSection = renderBlockers(blockers);

  const inSprintMode = sprintCurrent != null && sprintTotal != null && sprintTotal > 0;
  const sprintLine = inSprintMode ? `📦 Sprints: ${sprintCurrent}/${sprintTotal} completed` : "";

  const parts = [
    `🔧 Harness: ${truncate(taskDescription, 80)}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    statusLine,
    `${bar} ${percentage}% ⏱${elapsed}`,
  ];

  if (inSprintMode) {
    parts.push(sprintLine);
  }

  parts.push("");
  parts.push("Features:");
  parts.push(featureList);
  parts.push("");
  parts.push(`DoD: ${safeDodCompleted}/${safeDodTotal} ✅  |  Blockers: ${blockers.length}`);

  if (blockerSection) {
    parts.push(blockerSection);
  }

  let result = parts.join("\n");

  if (result.length > TELEGRAM_CHAR_LIMIT) {
    result = result.slice(0, TELEGRAM_CHAR_LIMIT - 4) + "\n…";
  }

  return result;
}
