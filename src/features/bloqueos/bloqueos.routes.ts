import { Router } from "express";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
  crearBloqueoController,
  obtenerBloqueosController
} from "./bloqueos.controller";

const bloqueosRouter = Router();

bloqueosRouter.post(
  "/",
  authMiddleware,
  crearBloqueoController
);

bloqueosRouter.get(
  "/",
  authMiddleware,
  obtenerBloqueosController
);

export default bloqueosRouter;