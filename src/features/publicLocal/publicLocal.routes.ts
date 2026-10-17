import { Router } from "express";
import { obtenerContextoLocal } from "./publicLocal.controller";

const publicLocalRouter = Router();

publicLocalRouter.get("/:slug", obtenerContextoLocal);

export default publicLocalRouter;
