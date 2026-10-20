import type { Response, NextFunction } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../config/db";
import type { AuthRequest } from "./auth.middleware";

export const requireBeautyBusiness = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const localId = req.user?.localId;
  if (typeof localId !== "number" || !Number.isSafeInteger(localId) || localId <= 0) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT business_type FROM locales WHERE id = ?",
    [localId]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: "Local no encontrado" });
  }
  if (rows[0].business_type !== "BEAUTY") {
    return res.status(403).json({ error: "Acceso denegado: funcionalidad solo para BEAUTY" });
  }
  next();
};
