import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

type DeviceRow = {
  id: string;
  user_id: string;
  mac_address: string;
  device_name: string | null;
  battery_level: number | null;
  last_synced_at: string | null;
  created_at?: string;
};

const router = Router();

/**
 * POST /api/devices/register (protected)
 * Body: { mac_address, device_name }
 */
router.post("/devices/register", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    const { mac_address, device_name } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!mac_address) {
      return res.status(400).json({ success: false, message: "mac_address is required" });
    }

    const mac = String(mac_address).trim().toLowerCase();
    const name = device_name === undefined ? null : String(device_name);

    const { data: existing } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", userId)
      .eq("mac_address", mac)
      .maybeSingle<{ id: string }>();
    const isNewDevice = !existing;

    const { data, error } = await supabase
      .from("devices")
      .upsert(
        {
          user_id: userId,
          mac_address: mac,
          device_name: name,
        },
        { onConflict: "user_id,mac_address" }
      )
      .select("*")
      .single<DeviceRow>();

    if (error || !data) {
      return res.status(400).json({ success: false, message: error?.message ?? "Device upsert failed" });
    }

    if (isNewDevice) {
      console.log("[device] new", {
        id: data.id,
        user_id: userId,
        mac_address: mac,
        device_name: name,
      });
    }

    return res.json({ success: true, device: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * GET /api/devices (protected)
 */
router.get("/devices", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { data, error } = await supabase
      .from("devices")
      .select("*")
      .eq("user_id", userId)
      // Some schemas don't include created_at; order by id instead.
      .order("id", { ascending: false });

    if (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.json({ success: true, devices: data ?? [] });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * PATCH /api/devices/:deviceId/battery (protected)
 * Body: { battery_level }
 */
router.patch("/devices/:deviceId/battery", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    const { deviceId } = req.params;
    const { battery_level } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!deviceId) {
      return res.status(400).json({ success: false, message: "deviceId is required" });
    }

    if (battery_level === undefined || battery_level === null || battery_level === "") {
      return res.status(400).json({ success: false, message: "battery_level is required" });
    }

    const lvl = typeof battery_level === "number" ? battery_level : Number(battery_level);
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 100) {
      return res.status(400).json({ success: false, message: "battery_level must be a number between 0 and 100" });
    }

    const { data, error } = await supabase
      .from("devices")
      .update({ battery_level: lvl, last_synced_at: new Date().toISOString() })
      .eq("id", String(deviceId))
      .eq("user_id", userId)
      .select("*")
      .single<DeviceRow>();

    if (error || !data) {
      return res.status(400).json({ success: false, message: error?.message ?? "Update failed" });
    }

    return res.json({ success: true, device: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;

