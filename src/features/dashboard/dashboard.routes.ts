import { Router } from "express";

import { authMiddleware }
  from "../../middlewares/auth.middleware";

import {
  getResumenDiaController
} from "./dashboard.controller";

const dashboardRouter = Router();

dashboardRouter.get(
  "/resumen-dia",
  authMiddleware,
  getResumenDiaController
);

export default dashboardRouter;