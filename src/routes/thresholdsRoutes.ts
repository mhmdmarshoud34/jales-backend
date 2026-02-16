import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

type ThresholdsRow = {
  id: string;
  user_id: string;
  neck_max_angle: number | null;
  upper_back_max_angle: number | null;
  shoulder_imbalance_max: number | null;
  vibration_intensity: number | null;
  updated_at: string;
};

const router = Router();

/**
 * GET /thresholds
 */
router.get("/thresholds", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from("User_Thresholds")
      .select("*")
      .eq("user_id", userId)
      .single<ThresholdsRow>();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Thresholds not found" });
    }

    return res.json({ success: true, thresholds: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * PUT /thresholds
 * Body can include any of:
 * neck_max_angle, upper_back_max_angle, shoulder_imbalance_max, vibration_intensity
 */
router.put("/thresholds", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;

    const allowed = [
      "neck_max_angle",
      "upper_back_max_angle",
      "shoulder_imbalance_max",
      "vibration_intensity",
    ] as const;

    const updates: Partial<Record<(typeof allowed)[number], unknown>> = {};

    for (const key of allowed) {
      if (req.body?.[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No valid fields to update" });
    }

    const { data, error } = await supabase
      .from("User_Thresholds")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .select("*")
      .single<ThresholdsRow>();

    if (error || !data) {
      return res.status(400).json({ success: false, message: error?.message ?? "Update failed" });
    }

    return res.json({ success: true, thresholds: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;
