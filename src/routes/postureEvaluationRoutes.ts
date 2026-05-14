import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";
import { VIBRATION_TIMING, type VibrationPattern } from "./thresholdsRoutes";
import {
  applyCalibrationChoice,
  applyPersonalDeviationThresholdBoost,
  loadPostureCalibration,
  loadUserCalibration,
  normalizeShoulderAngle,
  shouldSkipImuTwistTiltForUserCal,
  type UserCalibrationRow,
} from "../utils/postureCalibration";

type EvalRequestBody = {
  session_id: string;
  device_id: string;
  bno?: { heading?: number; roll?: number; pitch?: number };
  mpu1?: { Ax?: number; Ay?: number; Az?: number; Gx?: number; Gy?: number; Gz?: number };
  mpu2?: { Ax?: number; Ay?: number; Az?: number; Gx?: number; Gy?: number; Gz?: number };
  trunkTwist?: boolean;
  trunkTilt?: boolean;
  shoulderElevated?: boolean;
  shoulderAbducted?: boolean;
  recorded_at?: string;
};

type RulaScores = {
  trunkScore: number;
  leftShoulderScore: number;
  rightShoulderScore: number;
  shoulderScore: number;
  actionLevel: 1 | 2 | 3 | 4;
  overallScore: number;
};

type UserPrefs = {
  vibration_intensity: number | null;
  vibration_pattern: VibrationPattern | null;
  push_notifications_enabled: boolean | null;
};

const router = Router();

const PERSIST_SECONDS = Number(process.env.RULA_PERSIST_SECONDS || 3);

const stateByKey = new Map<
  string,
  { badSinceMs: number | null; lastAlertMs: number | null }
>();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string")
    return ["true", "1", "yes", "y"].includes(v.toLowerCase().trim());
  return false;
}

function toNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeShoulderAngle(Ay: number | null, Az: number | null): number {
  if (Ay === null || Az === null) return 0;
  const deg = (Math.atan2(Ay, Az) * 180) / Math.PI;
  return normalizeShoulderAngle(deg);
}

// ─────────────────────────────────────────────────────────────────────────────
// RULA SCORING
// ─────────────────────────────────────────────────────────────────────────────

/** Neck is not monitored; kept neutral for legacy DB columns. */
const NECK_SCORE_NEUTRAL = 1;

function scoreTrunk(flexion: number, twist: boolean, tilt: boolean): number {
  let score = flexion === 0 ? 1 : flexion <= 20 ? 2 : flexion <= 60 ? 3 : 4;
  if (twist) score += 1;
  if (tilt)  score += 1;
  return score;
}

function scoreShoulder(angle: number, elevated = false, abducted = false): number {
  let score = angle <= 20 ? 1 : angle <= 45 ? 2 : angle <= 90 ? 3 : 4;
  if (elevated) score += 1;
  if (abducted) score += 1;
  return score;
}

function getActionLevel(trunk: number, shoulder: number): 1 | 2 | 3 | 4 {
  const worst = Math.max(trunk, shoulder);
  if (worst <= 2) return 1;
  if (worst === 3) return 3;
  return 4;
}

function computeOverallScore(
  trunk: number, leftShoulder: number, rightShoulder: number,
): number {
  const avgRula = (trunk + leftShoulder + rightShoulder) / 3;
  return Math.round(((4 - avgRula) / 3) * 100);
}

