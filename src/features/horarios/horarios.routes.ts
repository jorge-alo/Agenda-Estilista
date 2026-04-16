// features/horarios/horarios.routes.ts
import { Router } from "express";
import { createHorario, deleteHorario, getHorarios, toggle } from "./horarios.controller";

export const HorariosRouter = Router();

HorariosRouter.post("/", createHorario);
HorariosRouter.get("/:estilista_id", getHorarios);
HorariosRouter.delete("/:id", deleteHorario);
HorariosRouter.patch("/:id/toggle", toggle);