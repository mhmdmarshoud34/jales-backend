import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

type AlertRow = {
  id: string;
  user_id: string;
  device_id: string;
  session_id: string | null;
  neck_angle: number | null;
  upper_back_angle: number | null;
  shoulder_angle: number | null;
  deviation_severity: number | string | null;
  created_at?: string;
};

const router = Router();

/**
 * POST /api/alerts (protected)
 * Body: { device_id, session_id, neck_angle, upper_back_angle, shoulder_angle, deviation_severity }
 */
router.post("/alerts", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { device_id, session_id, neck_angle, upper_back_angle, shoulder_angle, deviation_severity } = req.body ?? {};

    if (!device_id) {
      return res.status(400).json({ success: false, message: "device_id is required" });
    }

    const toNumOrNull = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const record = {
      user_id: userId,
      device_id: String(device_id),
      session_id: session_id ? String(session_id) : null,
      neck_angle: toNumOrNull(neck_angle),
      upper_back_angle: toNumOrNull(upper_back_angle),
      shoulder_angle: toNumOrNull(shoulder_angle),
      deviation_severity: deviation_severity ?? null,
    };

    const { data, error } = await supabase.from("vibration_alerts").insert(record).select("*").single<AlertRow>();

    if (error || !data) {
      return res.status(400).json({ success: false, message: error?.message ?? "Insert failed" });
    }

    return res.json({ success: true, alert: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * GET /api/alerts (protected)
 * Optional: ?session_id=uuid OR ?date=YYYY-MM-DD
 */
router.get("/alerts", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const sessionId = req.query?.session_id ? String(req.query.session_id) : null;
    const date = req.query?.date ? String(req.query.date) : null;

    let q = supabase.from("vibration_alerts").select("*").eq("user_id", userId);

    if (sessionId) {
      q = q.eq("session_id", sessionId);
    }

    if (date) {
      // Treat as a UTC day range: [dateT00:00:00Z, nextDateT00:00:00Z)
      const start = new Date(`${date}T00:00:00.000Z`);
      if (!Number.isFinite(start.getTime())) {
        return res.status(400).json({ success: false, message: "date must be in YYYY-MM-DD format" });
      }
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);

      // Requires a timestamp column. If your table doesn't have created_at, add it or rename here.
      // Returning a clear error avoids PostgREST "column does not exist".
      return res.status(400).json({
        success: false,
        message:
          "Date filtering requires a timestamp column (e.g. vibration_alerts.created_at). Add created_at to the table or update the backend to use your timestamp column.",
      });
    }

    // Some schemas don't include created_at; order by id instead.
    const { data, error } = await q.order("id", { ascending: false });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, alerts: data ?? [] });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;

