import { Router } from "express";
import { obtener } from "./disponibilidad.controller";

const disponibilidadRouter = Router();

disponibilidadRouter.get("/disponibilidad", obtener);

export default disponibilidadRouter;
