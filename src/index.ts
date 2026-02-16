import "dotenv/config";
import express from "express";
import cors from "cors";

import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import thresholdsRoutes from "./routes/thresholdsRoutes";
import { supabase } from "./supabase";

const app = express();

app.use(cors({ origin: true, credentials: true }));
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

checkDatabaseConnection().then(() => {
  app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
});
