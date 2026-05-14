import { Router } from "express";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

type SafeUser = {
  id: string;
  name: string;
  email: string;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  created_at: string;
};

const router = Router();

/**
 * GET /me
 * Header: Authorization: Bearer <token>
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;

    const { data: user, error } = await supabase
      .from("users")
      .select("id,name,email,age,height_cm,weight_kg,created_at")
      .eq("id", userId)
      .single<SafeUser>();

    if (error || !user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, user });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;
