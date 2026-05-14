import type { SupabaseClient } from "@supabase/supabase-js";

export type PostureCalibrationRow = {
  user_id: string;
  device_id: string;
  ref_heading: number;
  ref_roll: number;
  ref_pitch: number;
  ref_left_shoulder_angle: number;
  ref_right_shoulder_angle: number;
  updated_at: string;
};

/** One row per user — baselines + thresholds (React Native calibrate flow). */
export type UserCalibrationRow = {
  user_id: string;
  back_baseline_pitch: number | null;
  left_shoulder_baseline: number | null;
  right_shoulder_baseline: number | null;
  back_threshold: number;
  shoulder_threshold: number;
  updated_at: string;
};

/**
 * `user_calibration` subtracts `back_baseline_pitch` only; heading/roll are left in the
 * sensor’s absolute frame. The RULA-style |heading|>10 / |roll|>10 twist/tilt flags would
 * then misalign with baseline-corrected pitch (e.g. 2° pitch + large raw heading → trunk 4).
 * Until optional heading/roll baselines exist on this row, callers should not infer twist/tilt
 * from raw heading/roll when a pitch baseline is set. `/posture/evaluate` may still pass
 * explicit `trunkTwist` / `trunkTilt` from the client.
 */
export function shouldSkipImuTwistTiltForUserCal(userCal: UserCalibrationRow | null): boolean {
  return (
    userCal != null &&
    userCal.back_baseline_pitch != null &&
    Number.isFinite(userCal.back_baseline_pitch)
  );
}

type ReadingLike = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * After base RULA part scores, bump any part whose **calibrated-relative** magnitude
 * exceeds the user's saved `back_threshold` / `shoulder_threshold` (from `user_calibration`).
 * `flat` must already be the output of `applyUserCalibrationToFlat` / `applyCalibrationChoice`.
 * Threshold ≤ 0 disables that axis. REBA is not implemented here — only this + RULA bands.
 */
export function applyPersonalDeviationThresholdBoost(
  flat: Record<string, unknown>,
  userCal: UserCalibrationRow | null,
  partScores: { trunk: number; left: number; right: number },
): { trunk: number; left: number; right: number } {
  if (!userCal) return partScores;
  const pitchAbs = Math.abs(num(flat.bno_pitch) ?? 0);
  const left = num(flat.left_shoulder_angle) ?? 0;
  const right = num(flat.right_shoulder_angle) ?? 0;
  let { trunk, left: ls, right: rs } = partScores;
  if (userCal.back_threshold > 0 && pitchAbs > userCal.back_threshold) {
    trunk = Math.min(4, trunk + 1);
  }
  if (userCal.shoulder_threshold > 0 && ls > userCal.shoulder_threshold) {
    ls = Math.min(4, ls + 1);
  }
  if (userCal.shoulder_threshold > 0 && rs > userCal.shoulder_threshold) {
    rs = Math.min(4, rs + 1);
  }
  return { trunk, left: ls, right: rs };
}

