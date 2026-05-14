import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";
import {
  computeReferenceSnapshotFromBody,
  ensureDeviceOwnedByUser,
  type PostureCalibrationRow,
} from "../utils/postureCalibration";

const router = Router();

type CalibrateBody = {
  device_id?: string;
  bno?: { heading?: number; roll?: number; pitch?: number };
  mpu1?: { Ax?: number; Ay?: number; Az?: number; Gx?: number; Gy?: number; Gz?: number };
  mpu2?: { Ax?: number; Ay?: number; Az?: number; Gx?: number; Gy?: number; Gz?: number };
};

function publicCalibrationRow(row: PostureCalibrationRow): Omit<PostureCalibrationRow, "user_id"> {
  const { user_id: _, ...rest } = row;
  return rest;
}

/**
 * POST /posture/calibrate
 * Saves neutral reference for user+device. Persists immediately.
 *
 * Client: on success, persist returned `calibration` to calibrationSnapshotStorage.
 */
router.post("/posture/calibrate", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const body = (req.body ?? {}) as CalibrateBody;
    const deviceId = body.device_id !== undefined && body.device_id !== null ? String(body.device_id) : "";
    if (!deviceId)
      return res.status(400).json({ success: false, message: "device_id is required" });

    const owned = await ensureDeviceOwnedByUser(supabase, userId, deviceId);
    if (!owned)
      return res.status(403).json({ success: false, message: "Device not found for this user" });

    const refs = computeReferenceSnapshotFromBody(body as Record<string, unknown>);
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("posture_calibration")
      .upsert(
        {
          user_id: userId,
          device_id: deviceId,
          ...refs,
          updated_at: now,
        },
        { onConflict: "user_id,device_id" },
      )
      .select("*")
      .single<PostureCalibrationRow>();

    if (error || !data) {
      return res.status(400).json({
        success: false,
        message: error?.message ?? "Could not save calibration (did you run the posture_calibration migration?)",
      });
    }

    console.log("[baseline] posture_calibration saved to DB", {
      userId,
      deviceId,
      snapshotUsedForSave: refs,
      persisted: publicCalibrationRow(data),
    });

    return res.json({
      success: true,
      calibration: publicCalibrationRow(data),
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * DELETE /posture/calibrate?device_id=...
 * Removes server-side calibration. Client must clear calibrationSnapshotStorage on success.
 */
router.delete("/posture/calibrate", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const deviceId =
      req.query?.device_id !== undefined && req.query.device_id !== null
        ? String(req.query.device_id)
        : "";
    if (!deviceId)
      return res.status(400).json({ success: false, message: "device_id query parameter is required" });

    const owned = await ensureDeviceOwnedByUser(supabase, userId, deviceId);
    if (!owned)
      return res.status(403).json({ success: false, message: "Device not found for this user" });

    const { error } = await supabase
      .from("posture_calibration")
      .delete()
      .eq("user_id", userId)
      .eq("device_id", deviceId);

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    console.log("[baseline] posture_calibration cleared from DB", { userId, deviceId });

    return res.json({
      success: true,
      cleared: true,
      clearLocalCalibrationCache: true,
      message:
        "Server calibration removed. Clear calibrationSnapshotStorage (or equivalent) on the client so the UI matches.",
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * GET /posture/calibration?device_id=...
 * Returns current server calibration for sync / hydrating local cache.
 */
router.get("/posture/calibration", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const deviceId =
      req.query?.device_id !== undefined && req.query.device_id !== null
        ? String(req.query.device_id)
        : "";
    if (!deviceId)
      return res.status(400).json({ success: false, message: "device_id query parameter is required" });

    const owned = await ensureDeviceOwnedByUser(supabase, userId, deviceId);
    if (!owned)
      return res.status(403).json({ success: false, message: "Device not found for this user" });

    const { data, error } = await supabase
      .from("posture_calibration")
      .select("*")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .maybeSingle<PostureCalibrationRow>();

    if (error)
      return res.status(400).json({ success: false, message: error.message });

    return res.json({
      success: true,
      calibration: data ? publicCalibrationRow(data) : null,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;
