import { Router } from "express";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
  obtenerClientesController
} from "./clientes.controller";

const clientesRouter = Router();

clientesRouter.get(
  "/",
  authMiddleware,
  obtenerClientesController
);

export default clientesRouter;