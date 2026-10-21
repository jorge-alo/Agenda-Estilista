import { Router } from "express";
import { obtener } from "./disponibilidad.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const disponibilidadRouter = Router();

disponibilidadRouter.get("/disponibilidad", authorizeRole("admin"), obtener);

export default disponibilidadRouter;
