import { supabase } from "../supabase";

export type DailySummaryRow = {
  id: string;
  user_id: string;
  summary_date: string;
  avg_neck_angle: number | null;
  avg_upper_back_angle: number | null;
  avg_left_shoulder_angle: number | null;
  avg_right_shoulder_angle: number | null;
  avg_action_level: number | null;
  avg_overall_score: number | null;
  total_alerts: number | null;
  total_sessions: number | null;
  total_wear_seconds: number | null;   // ← actual shirt wear time
  good_posture_percentage: number | null;
  posture_score: number | null;
  created_at?: string;
  updated_at?: string;
};

export const yyyyMmDd = (d: Date) => d.toISOString().slice(0, 10);

type SupabaseErrShape = {
  message?: string | null;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
};

function formatSupabaseError(e: SupabaseErrShape | null | undefined, fallback: string): string {
  if (!e) return fallback;
  const parts = [e.message, e.details, e.hint, e.code]
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean);
  const s = parts.join(" | ").trim();
  return s || fallback;
}

const startOfUtcDay = (dateStr: string) => new Date(`${dateStr}T00:00:00.000Z`);
const endOfUtcDayExclusive = (dateStr: string) => {
  const start = startOfUtcDay(dateStr);
  const end   = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
};

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pickNum(r: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = r[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function numsFromReadings(readings: Record<string, unknown>[], keys: string[]): number[] {
  return readings.map((r) => pickNum(r, keys)).filter((n): n is number => n !== null);
}

async function fetchReadingsForDate(userId: string, dateStr: string) {
  const start = startOfUtcDay(dateStr);
  const end   = endOfUtcDayExclusive(dateStr);

  const { data, error } = await supabase
    .from("posture_readings")
    .select("*")
    .eq("user_id", userId)
    .gte("recorded_at", start.toISOString())
    .lt("recorded_at",  end.toISOString());

  return { data: (data ?? []) as Record<string, unknown>[], error };
}

async function fetchWearSecondsForDate(userId: string, dateStr: string): Promise<number> {
  const start = startOfUtcDay(dateStr);
  const end   = endOfUtcDayExclusive(dateStr);

  // Sum duration_seconds from all sessions that started during this UTC day.
  // Only completed sessions have duration_seconds set (end_time is not null).
  const { data, error } = await supabase
    .from("posture_sessions")
    .select("duration_seconds")
    .eq("user_id", userId)
    .gte("start_time", start.toISOString())
    .lt("start_time",  end.toISOString())
    .not("duration_seconds", "is", null);

  if (error) {
    console.warn("[daily-summary] Could not fetch wear seconds:", error.message);
    return 0;
  }

  return (data ?? []).reduce(
    (sum, s: { duration_seconds: number | null }) => sum + (s.duration_seconds ?? 0),
    0,
  );
}

/**
 * Mean of `posture_sessions.posture_score` for completed sessions whose `start_time`
 * falls on this UTC calendar day (same window as `total_wear_seconds`).
 */
async function fetchAvgSessionPostureScoreForDate(
  userId: string,
  dateStr: string,
): Promise<number | null> {
  const start = startOfUtcDay(dateStr);
  const end   = endOfUtcDayExclusive(dateStr);

  const { data, error } = await supabase
    .from("posture_sessions")
    .select("posture_score")
    .eq("user_id", userId)
    .gte("start_time", start.toISOString())
    .lt("start_time", end.toISOString())
    .not("duration_seconds", "is", null);

  if (error) {
    console.warn("[daily-summary] Could not fetch session posture_score:", error.message);
    return null;
  }

  const scores = (data ?? [])
    .map((s: { posture_score: number | null }) => s.posture_score)
    .filter((n): n is number => n != null && Number.isFinite(Number(n)))
    .map((n) => Number(n));

  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

async function countAlertsForDate(userId: string, dateStr: string) {
  const start = startOfUtcDay(dateStr);
  const end   = endOfUtcDayExclusive(dateStr);
  const lo    = start.toISOString();
  const hi    = end.toISOString();

  const run = (column: "triggered_at" | "created_at") =>
    supabase
      .from("vibration_alerts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte(column, lo)
      .lt(column, hi);

  const primary = await run("triggered_at");
  if (!primary.error) return { count: primary.count ?? 0, error: null };

  const hint     = formatSupabaseError(primary.error, "");
  const fallback = await run("created_at");
  if (!fallback.error) {
    if (/triggered_at|does not exist|schema cache/i.test(hint)) {
      console.warn("[daily-summary] vibration_alerts: using created_at (triggered_at failed)", {
        message: hint.slice(0, 200),
      });
    }
    return { count: fallback.count ?? 0, error: null };
  }

  return { count: 0, error: fallback.error };
}

export type GenerateDailyResult =
  | { ok: true;  kind: "summary";     summary: DailySummaryRow; readingsCount: number }
  | { ok: true;  kind: "no_readings"; summary_date: string;     readingsCount: 0 }
  | { ok: false; message: string;     readingsCount?: number;   stage?: "readings" | "alerts" | "daily_summary_upsert" };

/**
 * Recomputes daily_summary for one user and one UTC calendar day.
 *
 * SCORE LOGIC
 * ───────────
 * good_posture_percentage:
 *   % of readings where action_level <= 2 (RULA levels 1 and 2 are both acceptable).
 *
 * posture_score:
 *   Primary display score (0–100), stored on `daily_summary`.
 *   Mean of `posture_sessions.posture_score` for completed sessions that **started**
 *   on this UTC day (same cohort as `total_wear_seconds`). If no session ended with
 *   a numeric `posture_score`, falls back to mean `overall_score` from readings, then
 *   to `good_posture_percentage`.
 *
 * total_wear_seconds:
 *   Sum of duration_seconds from all completed sessions for this day.
 *   Used by the frontend to display real good/bad posture time instead of
 *   a hardcoded 8-hour assumption.
 *
 *   good_minutes = (good_posture_percentage / 100) * (total_wear_seconds / 60)
 *   bad_minutes  = total_wear_minutes - good_minutes
 */
export async function generateDailySummaryForUser(
  userId: string,
  dateStr: string,
): Promise<GenerateDailyResult> {
  const { data: readings, error: rErr } = await fetchReadingsForDate(userId, dateStr);

  if (rErr) {
    const raw = formatSupabaseError(rErr, "posture_readings query failed");
    const msg = raw.includes("recorded_at")
      ? "posture_readings must include recorded_at (or update the backend column name)."
      : raw;
    return { ok: false, message: msg, stage: "readings" };
  }

  if (readings.length === 0) {
    return { ok: true, kind: "no_readings", summary_date: dateStr, readingsCount: 0 };
  }

  // ── Per-body-part angle averages (neck not monitored) ─────────────────────
  const backs          = numsFromReadings(readings, ["upper_back_angle"]);
  const leftShoulders  = numsFromReadings(readings, ["left_shoulder_angle"]);
  const rightShoulders = numsFromReadings(readings, ["right_shoulder_angle"]);

  // ── RULA averages ─────────────────────────────────────────────────────────
  const actionLevels  = numsFromReadings(readings, ["action_level"]);
  const overallScores = numsFromReadings(readings, ["overall_score"]);

  const avgActionLevel  = average(actionLevels);
  const avgOverallScore = average(overallScores);

  // ── good_posture_percentage ───────────────────────────────────────────────
  // RULA levels 1 AND 2 are both acceptable — only 3 and 4 are bad.
  const goodCount  = readings.filter((r) => {
    const al = pickNum(r, ["action_level"]);
    return al !== null && al <= 2;
  }).length;
  const totalCount = readings.length;
  const goodPct    = (goodCount / totalCount) * 100;

  // ── posture_score ─────────────────────────────────────────────────────────
  // Prefer mean session posture_score (client sends this on PATCH …/end); else readings.
  const avgSessionPosture = await fetchAvgSessionPostureScoreForDate(userId, dateStr);
  const postureScore =
    avgSessionPosture !== null
      ? avgSessionPosture
      : avgOverallScore !== null
        ? avgOverallScore
        : goodPct;

  // ── Session count ─────────────────────────────────────────────────────────
  const sessionIds = new Set(
    readings
      .map((r) => (r.session_id != null ? String(r.session_id) : ""))
      .filter(Boolean),
  );
  const total_sessions = sessionIds.size;

  // ── Actual wear time in seconds ───────────────────────────────────────────
  // Fetched from posture_sessions.duration_seconds for sessions that started
  // today. This gives realistic good/bad posture time on the frontend instead
  // of assuming a fixed 8-hour wear day.
  const total_wear_seconds = await fetchWearSecondsForDate(userId, dateStr);

  // ── Alert count ───────────────────────────────────────────────────────────
  const { count: totalAlertsRaw, error: aErr } = await countAlertsForDate(userId, dateStr);
  let total_alerts = totalAlertsRaw;
  if (aErr) {
    console.warn("[daily-summary] total_alerts defaulted to 0", {
      userId, date: dateStr,
      error: formatSupabaseError(aErr, "vibration_alerts count failed"),
    });
    total_alerts = 0;
  }

  // ── Upsert payload ────────────────────────────────────────────────────────
  const payload: Record<string, unknown> = {
    user_id:      userId,
    summary_date: dateStr,

    // Angle averages
    avg_neck_angle:           null,
    avg_upper_back_angle:     average(backs)          !== null ? round1(average(backs)!)          : null,
    avg_left_shoulder_angle:  average(leftShoulders)  !== null ? round1(average(leftShoulders)!)  : null,
    avg_right_shoulder_angle: average(rightShoulders) !== null ? round1(average(rightShoulders)!) : null,

    // RULA
    avg_action_level:  avgActionLevel  !== null ? round1(avgActionLevel)  : null,
    avg_overall_score: avgOverallScore !== null ? round1(avgOverallScore) : null,

    // Stats
    total_alerts,
    total_sessions,
    total_wear_seconds,       // real shirt wear time for this day

    // good_posture_percentage = % of readings with action_level <= 2
    good_posture_percentage: round1(goodPct),

    // posture_score = mean session posture_score (completed, started this UTC day); else readings
    posture_score: round1(postureScore),

    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("daily_summary")
    .upsert(payload, { onConflict: "user_id,summary_date" })
    .select("*")
    .single<DailySummaryRow>();

  if (error || !data) {
    const msg = formatSupabaseError(
      error,
      !data && !error
        ? "daily_summary upsert returned no row (.single() — check RLS or unique on user_id+summary_date)"
        : "daily_summary upsert failed",
    );
    return { ok: false, message: msg, readingsCount: readings.length, stage: "daily_summary_upsert" };
  }

  return { ok: true, kind: "summary", summary: data, readingsCount: readings.length };
}

/** All users: refresh today's UTC daily summary (for background job). */
export async function refreshAllUsersDailySummariesForToday(): Promise<void> {
  const today = yyyyMmDd(new Date());

  const { data: users, error } = await supabase.from("users").select("id");
  if (error) {
    console.error("[daily-summary] Failed to list users:", error.message);
    return;
  }

  let ok = 0, failed = 0;
  for (const row of users ?? []) {
    const userId = String((row as { id: string }).id);
    const result = await generateDailySummaryForUser(userId, today);

    if (result.ok) {
      ok += 1;
      if (result.kind === "summary") {
        const s = result.summary;
        const wearMin = Math.round((s.total_wear_seconds ?? 0) / 60);
        console.log("[daily-summary] user", userId, {
          date:               today,
          status:             "upserted",
          readingsCount:      result.readingsCount,
          posture_score:      s.posture_score,
          good_posture_pct:   s.good_posture_percentage,
          avg_overall_score:  s.avg_overall_score,
          avg_action_level:   s.avg_action_level,
          wear_minutes:       wearMin,
        });
      } else {
        console.log("[daily-summary] user", userId, {
          date: today, status: "no_readings", readingsCount: 0,
        });
      }
    } else {
      failed += 1;
      console.warn("[daily-summary] user", userId, {
        date: today, status: "error",
        stage: result.stage, readingsCount: result.readingsCount,
        message: result.message || "(empty — see stage / DB constraints / RLS)",
      });
    }
  }

  console.log(
    `[daily-summary] UTC ${today}: processed ${(users ?? []).length} users (${ok} ok, ${failed} errors)`,
  );
}

const FIVE_MIN_MS = 5 * 60 * 1000;

export function startDailySummaryAutoRefresh(): void {
  const ms = Number(process.env.DAILY_SUMMARY_REFRESH_MS || FIVE_MIN_MS);
  if (ms < 60_000) {
    console.warn("[daily-summary] DAILY_SUMMARY_REFRESH_MS is very low; minimum sensible value is 60000 (1 min).");
  }

  void refreshAllUsersDailySummariesForToday();
  setInterval(() => { void refreshAllUsersDailySummariesForToday(); }, ms);

  console.log(`[daily-summary] Auto-refresh every ${Math.round(ms / 1000)}s`);
}