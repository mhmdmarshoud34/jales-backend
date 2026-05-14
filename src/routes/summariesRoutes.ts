import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";
import {
  generateDailySummaryForUser,
  yyyyMmDd,
  type DailySummaryRow,
} from "../services/dailySummaryService";

type WeeklySummaryRow = {
  id: string;
  user_id: string;
  week_start: string;
  week_end: string;
  avg_posture_score: number | null;
  avg_action_level: number | null;
  avg_overall_score: number | null;
  total_alerts: number | null;
  total_sessions: number | null;
  total_wear_seconds: number | null;   // ← total wear time this week
  best_day?: string | null;
  worst_day?: string | null;
  improvement_percentage?: number | null;
  created_at?: string;
  updated_at?: string;
};

type MonthlySummaryRow = {
  id: string;
  user_id: string;
  year: number;
  month: number;
  avg_posture_score: number | null;
  avg_action_level: number | null;
  avg_overall_score: number | null;
  total_alerts: number | null;
  total_sessions: number | null;
  total_wear_seconds: number | null;   // ← total wear time this month
  improvement_vs_last_month?: number | null;
  created_at?: string;
  updated_at?: string;
};

const router = Router();

const startOfUtcDay = (dateStr: string) => new Date(`${dateStr}T00:00:00.000Z`);

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function startOfWeekUtc(date: Date): Date {
  const d   = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day + 6) % 7);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /summaries/daily/generate
 * Optional query: ?date=YYYY-MM-DD (UTC calendar day). Omit for today.
 * Use to backfill a past day so GET /summaries/daily?date=… returns a row.
 */
router.post("/summaries/daily/generate", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const raw = req.query?.date != null ? String(req.query.date).trim() : "";
    let targetDate: string;
    if (raw) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return res.status(400).json({ success: false, message: "date must be YYYY-MM-DD (UTC)" });
      if (!Number.isFinite(startOfUtcDay(raw).getTime()))
        return res.status(400).json({ success: false, message: "invalid calendar date" });
      targetDate = raw;
    } else {
      targetDate = yyyyMmDd(new Date());
    }

    const result = await generateDailySummaryForUser(userId, targetDate);

    if (!result.ok)
      return res.status(400).json({ success: false, message: result.message });

    if (result.kind === "no_readings")
      return res.status(200).json({
        success: true,
        message: "No readings for this day",
        summary_date: result.summary_date,
      });

    return res.json({ success: true, summary: result.summary });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