function computeRulaScores(
  input: {
    trunkFlexion: number;
    trunkTwist: boolean; trunkTilt: boolean;
    leftShoulderAngle: number; rightShoulderAngle: number;
    shoulderElevated: boolean; shoulderAbducted: boolean;
  },
  flatForBoost: Record<string, unknown>,
  userCal: UserCalibrationRow | null,
): RulaScores {
  let trunkScore         = scoreTrunk(input.trunkFlexion, input.trunkTwist, input.trunkTilt);
  let leftShoulderScore  = scoreShoulder(input.leftShoulderAngle, input.shoulderElevated, input.shoulderAbducted);
  let rightShoulderScore = scoreShoulder(input.rightShoulderAngle, input.shoulderElevated, input.shoulderAbducted);

  const boosted = applyPersonalDeviationThresholdBoost(flatForBoost, userCal, {
    trunk: trunkScore,
    left: leftShoulderScore,
    right: rightShoulderScore,
  });
  trunkScore = boosted.trunk;
  leftShoulderScore = boosted.left;
  rightShoulderScore = boosted.right;

  const shoulderScore      = Math.max(leftShoulderScore, rightShoulderScore);
  const actionLevel        = getActionLevel(trunkScore, shoulderScore);
  const overallScore       = computeOverallScore(trunkScore, leftShoulderScore, rightShoulderScore);
  return { trunkScore, leftShoulderScore, rightShoulderScore, shoulderScore, actionLevel, overallScore };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE
// ─────────────────────────────────────────────────────────────────────────────

router.post("/posture/evaluate", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const body = (req.body ?? {}) as Partial<EvalRequestBody>;
    if (!body.session_id || !body.device_id)
      return res.status(400).json({ success: false, message: "session_id and device_id are required" });

    // ── Verify session ownership ──────────────────────────────────────────────
    const { data: session, error: sErr } = await supabase
      .from("posture_sessions")
      .select("id")
      .eq("id", String(body.session_id))
      .eq("user_id", userId)
      .single<{ id: string }>();

    if (sErr || !session)
      return res.status(404).json({ success: false, message: "Session not found" });

    const userCal = await loadUserCalibration(supabase, userId);
    const deviceCal = userCal ? null : await loadPostureCalibration(supabase, userId, String(body.device_id));

    // ── Fetch user preferences ────────────────────────────────────────────────
    const { data: prefs } = await supabase
      .from("user_thresholds")
      .select("vibration_intensity, vibration_pattern, push_notifications_enabled")
      .eq("user_id", userId)
      .single<UserPrefs>();

    const vibrationIntensity      = Math.max(1, Math.min(10, prefs?.vibration_intensity ?? 5));
    const vibrationPattern: VibrationPattern = prefs?.vibration_pattern ?? "normal";
    // push_notifications_enabled defaults to true if null/undefined
    const pushEnabled             = prefs?.push_notifications_enabled !== false;

    // ── Extract sensor values ─────────────────────────────────────────────────
    const headingRaw = toNumber(body.bno?.heading) ?? 0;
    const rollRaw    = toNumber(body.bno?.roll)    ?? 0;
    const pitchRaw   = toNumber(body.bno?.pitch)   ?? 0;

    const leftShoulderAngleRaw  = computeShoulderAngle(toNumber(body.mpu1?.Ay), toNumber(body.mpu1?.Az));
    const rightShoulderAngleRaw = computeShoulderAngle(toNumber(body.mpu2?.Ay), toNumber(body.mpu2?.Az));

    const flatCal = applyCalibrationChoice(
      {
        bno_heading: headingRaw,
        bno_roll: rollRaw,
        bno_pitch: pitchRaw,
        left_shoulder_angle: leftShoulderAngleRaw,
        right_shoulder_angle: rightShoulderAngleRaw,
      },
      userCal,
      deviceCal,
    );

    const heading = toNumber(flatCal.bno_heading) ?? 0;
    const roll    = toNumber(flatCal.bno_roll)    ?? 0;
    const pitch        = toNumber(flatCal.bno_pitch)   ?? 0;
    const trunkFlexion = pitch;

    const skipImuTwistTilt = shouldSkipImuTwistTiltForUserCal(userCal);
    const trunkTwist =
      body.trunkTwist !== undefined
        ? toBool(body.trunkTwist)
        : skipImuTwistTilt
          ? false
          : Math.abs(heading) > 10;
    const trunkTilt =
      body.trunkTilt !== undefined
        ? toBool(body.trunkTilt)
        : skipImuTwistTilt
          ? false
          : Math.abs(roll) > 10;

    const leftShoulderAngle  = toNumber(flatCal.left_shoulder_angle)  ?? 0;
    const rightShoulderAngle = toNumber(flatCal.right_shoulder_angle) ?? 0;
    const shoulderElevated   = toBool(body.shoulderElevated);
    const shoulderAbducted   = toBool(body.shoulderAbducted);

    // ── RULA scoring ──────────────────────────────────────────────────────────
    const scores = computeRulaScores({
      trunkFlexion, trunkTwist, trunkTilt,
      leftShoulderAngle, rightShoulderAngle, shoulderElevated, shoulderAbducted,
    }, flatCal, userCal);

    const isBad = scores.actionLevel >= 3;

    const recordedAt    = body.recorded_at ? new Date(String(body.recorded_at)) : new Date();
    const recordedAtIso = Number.isFinite(recordedAt.getTime())
      ? recordedAt.toISOString() : new Date().toISOString();

    // ── Vibration timing from pattern + severity ──────────────────────────────
    const severity      = scores.actionLevel >= 4 ? "severe" : "moderate";
    const timingConfig  = VIBRATION_TIMING[vibrationPattern][severity];

    // ── Save reading ──────────────────────────────────────────────────────────
    const readingRow: Record<string, unknown> = {
      user_id:              userId,
      session_id:           String(body.session_id),
      device_id:            String(body.device_id),
      recorded_at:          recordedAtIso,
      bno_heading:          heading,
      bno_roll:             roll,
      bno_pitch:            pitch,
      neck_angle:           null,
      upper_back_angle:     trunkFlexion,
      left_shoulder_angle:  leftShoulderAngle,
      right_shoulder_angle: rightShoulderAngle,
      neck_score:           NECK_SCORE_NEUTRAL,
      trunk_score:          scores.trunkScore,
      left_shoulder_score:  scores.leftShoulderScore,
      right_shoulder_score: scores.rightShoulderScore,
      action_level:         scores.actionLevel,
      overall_score:        scores.overallScore,
      trunk_twist:          trunkTwist,
      trunk_tilt:           trunkTilt,
    };

    const { error: rErr } = await supabase.from("posture_readings").insert([readingRow]);
    if (rErr) return res.status(400).json({ success: false, message: rErr.message });

    // ── Persistence timer ─────────────────────────────────────────────────────
    const key   = `${userId}:${body.device_id}:${body.session_id}`;
    const nowMs = Date.now();
    const state = stateByKey.get(key) ?? { badSinceMs: null, lastAlertMs: null };

    if (!isBad) {
      state.badSinceMs = null;
      stateByKey.set(key, state);

      return res.json({
        success:            true,
        trunkScore:         scores.trunkScore,
        leftShoulderScore:  scores.leftShoulderScore,
        rightShoulderScore: scores.rightShoulderScore,
        shoulderScore:      scores.shoulderScore,
        actionLevel:        scores.actionLevel,
        overallScore:       scores.overallScore,
        sendAlert:          false,
        triggerVibration:   false,
        vibrationIntensity,
        vibrationPattern,
        vibrationPulses:    0,
        vibrationIntervalMs: 0,
        pushEnabled,
        angles: { trunkFlexion, trunkTwist, trunkTilt, leftShoulderAngle, rightShoulderAngle },
      });
    }

    // ── Bad posture — check timer ─────────────────────────────────────────────
    if (state.badSinceMs === null) state.badSinceMs = nowMs;
    const badForSeconds = (nowMs - state.badSinceMs) / 1000;
    const cooldownOk    = state.lastAlertMs === null || nowMs - state.lastAlertMs > 15_000;

    let notify  = false;
    let vibrate = false;

    if (badForSeconds >= PERSIST_SECONDS && cooldownOk) {
      // Vibration always fires regardless of push notification setting
      vibrate = true;

      // Push notification only fires if user has enabled it
      notify  = pushEnabled;

      state.lastAlertMs = nowMs;

      const partScores = {
        upper_back:     scores.trunkScore,
        left_shoulder:  scores.leftShoulderScore,
        right_shoulder: scores.rightShoulderScore,
      };
      const worstPart = (Object.entries(partScores) as [string, number][])
        .sort(([, a], [, b]) => b - a)[0][0];

      await supabase.from("vibration_alerts").insert([{
        user_id:              userId,
        device_id:            String(body.device_id),
        session_id:           String(body.session_id),
        neck_angle:           null,
        upper_back_angle:     trunkFlexion,
        left_shoulder_angle:  leftShoulderAngle,
        right_shoulder_angle: rightShoulderAngle,
        action_level:         scores.actionLevel,
        worst_body_part:      worstPart,
        deviation_severity:   severity,
        triggered_at:         recordedAtIso,
      }]);
    }

    stateByKey.set(key, state);

    return res.json({
      success:             true,
      trunkScore:          scores.trunkScore,
      leftShoulderScore:   scores.leftShoulderScore,
      rightShoulderScore:  scores.rightShoulderScore,
      shoulderScore:       scores.shoulderScore,
      actionLevel:         scores.actionLevel,
      overallScore:        scores.overallScore,
      sendAlert:           notify,           // false if user disabled push notifications
      triggerVibration:    vibrate,          // always true when bad posture persists
      vibrationIntensity,                    // 1–10 strength
      vibrationPattern,                      // gentle | normal | aggressive
      vibrationPulses:     timingConfig.pulses,      // how many pulses per cycle
      vibrationIntervalMs: timingConfig.intervalMs,  // pause between cycles
      pushEnabled,
      angles: { trunkFlexion, trunkTwist, trunkTilt, leftShoulderAngle, rightShoulderAngle },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;