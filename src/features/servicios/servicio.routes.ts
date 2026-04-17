import { Router } from "express";

import { asignarServicio, createServicio, desasignarServicio, getServicios, getServiciosByLocalId, getServiciosPorEstilista, removeServicio, toggleServicio } from "./servicio.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";



export const ServiciosRouter = Router();

ServiciosRouter.post("/", authMiddleware, createServicio);
ServiciosRouter.get("/", getServicios);
ServiciosRouter.get("/admin", authMiddleware, getServiciosByLocalId);
ServiciosRouter.post("/asignar", asignarServicio);
ServiciosRouter.delete("/desasignar", desasignarServicio);
ServiciosRouter.get("/estilista/:id", getServiciosPorEstilista);
ServiciosRouter.delete("/:id", authMiddleware, removeServicio);
ServiciosRouter.patch("/:id/toggle", toggleServicio);
