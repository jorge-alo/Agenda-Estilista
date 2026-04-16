import { disponibilidad } from "./disponibilidad.controller";
import { Router } from "express";

export const disponibilidadRouter = Router()

disponibilidadRouter.get("/", disponibilidad);