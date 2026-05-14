import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;

    req.user = {
      id: String(payload.sub),
      userId: String(payload.sub),
      email: payload.email ? String(payload.email) : null,
    };

    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}
