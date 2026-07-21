// features/horarios/horarios.routes.ts
import { Router } from "express";
import { createHorario, deleteHorario, getHorarios, toggle } from "./horarios.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

export const HorariosRouter = Router();

HorariosRouter.post("/", authMiddleware, createHorario);
HorariosRouter.get("/:estilista_id", getHorarios); // ver nota abajo
HorariosRouter.delete("/:id", authMiddleware, deleteHorario);
HorariosRouter.patch("/:id/toggle", authMiddleware, toggle);