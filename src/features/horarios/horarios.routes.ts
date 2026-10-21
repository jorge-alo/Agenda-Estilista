// features/horarios/horarios.routes.ts
import { Router } from "express";
import { createHorario, deleteHorario, getHorarios, toggle } from "./horarios.controller";
import { authMiddleware, type AuthRequest } from "../../middlewares/auth.middleware";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";

export const HorariosRouter = Router();

HorariosRouter.post("/", authMiddleware, requireBeautyBusiness, createHorario);
// Authorization always wins over slug: an invalid/PET JWT cannot fall back to public access.
HorariosRouter.get("/:estilista_id", (req, res, next) => {
  if (req.headers.authorization) return authMiddleware(req, res, next);
  if (typeof req.query.slug !== "string" || !req.query.slug.trim()) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}, (req: AuthRequest, res, next) => {
  if (req.user) return requireBeautyBusiness(req, res, next);
  next();
}, getHorarios);
HorariosRouter.delete("/:id", authMiddleware, requireBeautyBusiness, deleteHorario);
HorariosRouter.patch("/:id/toggle", authMiddleware, requireBeautyBusiness, toggle);
