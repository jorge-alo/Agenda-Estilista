import { Router } from "express";
import { obtenerTurno, reservar } from "./public.controller";

export const PublicRouter = Router();

PublicRouter.post("/reservar", reservar);
PublicRouter.get("/turno/:id", obtenerTurno); // ✅ Ruta pública limpia