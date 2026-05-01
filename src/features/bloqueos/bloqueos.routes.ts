import { Router } from "express";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
  crearBloqueoController,
  eliminarBloqueoController,
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

bloqueosRouter.delete(
  "/:id",
  authMiddleware,
  eliminarBloqueoController
);
export default bloqueosRouter;