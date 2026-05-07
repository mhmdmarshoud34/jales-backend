import "dotenv/config";
import express from "express";
import cors from "cors";

import authRoutes from "./src/routes/authRoutes";
import userRoutes from "./src/routes/userRoutes";
import thresholdsRoutes from "./src/routes/thresholdsRoutes";
import { supabase } from "./src/supabase";

const app = express();

// Dev / LAN + Expo: allow any Origin while still supporting credentials (echoes request origin).
app.use(
  cors({
    origin: (_origin, cb) => cb(null, true),
    credentials: true,
  })
);
app.use(express.json());

app.get("/", (_req, res) => res.send("JALES backend is running ✅"));

app.use("/auth", authRoutes);
app.use("/", userRoutes);
app.use("/", thresholdsRoutes);

async function checkDatabaseConnection() {
  try {
    const { error } = await supabase.from("Users").select("id").limit(1);
    if (error) {
      console.error("❌ Database connection failed:", error.message);
      process.exit(1);
    } else {
      console.log("✅ Database connected successfully");
    }
  } catch (error) {
    console.error("❌ Database connection error:", error);
    process.exit(1);
  }
}

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";

checkDatabaseConnection().then(() => {
  app.listen(port, host, () => {
    console.log(`Server listening on http://${host}:${port} (reachable on your LAN at your PC IP)`);
  });
});
