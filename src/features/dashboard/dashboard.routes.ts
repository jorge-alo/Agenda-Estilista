import { Router } from "express";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
    getHistorialClientesController,
  getReporteMensualController,
  getResumenDiaController
} from "./dashboard.controller";

const dashboardRouter = Router();
dashboardRouter.use(authMiddleware, requireBeautyBusiness);

dashboardRouter.get(
  "/resumen-dia",
  getResumenDiaController
);

dashboardRouter.get(
  "/clientes",
  getHistorialClientesController
);

dashboardRouter.get(
  "/reporte-mensual",
  getReporteMensualController
);

export default dashboardRouter;
