import { Router } from "express";
import { cancelar, completar, create, createAdmin, disponibilidad, disponibilidadAdmin, getByFechaAdmin, getByFechaPublico, getByRangoAdmin, getTurnosFuturos, reprogramar } from "./turnos.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";

export const TurnosRouter = Router();

TurnosRouter.post("/", authMiddleware, requireBeautyBusiness, create);
TurnosRouter.put("/:id", authMiddleware, requireBeautyBusiness, reprogramar);
TurnosRouter.get("/", authMiddleware, requireBeautyBusiness, getByFechaAdmin);
TurnosRouter.get("/rango", authMiddleware, requireBeautyBusiness, getByRangoAdmin);
TurnosRouter.get("/publico", getByFechaPublico);
TurnosRouter.get("/disponibilidad", disponibilidad);
TurnosRouter.get("/disponibilidad/Admin", authMiddleware, requireBeautyBusiness, disponibilidadAdmin);
TurnosRouter.patch("/:id/cancelar", authMiddleware, requireBeautyBusiness, cancelar);
TurnosRouter.patch("/:id/completar", authMiddleware, requireBeautyBusiness, completar);
TurnosRouter.get("/futuros", authMiddleware, requireBeautyBusiness, getTurnosFuturos);
TurnosRouter.post("/admin", authMiddleware, requireBeautyBusiness, createAdmin);
