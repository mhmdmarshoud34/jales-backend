import { Router } from "express";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { supabase } from "../supabase";

type UserRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  created_at: string;
};

function safeUser(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    age: u.age,
    height_cm: u.height_cm,
    weight_kg: u.weight_kg,
    created_at: u.created_at,
  };
}

function signToken(user: { id: string; email: string }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined");
  }
  return jwt.sign(
    { sub: user.id, email: user.email },
    secret,
    { expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as SignOptions["expiresIn"] }
  );
}

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      age,
      height_cm,
      weight_kg,
      // optional thresholds (if not provided, defaults will be used)
      neck_threshold,
      upper_back_threshold,
      shoulder_threshold,
    } = req.body ?? {};

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "name, email, password are required" });
    }

    const defaults = {
      neck_threshold: 30.0,
      upper_back_threshold: 25.0,
      shoulder_threshold: 20.0,
    };

    const toOptionalNumber = (v: unknown): number | undefined => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const thresholds = {
      neck_threshold: toOptionalNumber(neck_threshold) ?? defaults.neck_threshold,
      upper_back_threshold: toOptionalNumber(upper_back_threshold) ?? defaults.upper_back_threshold,
      shoulder_threshold: toOptionalNumber(shoulder_threshold) ?? defaults.shoulder_threshold,
    };

    // basic validation (adjust ranges as needed)
    if (thresholds.neck_threshold < 0 || thresholds.upper_back_threshold < 0 || thresholds.shoulder_threshold < 0) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid thresholds. neck_threshold, upper_back_threshold, shoulder_threshold must be >= 0.",
      });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
    const hashedPass = await bcrypt.hash(String(password), saltRounds);

    const { data: user, error: userErr } = await supabase
      .from("users")
      .insert({
        name: String(name),
        email: cleanEmail,
        password_hash: hashedPass,
        age: age ?? null,
        height_cm: height_cm ?? null,
        weight_kg: weight_kg ?? null,
      })
      .select("*")
      .single<UserRow>();

    if (userErr || !user) {
      return res.status(400).json({ success: false, message: userErr?.message ?? "User creation failed" });
    }

    const { error: thErr } = await supabase.from("user_thresholds").insert({
      user_id: user.id,
      ...thresholds,
      updated_at: new Date().toISOString(),
    });

    if (thErr) {
      return res.status(400).json({ success: false, message: thErr.message });
    }

    return res.json({
      success: true,
      message: "Registered successfully.",
      user: safeUser(user),
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});


router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "email and password are required" });
    }

    const cleanEmail = String(email).toLowerCase().trim();

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", cleanEmail)
      .single<UserRow>();

    if (error || !user) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const token = signToken({ id: user.id, email: user.email });

    return res.json({
      success: true,
      token,
      user: safeUser(user),
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;
