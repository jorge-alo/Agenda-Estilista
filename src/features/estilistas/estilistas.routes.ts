import { Router } from "express";
import { create, getEstilistas, getEstilistasAdmin, remove, update } from "./estilistas.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireBeautyBusiness } from "../../middlewares/requireBeautyBusiness";

export const EstilistasRouter = Router();

EstilistasRouter.use("/admin", authMiddleware, requireBeautyBusiness);
EstilistasRouter.post("/admin", create);
EstilistasRouter.get("/", getEstilistas);
EstilistasRouter.get("/admin", getEstilistasAdmin);
EstilistasRouter.put("/admin/:id", update);
EstilistasRouter.delete("/admin/:id", remove);