/** Shortest signed difference on a circle, result in (-180, 180]. */
export function wrapAngleDeg180(delta: number): number {
  let x = delta % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

export function normalizeShoulderAngle(raw: number): number {
  let angle = raw;
  if (angle > 90) angle = 180 - angle;
  if (angle < 0) angle = Math.abs(angle);
  return angle;
}

export function shoulderDeviationFromRef(current: number, ref: number): number {
  return Math.abs(current - ref);
}

export function extractBnoFlat(r: ReadingLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bno = r.bno;
  if (bno && typeof bno === "object" && !Array.isArray(bno)) {
    const o = bno as Record<string, unknown>;
    if (num(o.heading) !== null) out.bno_heading = num(o.heading);
    if (num(o.roll) !== null) out.bno_roll = num(o.roll);
    if (num(o.pitch) !== null) out.bno_pitch = num(o.pitch);
  }
  return out;
}

export function computeShoulderAnglesFlat(r: ReadingLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const mpu1 = r.mpu1 as Record<string, unknown> | undefined;
  if (mpu1) {
    const Ay = num(mpu1.Ay),
      Az = num(mpu1.Az);
    if (Ay !== null && Az !== null)
      out.left_shoulder_angle = normalizeShoulderAngle(Math.atan2(Ay, Az) * (180 / Math.PI));
  }

  const mpu2 = r.mpu2 as Record<string, unknown> | undefined;
  if (mpu2) {
    const Ay = num(mpu2.Ay),
      Az = num(mpu2.Az);
    if (Ay !== null && Az !== null)
      out.right_shoulder_angle = normalizeShoulderAngle(Math.atan2(Ay, Az) * (180 / Math.PI));
  }

  return out;
}

/**
 * Snapshot refs from the same payload shape as /posture/evaluate (bno + mpu1/mpu2).
 * Missing MPU axes default shoulder refs to 0.
 */
export function computeReferenceSnapshotFromBody(body: ReadingLike): Omit<PostureCalibrationRow, "user_id" | "device_id" | "updated_at"> {
  const flat = { ...extractBnoFlat(body), ...computeShoulderAnglesFlat(body) };
  return {
    ref_heading: num(flat.bno_heading) ?? 0,
    ref_roll: num(flat.bno_roll) ?? 0,
    ref_pitch: num(flat.bno_pitch) ?? 0,
    ref_left_shoulder_angle: num(flat.left_shoulder_angle) ?? 0,
    ref_right_shoulder_angle: num(flat.right_shoulder_angle) ?? 0,
  };
}

/**
 * Apply user-level baselines: trunk uses `back_baseline_pitch` on BNO pitch;
 * shoulders use absolute deviation when baselines are set.
 * Heading/roll are unchanged (no baselines in this model — see `shouldSkipImuTwistTiltForUserCal`).
 */
export function applyUserCalibrationToFlat(
  flat: Record<string, unknown>,
  cal: UserCalibrationRow,
): Record<string, unknown> {
  const heading = num(flat.bno_heading) ?? 0;
  const roll = num(flat.bno_roll) ?? 0;
  const pitch = num(flat.bno_pitch) ?? 0;
  const left = num(flat.left_shoulder_angle) ?? 0;
  const right = num(flat.right_shoulder_angle) ?? 0;

  const pitchOut =
    cal.back_baseline_pitch != null && Number.isFinite(cal.back_baseline_pitch)
      ? wrapAngleDeg180(pitch - cal.back_baseline_pitch)
      : pitch;

  const leftOut =
    cal.left_shoulder_baseline != null && Number.isFinite(cal.left_shoulder_baseline)
      ? shoulderDeviationFromRef(left, cal.left_shoulder_baseline)
      : left;

  const rightOut =
    cal.right_shoulder_baseline != null && Number.isFinite(cal.right_shoulder_baseline)
      ? shoulderDeviationFromRef(right, cal.right_shoulder_baseline)
      : right;

  return {
    ...flat,
    bno_heading: heading,
    bno_roll: roll,
    bno_pitch: pitchOut,
    left_shoulder_angle: leftOut,
    right_shoulder_angle: rightOut,
  };
}

/**
 * Subtract stored reference from BNO euler-style angles (wrapped).
 * Shoulder angles become absolute deviation from calibrated neutral (0–90 domain).
 */
export function applyCalibrationToFlat(
  flat: Record<string, unknown>,
  cal: PostureCalibrationRow | null,
): Record<string, unknown> {
  if (!cal) return { ...flat };

  const heading = num(flat.bno_heading) ?? 0;
  const roll = num(flat.bno_roll) ?? 0;
  const pitch = num(flat.bno_pitch) ?? 0;
  const left = num(flat.left_shoulder_angle) ?? 0;
  const right = num(flat.right_shoulder_angle) ?? 0;

  return {
    ...flat,
    bno_heading: wrapAngleDeg180(heading - cal.ref_heading),
    bno_roll: wrapAngleDeg180(roll - cal.ref_roll),
    bno_pitch: wrapAngleDeg180(pitch - cal.ref_pitch),
    left_shoulder_angle: shoulderDeviationFromRef(left, cal.ref_left_shoulder_angle),
    right_shoulder_angle: shoulderDeviationFromRef(right, cal.ref_right_shoulder_angle),
  };
}

export async function loadPostureCalibration(
  supabase: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<PostureCalibrationRow | null> {
  const { data, error } = await supabase
    .from("posture_calibration")
    .select("*")
    .eq("user_id", userId)
    .eq("device_id", String(deviceId))
    .maybeSingle<PostureCalibrationRow>();

  if (error || !data) return null;
  return data;
}

export async function loadUserCalibration(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserCalibrationRow | null> {
  const { data, error } = await supabase
    .from("user_calibration")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle<UserCalibrationRow>();

  if (error || !data) return null;
  return data;
}

/** Prefer `user_calibration` when `userCal` is set; else `deviceCal` (may be null). */
export function applyCalibrationChoice(
  flatRaw: Record<string, unknown>,
  userCal: UserCalibrationRow | null,
  deviceCal: PostureCalibrationRow | null,
): Record<string, unknown> {
  if (userCal) return applyUserCalibrationToFlat(flatRaw, userCal);
  return applyCalibrationToFlat(flatRaw, deviceCal);
}

export async function applyStoredCalibration(
  supabase: SupabaseClient,
  userId: string,
  deviceId: string,
  flatRaw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const userCal = await loadUserCalibration(supabase, userId);
  if (userCal) return applyUserCalibrationToFlat(flatRaw, userCal);
  const deviceCal = await loadPostureCalibration(supabase, userId, deviceId);
  return applyCalibrationToFlat(flatRaw, deviceCal);
}

export async function ensureDeviceOwnedByUser(
  supabase: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("devices")
    .select("id")
    .eq("id", String(deviceId))
    .eq("user_id", userId)
    .maybeSingle<{ id: string }>();

  return !error && !!data;
}
