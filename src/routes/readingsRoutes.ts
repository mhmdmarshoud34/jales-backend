import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";
import {
  applyCalibrationChoice,
  applyPersonalDeviationThresholdBoost,
  computeShoulderAnglesFlat,
  extractBnoFlat,
  loadPostureCalibration,
  loadUserCalibration,
  shouldSkipImuTwistTiltForUserCal,
  type UserCalibrationRow,
} from "../utils/postureCalibration";

type ReadingInput = Record<string, unknown>;

type ReadingRow = {
  id: string;
  user_id: string;
  session_id: string;
  device_id: string;
  recorded_at?: string;
  [k: string]: unknown;
};

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNumberOrNull(v: unknown): number | null {
  return num(v);
}

async function ensureSessionOwned(userId: string, sessionId: string) {
  const { data, error } = await supabase
    .from("posture_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .single<{ id: string }>();
  return { ok: !error && !!data };
}

/**
 * STRICT ALLOWLIST — only recorded_at passes through from the raw payload.
 * Prevents any legacy / mock field from reaching PostgREST.
 */
function allowlistedPrimitives(obj: ReadingInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj.recorded_at !== undefined && obj.recorded_at !== null)
    out.recorded_at = obj.recorded_at;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// RULA SCORING
// ─────────────────────────────────────────────────────────────────────────────

/** Neck is not monitored; stored score stays neutral for legacy columns. */
const NECK_SCORE_NEUTRAL = 1;

function scoreTrunk(flexion: number, twist: boolean, tilt: boolean): number {
  let score = flexion === 0 ? 1 : flexion <= 20 ? 2 : flexion <= 60 ? 3 : 4;
  if (twist) score += 1;
  if (tilt)  score += 1;
  return score;
}

function scoreShoulder(angle: number): number {
  if (angle <= 20) return 1;
  if (angle <= 45) return 2;
  if (angle <= 90) return 3;
  return 4;
}

function getActionLevel(worst: number): number {
  if (worst <= 2) return 1;
  if (worst === 3) return 3;
  return 4;
}

/**
 * Overall score: trunk + shoulders only (neck not monitored).
 * score 1 = 100 (perfect), score 4 = 0 (critical).
 */
function computeOverallScore(trunk: number, leftShoulder: number, rightShoulder: number): number {
  const avgRula = (trunk + leftShoulder + rightShoulder) / 3;
  return Math.round(((4 - avgRula) / 3) * 100);
}

function computeRulaScores(flat: Record<string, unknown>, userCal: UserCalibrationRow | null): Record<string, unknown> {
  const pitch   = num(flat.bno_pitch)   ?? 0;
  const heading = num(flat.bno_heading) ?? 0;
  const roll    = num(flat.bno_roll)    ?? 0;

  const leftShoulderAngle  = num(flat.left_shoulder_angle)  ?? 0;
  const rightShoulderAngle = num(flat.right_shoulder_angle) ?? 0;

  const skipImuTwistTilt = shouldSkipImuTwistTiltForUserCal(userCal);
  const trunkTwist       = skipImuTwistTilt ? false : Math.abs(heading) > 10;
  const trunkTilt        = skipImuTwistTilt ? false : Math.abs(roll) > 10;

  const neckScore          = NECK_SCORE_NEUTRAL;
  let trunkScore           = scoreTrunk(pitch, trunkTwist, trunkTilt);
  let leftShoulderScore    = scoreShoulder(leftShoulderAngle);
  let rightShoulderScore   = scoreShoulder(rightShoulderAngle);

  const boosted = applyPersonalDeviationThresholdBoost(flat, userCal, {
    trunk: trunkScore,
    left: leftShoulderScore,
    right: rightShoulderScore,
  });
  trunkScore = boosted.trunk;
  leftShoulderScore = boosted.left;
  rightShoulderScore = boosted.right;

  const worst        = Math.max(trunkScore, leftShoulderScore, rightShoulderScore);
  const actionLevel  = getActionLevel(worst);
  const overallScore = computeOverallScore(trunkScore, leftShoulderScore, rightShoulderScore);

  return {
    neck_angle:           null,
    upper_back_angle:     pitch,
    neck_score:           neckScore,
    trunk_score:          trunkScore,
    left_shoulder_score:  leftShoulderScore,
    right_shoulder_score: rightShoulderScore,
    action_level:         actionLevel,
    overall_score:        overallScore,
    trunk_twist:          trunkTwist,
    trunk_tilt:           trunkTilt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

router.post("/readings", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const { session_id, device_id, readings } = req.body ?? {};

    if (!session_id || !device_id)
      return res.status(400).json({ success: false, message: "session_id and device_id are required" });

    if (!Array.isArray(readings))
      return res.status(400).json({ success: false, message: "readings must be an array" });

    if (readings.length === 0)
      return res.status(400).json({ success: false, message: "readings array must not be empty" });

    const sessionId = String(session_id);
    const deviceId  = String(device_id);

    const owned = await ensureSessionOwned(userId, sessionId);
    if (!owned.ok)
      return res.status(404).json({ success: false, message: "Session not found" });

    const userCal = await loadUserCalibration(supabase, userId);
    const deviceCal = userCal ? null : await loadPostureCalibration(supabase, userId, deviceId);

    // ── Build DB rows ─────────────────────────────────────────────────────────
    const rows = readings.map((r: ReadingInput) => {
      const raw         = r ?? {};
      const primitives  = allowlistedPrimitives(raw);
      const bnoFlat     = extractBnoFlat(raw);
      const shoulders   = computeShoulderAnglesFlat(raw);
      const flatRaw     = { ...bnoFlat, ...shoulders };
      const flatSensors = applyCalibrationChoice(flatRaw, userCal, deviceCal);
      const rulaScores  = computeRulaScores(flatSensors, userCal);

      return {
        ...primitives,
        ...flatSensors,
        ...rulaScores,
        user_id:    userId,
        session_id: sessionId,
        device_id:  deviceId,
      };
    });

    const scoreSlice = (r: Record<string, unknown>) => ({
      trunk: r.trunk_score,
      leftShoulder: r.left_shoulder_score,
      rightShoulder: r.right_shoulder_score,
      actionLevel: r.action_level,
      overallScore: r.overall_score,
    });
    if (rows.length <= 10) {
      console.log("[scores] POST /readings", {
        session_id: sessionId,
        count: rows.length,
        rows: rows.map(scoreSlice),
      });
    } else {
      const last = rows[rows.length - 1] as Record<string, unknown>;
      console.log("[scores] POST /readings", {
        session_id: sessionId,
        count: rows.length,
        first: scoreSlice(rows[0] as Record<string, unknown>),
        last: scoreSlice(last),
      });
    }

    // ── Bulk insert ───────────────────────────────────────────────────────────
    const { error: insertError } = await supabase
      .from("posture_readings")
      .insert(rows);

    if (insertError)
      return res.status(400).json({ success: false, message: insertError.message });

    // ── Auto-generate alerts for action_level >= 3 ────────────────────────────
    const alertsToInsert = rows
      .filter((r: any) => (r.action_level ?? 0) >= 3)
      .map((r: any) => {
        const scores = {
          upper_back:     r.trunk_score         ?? 0,
          left_shoulder:  r.left_shoulder_score ?? 0,
          right_shoulder: r.right_shoulder_score ?? 0,
        };
        const worstPart = (Object.entries(scores) as [string, number][])
          .sort(([, a], [, b]) => b - a)[0][0];

        return {
          user_id:              userId,
          device_id:            deviceId,
          session_id:           sessionId,
          neck_angle:           toNumberOrNull(r.neck_angle),
          upper_back_angle:     toNumberOrNull(r.upper_back_angle),
          left_shoulder_angle:  toNumberOrNull(r.left_shoulder_angle),
          right_shoulder_angle: toNumberOrNull(r.right_shoulder_angle),
          action_level:         r.action_level,
          worst_body_part:      worstPart,
          deviation_severity:   r.action_level >= 4 ? "severe" : "moderate",
          triggered_at:         r.recorded_at ?? new Date().toISOString(),
        };
      });

    let alertsCreated = 0;
    if (alertsToInsert.length > 0) {
      const { error: alertError } = await supabase
        .from("vibration_alerts")
        .insert(alertsToInsert);
      if (alertError)
        return res.status(400).json({ success: false, message: alertError.message });
      alertsCreated = alertsToInsert.length;
    }

    // ── Return last scored result for home screen persistence ─────────────────
    const lastRow    = rows[rows.length - 1] as Record<string, unknown>;
    const lastScored = {
      trunkScore:         lastRow.trunk_score,
      leftShoulderScore:  lastRow.left_shoulder_score,
      rightShoulderScore: lastRow.right_shoulder_score,
      actionLevel:        lastRow.action_level,
      overallScore:       lastRow.overall_score,
      sendAlert:          (lastRow.action_level as number) >= 3,
      triggerVibration:   (lastRow.action_level as number) >= 4,
      angles: {
        trunkFlexion:       lastRow.upper_back_angle,
        leftShoulderAngle:  lastRow.left_shoulder_angle,
        rightShoulderAngle: lastRow.right_shoulder_angle,
        trunkTwist:         lastRow.trunk_twist,
        trunkTilt:          lastRow.trunk_tilt,
      },
    };

    return res.json({
      success:        true,
      inserted:       rows.length,
      alerts_created: alertsCreated,
      lastScored,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

router.get("/readings/:sessionId", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const sessionId = String(req.params.sessionId);

    const owned = await ensureSessionOwned(userId, sessionId);
    if (!owned.ok)
      return res.status(404).json({ success: false, message: "Session not found" });

    const rawLimit  = req.query?.limit;
    const limit     = rawLimit === undefined ? 100 : Number(rawLimit);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(5000, Math.floor(limit)) : 100;

    const { data, error } = await supabase
      .from("posture_readings")
      .select("*")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .order("id", { ascending: true })
      .limit(safeLimit);

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, readings: (data ?? []) as ReadingRow[] });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;