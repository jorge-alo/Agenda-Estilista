import { Router } from "express";

import { asignarServicio, createServicio, desasignarServicio, getServicios, getServiciosByLocalId, getServiciosPorEstilista, removeServicio, toggleServicio } from "./servicio.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";
import { authorizeRole } from "../../middlewares/authorizeRole";



export const ServiciosRouter = Router();

ServiciosRouter.post("/", authMiddleware, requireBeautyBusiness, authorizeRole("admin"), createServicio);
ServiciosRouter.get("/", getServicios);
ServiciosRouter.get("/admin", authMiddleware, requireBeautyBusiness, authorizeRole("admin"), getServiciosByLocalId);
ServiciosRouter.post("/asignar", authMiddleware, requireBeautyBusiness, authorizeRole("admin"), asignarServicio);
ServiciosRouter.delete("/desasignar", authMiddleware, requireBeautyBusiness, authorizeRole("admin"), desasignarServicio);
ServiciosRouter.get("/estilista/:id", getServiciosPorEstilista);
ServiciosRouter.delete("/:id", authMiddleware, requireBeautyBusiness, authorizeRole("admin"), removeServicio);
ServiciosRouter.patch("/:id/toggle", authMiddleware, requireBeautyBusiness, authorizeRole("admin"), toggleServicio);
