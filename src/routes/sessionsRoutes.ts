import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

// Matches posture_sessions DB schema exactly
type SessionRow = {
  id: string;
  user_id: string;
  device_id: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  avg_neck_angle: number | null;
  avg_upper_back_angle: number | null;
  avg_left_shoulder_angle: number | null;
  avg_right_shoulder_angle: number | null;
  avg_action_level: number | null;
  avg_overall_score: number | null;
  total_alerts: number | null;
  posture_score: number | null;
  created_at?: string;
};

const router = Router();

/**
 * POST /api/sessions/start  (protected)
 * Body: { device_id }
 */
router.post("/sessions/start", requireAuth, async (req, res) => {
  try {
    const userId     = req.user?.userId ?? req.user?.id;
    const { device_id } = req.body ?? {};

    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    if (!device_id)
      return res.status(400).json({ success: false, message: "device_id is required" });

    const { data, error } = await supabase
      .from("posture_sessions")
      .insert({
        user_id:    userId,
        device_id:  String(device_id),
        start_time: new Date().toISOString(),
      })
      .select("id")
      .single<{ id: string }>();

    if (error || !data)
      return res.status(400).json({ success: false, message: error?.message ?? "Session start failed" });

    return res.json({ success: true, session_id: data.id });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * PATCH /api/sessions/:sessionId/end  (protected)
 * Body: {
 *   avg_neck_angle, avg_upper_back_angle,
 *   avg_left_shoulder_angle, avg_right_shoulder_angle,
 *   avg_action_level, avg_overall_score,
 *   total_alerts, posture_score
 * }
 */
router.patch("/sessions/:sessionId/end", requireAuth, async (req, res) => {
  try {
    const userId        = req.user?.userId ?? req.user?.id;
    const { sessionId } = req.params;

    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    if (!sessionId)
      return res.status(400).json({ success: false, message: "sessionId is required" });

    const { data: existing, error: existingErr } = await supabase
      .from("posture_sessions")
      .select("id,start_time")
      .eq("id", String(sessionId))
      .eq("user_id", userId)
      .single<{ id: string; start_time: string }>();

    if (existingErr || !existing)
      return res.status(404).json({ success: false, message: "Session not found" });

    const now             = new Date();
    const start           = new Date(existing.start_time);
    const durationSeconds = Math.max(1, Math.floor((now.getTime() - start.getTime()) / 1000));

    const {
      avg_neck_angle,
      avg_upper_back_angle,
      avg_left_shoulder_angle,
      avg_right_shoulder_angle,
      avg_action_level,
      avg_overall_score,
      total_alerts,
      posture_score,
    } = req.body ?? {};

    const updates: Partial<SessionRow> = {
      end_time:         now.toISOString(),
      duration_seconds: durationSeconds,
    };

    if (avg_neck_angle            !== undefined) updates.avg_neck_angle            = Number(avg_neck_angle);
    if (avg_upper_back_angle      !== undefined) updates.avg_upper_back_angle      = Number(avg_upper_back_angle);
    if (avg_left_shoulder_angle   !== undefined) updates.avg_left_shoulder_angle   = Number(avg_left_shoulder_angle);
    if (avg_right_shoulder_angle  !== undefined) updates.avg_right_shoulder_angle  = Number(avg_right_shoulder_angle);
    if (avg_action_level          !== undefined) updates.avg_action_level          = Number(avg_action_level);
    if (avg_overall_score         !== undefined) updates.avg_overall_score         = Number(avg_overall_score);
    if (total_alerts              !== undefined) updates.total_alerts              = Number(total_alerts);
    if (posture_score             !== undefined) updates.posture_score             = Number(posture_score);

    const { data, error } = await supabase
      .from("posture_sessions")
      .update(updates)
      .eq("id", String(sessionId))
      .eq("user_id", userId)
      .select("*")
      .single<SessionRow>();

    if (error || !data)
      return res.status(400).json({ success: false, message: error?.message ?? "Session update failed" });

    return res.json({ success: true, session: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * GET /api/sessions  (protected)
 * Optional: ?limit=10
 */
router.get("/sessions", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const rawLimit  = req.query?.limit;
    const limit     = rawLimit === undefined ? 10 : Number(rawLimit);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(100, Math.floor(limit)) : 10;

    const { data, error } = await supabase
      .from("posture_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("start_time", { ascending: false })
      .limit(safeLimit);

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, sessions: data ?? [] });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * GET /api/sessions/:sessionId  (protected)
 */
router.get("/sessions/:sessionId", requireAuth, async (req, res) => {
  try {
    const userId        = req.user?.userId ?? req.user?.id;
    const { sessionId } = req.params;

    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const { data, error } = await supabase
      .from("posture_sessions")
      .select("*")
      .eq("id", String(sessionId))
      .eq("user_id", userId)
      .single<SessionRow>();

    if (error || !data)
      return res.status(404).json({ success: false, message: "Session not found" });

    return res.json({ success: true, session: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;