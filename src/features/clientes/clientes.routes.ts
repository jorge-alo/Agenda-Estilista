import { Router } from "express";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
  obtenerClientesController
} from "./clientes.controller";

const clientesRouter = Router();

clientesRouter.get(
  "/",
  authMiddleware,
  requireBeautyBusiness,
  obtenerClientesController
);

export default clientesRouter;
