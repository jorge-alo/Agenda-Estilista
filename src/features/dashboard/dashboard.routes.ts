import { Router } from "express";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
    getHistorialClientesController,
  getReporteMensualController,
  getResumenDiaController
} from "./dashboard.controller";

const dashboardRouter = Router();

dashboardRouter.get(
  "/resumen-dia",
  authMiddleware,
  getResumenDiaController
);

dashboardRouter.get(
  "/clientes",
  authMiddleware,
  getHistorialClientesController
);

dashboardRouter.get(
  "/reporte-mensual",
  authMiddleware,
  getReporteMensualController
);

export default dashboardRouter;