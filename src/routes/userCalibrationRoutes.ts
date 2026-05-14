import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";
import { loadUserCalibration, type UserCalibrationRow } from "../utils/postureCalibration";

const router = Router();

function optBaseline(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function thresholdNum(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mergeRow(
  userId: string,
  body: Record<string, unknown>,
  existing: UserCalibrationRow | null,
): UserCalibrationRow {
  const e = existing;
  const pickB = (key: keyof UserCalibrationRow): number | null => {
    if (body[key] !== undefined) return optBaseline(body[key]) ?? null;
    return (e?.[key] as number | null) ?? null;
  };

  const defBackT = e?.back_threshold ?? 20;
  const defShoulderT = e?.shoulder_threshold ?? 10;

  return {
    user_id: userId,
    back_baseline_pitch: pickB("back_baseline_pitch"),
    left_shoulder_baseline: pickB("left_shoulder_baseline"),
    right_shoulder_baseline: pickB("right_shoulder_baseline"),
    back_threshold: thresholdNum(body.back_threshold, defBackT),
    shoulder_threshold: thresholdNum(body.shoulder_threshold, defShoulderT),
    updated_at: new Date().toISOString(),
  };
}

function publicRow(row: UserCalibrationRow): Omit<UserCalibrationRow, "user_id"> {
  const { user_id: _, ...rest } = row;
  return rest;
}

/** Raw per-tick data from the ~5s capture (optional; not stored in DB, logs only). */
function takeBaselineSamples(body: Record<string, unknown>): unknown[] | null {
  const direct = body.baseline_samples;
  if (Array.isArray(direct)) return direct;
  const wrap = body.baseline_capture;
  if (wrap && typeof wrap === "object" && !Array.isArray(wrap)) {
    const s = (wrap as Record<string, unknown>).samples;
    if (Array.isArray(s)) return s;
  }
  return null;
}

function logFiveSecondBaselineCapture(userId: string, body: Record<string, unknown>) {
  const samples = takeBaselineSamples(body);
  if (!samples || samples.length === 0) return;

  const MAX_FULL = 80;
  const HEAD = 30;
  const TAIL = 30;
  const samplesPreview =
    samples.length <= MAX_FULL
      ? samples
      : {
          head: samples.slice(0, HEAD),
          omittedMiddle: samples.length - HEAD - TAIL,
          tail: samples.slice(-TAIL),
        };

  const meta: Record<string, unknown> = { sampleCount: samples.length };
  const wrap = body.baseline_capture;
  if (wrap && typeof wrap === "object" && !Array.isArray(wrap)) {
    const o = wrap as Record<string, unknown>;
    if (o.started_at !== undefined) meta.started_at = o.started_at;
    if (o.ended_at !== undefined) meta.ended_at = o.ended_at;
  }
  if (body.baseline_capture_started_at !== undefined)
    meta.started_at = body.baseline_capture_started_at;
  if (body.baseline_capture_ended_at !== undefined)
    meta.ended_at = body.baseline_capture_ended_at;

  console.log("[baseline] 5s capture (incoming, not saved to DB)", {
    userId,
    ...meta,
    samples: samplesPreview,
  });
}

/**
 * GET /user/calibration
 * Returns stored baselines + thresholds for the authenticated user (or null).
 */
router.get("/user/calibration", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const row = await loadUserCalibration(supabase, userId);
    return res.json({
      success: true,
      calibration: row ? publicRow(row) : null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * PUT /user/calibration
 * Upsert baselines + thresholds (e.g. after client averages samples). Persists immediately.
 * Mirrors thresholds into `user_thresholds` (upper_back + shoulder only) when possible.
 *
 * Optional logging-only fields (stripped before DB — send from app to see full 5s window in server logs):
 *   - `baseline_samples`: array of per-tick readings (e.g. `{ t_ms, pitch, left_shoulder, ... }`)
 *   - or `baseline_capture`: `{ samples: [...], started_at?, ended_at? }`
 *   - or top-level `baseline_capture_started_at` / `baseline_capture_ended_at` (ISO strings)
 */
router.put("/user/calibration", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    logFiveSecondBaselineCapture(userId, body);

    const existing = await loadUserCalibration(supabase, userId);
    const merged = mergeRow(userId, body, existing);

    const { data, error } = await supabase
      .from("user_calibration")
      .upsert(merged, { onConflict: "user_id" })
      .select("*")
      .single<UserCalibrationRow>();

    if (error || !data) {
      return res.status(400).json({
        success: false,
        message:
          error?.message ??
          "Could not save user_calibration (run the user_calibration migration in Supabase).",
      });
    }

    const sampleCount = takeBaselineSamples(body)?.length ?? 0;

    const { error: thErr } = await supabase
      .from("user_thresholds")
      .update({
        upper_back_threshold: data.back_threshold,
        shoulder_threshold: data.shoulder_threshold,
        updated_at: data.updated_at,
      })
      .eq("user_id", userId);

    if (thErr) {
      console.warn("[user/calibration] user_thresholds sync failed:", thErr.message);
    }

    console.log("[baseline] user_calibration saved to DB", {
      userId,
      requestBodyKeys: Object.keys(body),
      fiveSecondSampleCount: sampleCount,
      persisted: publicRow(data),
      thresholdsSynced: !thErr,
    });

    return res.json({
      success: true,
      calibration: publicRow(data),
      thresholdsSynced: !thErr,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * DELETE /user/calibration
 * Removes per-user calibration row immediately.
 */
router.delete("/user/calibration", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const { error } = await supabase.from("user_calibration").delete().eq("user_id", userId);

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    console.log("[baseline] user_calibration cleared from DB", { userId });

    return res.json({
      success: true,
      cleared: true,
      clearLocalCalibrationCache: true,
      message:
        "Server user calibration removed. Clear local calibration cache on the client if applicable.",
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;
