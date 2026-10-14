import { pool } from "../config/db";
import { AuthRequest } from "./auth.middleware";
import { Response, NextFunction } from "express";

export const requirePetBusiness = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const localId = req.user?.localId;

  if (!localId) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const [rows]: any = await pool.query(
    "SELECT business_type FROM locales WHERE id = ?",
    [localId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: "Local no encontrado" });
  }

  if (rows[0].business_type !== "PET_GROOMING") {
    return res.status(403).json({ error: "Acceso denegado: funcionalidad solo para PET_GROOMING" });
  }

  next();
};