import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

export type VibrationPattern = "gentle" | "normal" | "aggressive";

export type ThresholdsRow = {
  id: string;
  user_id: string;
  neck_threshold: number | null;
  upper_back_threshold: number | null;
  shoulder_threshold: number | null;
  vibration_intensity: number | null;
  vibration_pattern: VibrationPattern | null;
  push_notifications_enabled: boolean | null;
  updated_at: string;
};

/**
 * Vibration timing config per pattern and severity.
 * pulses     = number of motor pulses per cycle
 * intervalMs = pause between cycles in milliseconds
 */
export const VIBRATION_TIMING: Record<
  VibrationPattern,
  {
    moderate: { pulses: number; intervalMs: number };
    severe:   { pulses: number; intervalMs: number };
  }
> = {
  gentle: {
    moderate: { pulses: 1, intervalMs: 10_000 },
    severe:   { pulses: 1, intervalMs:  6_000 },
  },
  normal: {
    moderate: { pulses: 1, intervalMs:  8_000 },
    severe:   { pulses: 2, intervalMs:  5_000 },
  },
  aggressive: {
    moderate: { pulses: 1, intervalMs:  6_000 },
    severe:   { pulses: 3, intervalMs:  4_000 },
  },
};

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all user preferences including notification and vibration settings.
 */
router.get("/thresholds", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const { data, error } = await supabase
      .from("user_thresholds")
      .select("*")
      .eq("user_id", userId)
      .single<ThresholdsRow>();

    if (error || !data)
      return res.status(404).json({ success: false, message: "Thresholds not found" });

    return res.json({ success: true, thresholds: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update any combination of:
 *   neck_threshold, upper_back_threshold, shoulder_threshold,
 *   vibration_intensity (1–10),
 *   vibration_pattern (gentle | normal | aggressive),
 *   push_notifications_enabled (boolean)
 */
router.put("/thresholds", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const updates: Record<string, unknown> = {};

    // Standard threshold fields
    for (const key of ["neck_threshold", "upper_back_threshold", "shoulder_threshold"] as const) {
      if (req.body?.[key] !== undefined) updates[key] = req.body[key];
    }

    // vibration_intensity — clamp 1–10
    if (req.body?.vibration_intensity !== undefined) {
      const raw     = Number(req.body.vibration_intensity);
      const clamped = Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.round(raw))) : 5;
      updates.vibration_intensity = clamped;
    }

    // vibration_pattern — validate enum
    if (req.body?.vibration_pattern !== undefined) {
      const allowed: VibrationPattern[] = ["gentle", "normal", "aggressive"];
      const val = String(req.body.vibration_pattern).toLowerCase();
      if (!allowed.includes(val as VibrationPattern)) {
        return res.status(400).json({
          success: false,
          message: `vibration_pattern must be one of: ${allowed.join(", ")}`,
        });
      }
      updates.vibration_pattern = val;
    }

    // push_notifications_enabled — boolean
    if (req.body?.push_notifications_enabled !== undefined) {
      const val = req.body.push_notifications_enabled;
      updates.push_notifications_enabled =
        typeof val === "boolean" ? val : String(val).toLowerCase() !== "false";
    }

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ success: false, message: "No valid fields to update" });

    const { data, error } = await supabase
      .from("user_thresholds")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .select("*")
      .single<ThresholdsRow>();

    if (error || !data)
      return res.status(400).json({ success: false, message: error?.message ?? "Update failed" });

    return res.json({ success: true, thresholds: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/thresholds/best-angles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the user's best recorded angles from posture_readings
 * where action_level = 1 (perfect posture only).
 *
 * Neck is not monitored; averages and auto-save cover upper back + shoulders only.
 */
router.get("/thresholds/best-angles", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    // Fetch all perfect-posture readings for this user
    const { data: readings, error } = await supabase
      .from("posture_readings")
      .select("upper_back_angle, left_shoulder_angle, right_shoulder_angle")
      .eq("user_id", userId)
      .eq("action_level", 1);   // only action_level = 1 (perfect posture)

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    if (!readings || readings.length === 0) {
      return res.status(200).json({
        success:  true,
        hasData:  false,
        message:  "No perfect-posture readings found yet. Wear the shirt in good posture first.",
      });
    }

    // ── Average per body part ─────────────────────────────────────────────
    const avg = (key: string): number | null => {
      const vals = (readings as Record<string, unknown>[])
        .map((r) => r[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (vals.length === 0) return null;
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    };

    const upperBackAngle     = avg("upper_back_angle");
    const leftShoulderAngle  = avg("left_shoulder_angle");
    const rightShoulderAngle = avg("right_shoulder_angle");

    const bestAngles = {
      upper_back_angle:     upperBackAngle,
      left_shoulder_angle:  leftShoulderAngle,
      right_shoulder_angle: rightShoulderAngle,
      readings_used:        readings.length,
    };

    // ── Auto-save to user_thresholds ──────────────────────────────────────
    // Upper back + shoulders only (neck_threshold unchanged).
    const thresholdUpdates: Record<string, number> = {};

    if (upperBackAngle !== null) thresholdUpdates.upper_back_threshold = upperBackAngle;

    const shoulderVals = [leftShoulderAngle, rightShoulderAngle].filter(
      (v): v is number => v !== null,
    );
    if (shoulderVals.length > 0) {
      thresholdUpdates.shoulder_threshold = Math.round(
        (shoulderVals.reduce((a, b) => a + b, 0) / shoulderVals.length) * 10,
      ) / 10;
    }

    if (Object.keys(thresholdUpdates).length > 0) {
      const { error: uErr } = await supabase
        .from("user_thresholds")
        .update({ ...thresholdUpdates, updated_at: new Date().toISOString() })
        .eq("user_id", userId);

      if (uErr) {
        // Non-fatal — return angles but warn
        console.warn("[thresholds/best-angles] auto-save failed:", uErr.message);
        return res.json({
          success:   true,
          hasData:   true,
          bestAngles,
          autoSaved: false,
          warning:   "Angles computed but could not be auto-saved: " + uErr.message,
        });
      }
    }

    return res.json({
      success:   true,
      hasData:   true,
      bestAngles,
      autoSaved: Object.keys(thresholdUpdates).length > 0,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;