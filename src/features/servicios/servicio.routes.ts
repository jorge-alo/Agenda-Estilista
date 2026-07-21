import { Router } from "express";

import { asignarServicio, createServicio, desasignarServicio, getServicios, getServiciosByLocalId, getServiciosPorEstilista, removeServicio, toggleServicio } from "./servicio.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";



export const ServiciosRouter = Router();

ServiciosRouter.post("/", authMiddleware, createServicio);
ServiciosRouter.get("/", getServicios);
ServiciosRouter.get("/admin", authMiddleware, getServiciosByLocalId);
ServiciosRouter.post("/asignar", authMiddleware, asignarServicio);
ServiciosRouter.delete("/desasignar", authMiddleware, desasignarServicio);
ServiciosRouter.get("/estilista/:id", getServiciosPorEstilista);
ServiciosRouter.delete("/:id", authMiddleware, removeServicio);
ServiciosRouter.patch("/:id/toggle", authMiddleware, toggleServicio);
