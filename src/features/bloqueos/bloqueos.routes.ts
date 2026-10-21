import { Router } from "express";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
  crearBloqueoController,
  eliminarBloqueoController,
  obtenerBloqueosController
} from "./bloqueos.controller";

const bloqueosRouter = Router();
// Every operation in this legacy family belongs to BEAUTY.
bloqueosRouter.use(authMiddleware, requireBeautyBusiness);

bloqueosRouter.post(
  "/",
  crearBloqueoController
);

bloqueosRouter.get(
  "/",
  obtenerBloqueosController
);

bloqueosRouter.delete(
  "/:id",
  eliminarBloqueoController
);
export default bloqueosRouter;
