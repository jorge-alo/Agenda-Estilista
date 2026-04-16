import { Router } from "express";
import { reservar } from "./public.controller";

export const PublicRouter = Router();

PublicRouter.post("/reservar", reservar);