import { Router } from "express";
import OpenAI from "openai";
import { supabase } from "../supabase";
import { requireAuth } from "../middleware/auth";

type AiMessageRow = {
  id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
};

const router = Router();

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not defined");
  return new OpenAI({ apiKey });
}

/**
 * POST /ai/chat (protected)
 * Body: { message }
 */
router.post("/ai/chat", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { message } = req.body ?? {};
    if (!message) return res.status(400).json({ success: false, message: "message is required" });

    const client = getOpenAIClient();

    const { data: recentSummaries } = await supabase
      .from("daily_summary")
      .select("*")
      .eq("user_id", userId)
      .order("summary_date", { ascending: false })
      .limit(7);

    const { data: history } = await supabase
      .from("ai_messages")
      .select("role,content,id")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .limit(20);

    const systemPrompt =
      "You are an AI posture doctor assistant for the JALES smart shirt app. " +
      "The user's recent posture data is: " +
      JSON.stringify(recentSummaries ?? []) +
      ". Provide personalized, helpful advice about their posture based on this data.";

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        ...(history ?? []).map((m: any) => ({ role: m.role, content: m.content })),
        { role: "user", content: String(message) },
      ],
    });

    const aiReply = completion.choices?.[0]?.message?.content ?? "";

    await supabase.from("ai_messages").insert([
      { user_id: userId, role: "user", content: String(message) },
      { user_id: userId, role: "assistant", content: aiReply },
    ]);

    return res.json({ success: true, reply: aiReply });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

/**
 * GET /ai/history (protected)
 * Returns past AI messages for user ordered by id ASC
 */
router.get("/ai/history", requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { data, error } = await supabase
      .from("ai_messages")
      .select("*")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .limit(200);

    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, history: (data ?? []) as AiMessageRow[] });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error", error: String(e) });
  }
});

export default router;

