import { Router } from "express";
import { cancelar, completar, create, createAdmin, disponibilidad, disponibilidadAdmin, getByFechaAdmin, getByFechaPublico, getByRangoAdmin, getTurnosFuturos, reprogramar } from "./turnos.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

export const TurnosRouter = Router();

TurnosRouter.post("/", authMiddleware, create);
TurnosRouter.put("/:id", authMiddleware, reprogramar);
TurnosRouter.get("/", authMiddleware, getByFechaAdmin);
TurnosRouter.get("/rango", authMiddleware, getByRangoAdmin);  
TurnosRouter.get("/publico", getByFechaPublico);
TurnosRouter.get("/disponibilidad", disponibilidad);
TurnosRouter.get("/disponibilidad/Admin", authMiddleware, disponibilidadAdmin);
TurnosRouter.patch("/:id/cancelar", authMiddleware, cancelar);
TurnosRouter.patch("/:id/completar", authMiddleware, completar);
TurnosRouter.get("/futuros", authMiddleware, getTurnosFuturos);
TurnosRouter.post("/admin", authMiddleware, createAdmin);