router.get("/summaries/daily", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const date  = req.query?.date ? String(req.query.date) : yyyyMmDd(new Date());
    const start = startOfUtcDay(date);
    if (!Number.isFinite(start.getTime()))
      return res.status(400).json({ success: false, message: "date must be YYYY-MM-DD" });

    const { data, error } = await supabase
      .from("daily_summary")
      .select("*")
      .eq("user_id", userId)
      .eq("summary_date", date)
      .single<DailySummaryRow>();

    if (error || !data)
      return res.status(404).json({ success: false, message: "Daily summary not found" });

    return res.json({ success: true, summary: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

router.get("/summaries/daily/range", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const start = req.query?.start ? String(req.query.start) : null;
    const end   = req.query?.end   ? String(req.query.end)   : null;
    if (!start || !end)
      return res.status(400).json({ success: false, message: "start and end are required (YYYY-MM-DD)" });

    if (
      !Number.isFinite(startOfUtcDay(start).getTime()) ||
      !Number.isFinite(startOfUtcDay(end).getTime())
    )
      return res.status(400).json({ success: false, message: "start/end must be YYYY-MM-DD" });

    const { data, error } = await supabase
      .from("daily_summary")
      .select("*")
      .eq("user_id", userId)
      .gte("summary_date", start)
      .lte("summary_date", end)
      .order("summary_date", { ascending: true });

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, summaries: data ?? [] });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY
// ─────────────────────────────────────────────────────────────────────────────

router.post("/summaries/weekly/generate", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const weekStartDate = startOfWeekUtc(new Date());
    const weekStart     = yyyyMmDd(weekStartDate);
    const weekEndDate   = new Date(weekStartDate);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 6);
    const weekEnd = yyyyMmDd(weekEndDate);

    // Select all fields needed for aggregation, including total_wear_seconds
    const { data: days, error } = await supabase
      .from("daily_summary")
      .select(
        "summary_date, posture_score, avg_action_level, avg_overall_score, " +
        "total_alerts, total_sessions, total_wear_seconds"
      )
      .eq("user_id", userId)
      .gte("summary_date", weekStart)
      .lte("summary_date", weekEnd)
      .order("summary_date", { ascending: true });

    if (error) return res.status(400).json({ success: false, message: error.message });

    // PostgREST + strict generics: `data` is not narrowed to row[]; assert via unknown.
    const rows = (days ?? []) as unknown as {
      summary_date: string;
      posture_score: number | null;
      avg_action_level: number | null;
      avg_overall_score: number | null;
      total_alerts: number | null;
      total_sessions: number | null;
      total_wear_seconds: number | null;
    }[];

    const scores        = rows.map(d => d.posture_score).filter((n): n is number => n !== null && Number.isFinite(n));
    const actionLevels  = rows.map(d => d.avg_action_level).filter((n): n is number => n !== null && Number.isFinite(n));
    const overallScores = rows.map(d => d.avg_overall_score).filter((n): n is number => n !== null && Number.isFinite(n));

    const avgScore           = average(scores);
    const avgActionLevel     = average(actionLevels);
    const avgOverallScore    = average(overallScores);
    const total_alerts       = rows.reduce((sum, d) => sum + (d.total_alerts    ?? 0), 0);
    const total_sessions     = rows.reduce((sum, d) => sum + (d.total_sessions  ?? 0), 0);
    const total_wear_seconds = rows.reduce((sum, d) => sum + (d.total_wear_seconds ?? 0), 0);

    // ── Best / worst day ──────────────────────────────────────────────────────
    let bestDay:  string | null = null;
    let worstDay: string | null = null;
    let bestScore  = -Infinity;
    let worstScore =  Infinity;

    for (const d of rows) {
      const s = d.posture_score;
      if (s === null || !Number.isFinite(s)) continue;
      if (s > bestScore)  { bestScore  = s; bestDay  = d.summary_date; }
      if (s < worstScore) { worstScore = s; worstDay = d.summary_date; }
    }

    // ── Previous week comparison ──────────────────────────────────────────────
    const prevStartDate = new Date(weekStartDate);
    prevStartDate.setUTCDate(prevStartDate.getUTCDate() - 7);
    const prevStart   = yyyyMmDd(prevStartDate);
    const prevEndDate = new Date(prevStartDate);
    prevEndDate.setUTCDate(prevEndDate.getUTCDate() + 6);
    const prevEnd = yyyyMmDd(prevEndDate);

    const { data: prevDays, error: prevErr } = await supabase
      .from("daily_summary")
      .select("posture_score")
      .eq("user_id", userId)
      .gte("summary_date", prevStart)
      .lte("summary_date", prevEnd);

    if (prevErr) return res.status(400).json({ success: false, message: prevErr.message });

    const prevScores = (prevDays ?? [])
      .map((d: any) => Number(d.posture_score))
      .filter((n: number) => Number.isFinite(n));
    const prevAvg   = average(prevScores);
    const improvement =
      avgScore !== null && prevAvg !== null && prevAvg !== 0
        ? ((avgScore - prevAvg) / prevAvg) * 100
        : null;

    const payload = {
      user_id:                userId,
      week_start:             weekStart,
      week_end:               weekEnd,
      avg_posture_score:      avgScore,
      avg_action_level:       avgActionLevel,
      avg_overall_score:      avgOverallScore,
      total_alerts,
      total_sessions,
      total_wear_seconds,
      best_day:               bestDay,
      worst_day:              worstDay,
      improvement_percentage: improvement,
      updated_at:             new Date().toISOString(),
    };

    const { data, error: upErr } = await supabase
      .from("weekly_summary")
      .upsert(payload, { onConflict: "user_id,week_start" })
      .select("*")
      .single<WeeklySummaryRow>();

    if (upErr || !data)
      return res.status(400).json({ success: false, message: upErr?.message ?? "Upsert failed" });

    return res.json({ success: true, summary: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

router.get("/summaries/weekly", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const weekStart = req.query?.week_start
      ? String(req.query.week_start)
      : yyyyMmDd(startOfWeekUtc(new Date()));

    if (!Number.isFinite(startOfUtcDay(weekStart).getTime()))
      return res.status(400).json({ success: false, message: "week_start must be YYYY-MM-DD" });

    const { data, error } = await supabase
      .from("weekly_summary")
      .select("*")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .single<WeeklySummaryRow>();

    if (error || !data)
      return res.status(404).json({ success: false, message: "Weekly summary not found" });

    return res.json({ success: true, summary: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MONTHLY
// ─────────────────────────────────────────────────────────────────────────────

router.post("/summaries/monthly/generate", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const now   = new Date();
    const year  = Number(req.query?.year  ?? now.getUTCFullYear());
    const month = Number(req.query?.month ?? now.getUTCMonth() + 1);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12)
      return res.status(400).json({ success: false, message: "month must be 1-12 and year must be a number" });

    const start = yyyyMmDd(new Date(Date.UTC(year, month - 1, 1)));
    const end   = yyyyMmDd(new Date(Date.UTC(year, month, 0)));

    // Read from daily_summary — more accurate than weekly rollup.
    // Include total_wear_seconds so monthly can report actual wear time.
    const { data: dailies, error } = await supabase
      .from("daily_summary")
      .select(
        "posture_score, avg_action_level, avg_overall_score, " +
        "total_alerts, total_sessions, total_wear_seconds"
      )
      .eq("user_id", userId)
      .gte("summary_date", start)
      .lte("summary_date", end);

    if (error) return res.status(400).json({ success: false, message: error.message });

    const rows = (dailies ?? []) as unknown as {
      posture_score: number | null;
      avg_action_level: number | null;
      avg_overall_score: number | null;
      total_alerts: number | null;
      total_sessions: number | null;
      total_wear_seconds: number | null;
    }[];

    const scores        = rows.map(d => d.posture_score).filter((n): n is number => n !== null && Number.isFinite(n));
    const actionLevels  = rows.map(d => d.avg_action_level).filter((n): n is number => n !== null && Number.isFinite(n));
    const overallScores = rows.map(d => d.avg_overall_score).filter((n): n is number => n !== null && Number.isFinite(n));

    const avgScore           = average(scores);
    const avgActionLevel     = average(actionLevels);
    const avgOverallScore    = average(overallScores);
    const total_alerts       = rows.reduce((sum, d) => sum + (d.total_alerts    ?? 0), 0);
    const total_sessions     = rows.reduce((sum, d) => sum + (d.total_sessions  ?? 0), 0);
    const total_wear_seconds = rows.reduce((sum, d) => sum + (d.total_wear_seconds ?? 0), 0);

    // ── Previous month comparison ─────────────────────────────────────────────
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;

    const { data: prevRow, error: prevErr } = await supabase
      .from("monthly_summary")
      .select("avg_posture_score")
      .eq("user_id", userId)
      .eq("year",  prevYear)
      .eq("month", prevMonth)
      .maybeSingle<{ avg_posture_score: number | null }>();

    if (prevErr) return res.status(400).json({ success: false, message: prevErr.message });

    const prevAvg = prevRow?.avg_posture_score != null ? Number(prevRow.avg_posture_score) : null;
    const improvement_vs_last_month =
      avgScore !== null && prevAvg !== null && Number.isFinite(prevAvg) && prevAvg !== 0
        ? ((avgScore - prevAvg) / prevAvg) * 100
        : null;

    const payload = {
      user_id:                  userId,
      year,
      month,
      avg_posture_score:        avgScore,
      avg_action_level:         avgActionLevel,
      avg_overall_score:        avgOverallScore,
      total_alerts,
      total_sessions,
      total_wear_seconds,
      improvement_vs_last_month,
      updated_at:               new Date().toISOString(),
    };

    const { data, error: upErr } = await supabase
      .from("monthly_summary")
      .upsert(payload, { onConflict: "user_id,month,year" })
      .select("*")
      .single<MonthlySummaryRow>();

    if (upErr || !data)
      return res.status(400).json({ success: false, message: upErr?.message ?? "Upsert failed" });

    return res.json({ success: true, summary: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

router.get("/summaries/monthly", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const now   = new Date();
    const year  = Number(req.query?.year  ?? now.getUTCFullYear());
    const month = Number(req.query?.month ?? now.getUTCMonth() + 1);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12)
      return res.status(400).json({ success: false, message: "month must be 1-12 and year must be a number" });

    const { data, error } = await supabase
      .from("monthly_summary")
      .select("*")
      .eq("user_id", userId)
      .eq("year",  year)
      .eq("month", month)
      .single<MonthlySummaryRow>();

    if (error || !data)
      return res.status(404).json({ success: false, message: "Monthly summary not found" });

    return res.json({ success: true, summary: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;