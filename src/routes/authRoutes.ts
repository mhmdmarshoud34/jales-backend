import { Router } from "express";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { supabase } from "../supabase";
import { generateOtp, addMinutes } from "../utils/otp";
import { sendOtpEmail } from "../utils/mailer";

type UserRow = {
  id: string;
  name: string;
  email: string;
  password: string;
  age: number | null;
  gender: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  created_at: string;
  is_verified: boolean;
};

type OtpRow = {
  id: string;
  user_id: string;
  purpose: string;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
};

function safeUser(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    age: u.age,
    gender: u.gender,
    height_cm: u.height_cm,
    weight_kg: u.weight_kg,
    created_at: u.created_at,
    is_verified: u.is_verified,
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

async function createSignupOtp(userId: string): Promise<string> {
  const length = Number(process.env.OTP_LENGTH || 6);
  const otp = generateOtp(length);

  const expiresMin = Number(process.env.OTP_EXPIRES_MINUTES || 10);
  const expiresAt = addMinutes(new Date(), expiresMin).toISOString();

  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
  const codeHash = await bcrypt.hash(otp, saltRounds);

  await supabase
    .from("User_Otp")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("used_at", null);

  const { error } = await supabase.from("User_Otp").insert({
    user_id: userId,
    purpose: "verify_email",
    code_hash: codeHash,
    expires_at: expiresAt,
  });

  if (error) throw new Error(error.message);

  return otp;
}

async function verifySignupOtp(userId: string, otp: string): Promise<{ ok: true } | { ok: false; message: string }> {
  // latest unused OTP
  const { data: row, error } = await supabase
    .from("User_Otp")
    .select("*")
    .eq("user_id", userId)
    .eq("purpose", "verify_email")
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .single<OtpRow>();

  if (error || !row) return { ok: false, message: "OTP not found" };

  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, message: "OTP expired" };
  }

  if (row.attempts >= row.max_attempts) {
    return { ok: false, message: "Too many attempts. Request a new OTP." };
  }

  const match = await bcrypt.compare(otp, row.code_hash);

  await supabase
    .from("User_Otp")
    .update({ attempts: row.attempts + 1 })
    .eq("id", row.id);

  if (!match) return { ok: false, message: "Invalid OTP" };

  await supabase
    .from("User_Otp")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id);

  return { ok: true };
}

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const { name, email, password, age, gender, height_cm, weight_kg } = req.body ?? {};

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "name, email, password are required" });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
    const hashedPass = await bcrypt.hash(String(password), saltRounds);

    const { data: user, error: userErr } = await supabase
      .from("Users")
      .insert({
        name: String(name),
        email: cleanEmail,
        password: hashedPass,
        age: age ?? null,
        gender: gender ?? null,
        height_cm: height_cm ?? null,
        weight_kg: weight_kg ?? null,
        is_verified: false,
      })
      .select("*")
      .single<UserRow>();

    if (userErr || !user) {
      return res.status(400).json({ success: false, message: userErr?.message ?? "User creation failed" });
    }

    const { error: thErr } = await supabase.from("User_Thresholds").insert({
      user_id: user.id,
      neck_max_angle: 20,
      upper_back_max_angle: 20,
      shoulder_imbalance_max: 10,
      vibration_intensity: 50,
      updated_at: new Date().toISOString(),
    });

    if (thErr) {
      return res.status(400).json({ success: false, message: thErr.message });
    }

    const otp = await createSignupOtp(user.id);
    await sendOtpEmail(user.email, otp);

    return res.json({
      success: true,
      message: "Registered successfully. OTP has been sent to your email.",
      user_id: user.id,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { user_id, otp } = req.body ?? {};

    if (!user_id || !otp) {
      return res.status(400).json({ success: false, message: "user_id and otp are required" });
    }

    const { data: user, error: userErr } = await supabase
      .from("Users")
      .select("*")
      .eq("id", String(user_id))
      .single<UserRow>();

    if (userErr || !user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.is_verified) {
      return res.json({ success: true, message: "Account already verified." });
    }

    const v = await verifySignupOtp(user.id, String(otp));
    if (!v.ok) {
      return res.status(400).json({ success: false, message: v.message });
    }

    await supabase.from("Users").update({ is_verified: true }).eq("id", user.id);

    return res.json({ success: true, message: "Account verified successfully. You can login now." });
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
      .from("Users")
      .select("*")
      .eq("email", cleanEmail)
      .single<UserRow>();

    if (error || !user) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (!user.is_verified) {
      return res.status(403).json({ success: false, message: "Account not verified. Please verify OTP first." });
    }

    const ok = await bcrypt.compare(String(password), user.password);
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
