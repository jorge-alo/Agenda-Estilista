import { Router } from "express";
import { create, getEstilistas, getEstilistasAdmin, remove, update } from "./estilistas.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";

export const EstilistasRouter = Router();

EstilistasRouter.post("/admin", authMiddleware, create);
EstilistasRouter.get("/", getEstilistas);
EstilistasRouter.get("/admin", authMiddleware, getEstilistasAdmin);
EstilistasRouter.put("/admin/:id", authMiddleware, update);
EstilistasRouter.delete("/admin/:id", authMiddleware, remove);