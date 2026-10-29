import { Router } from "express";
import * as settings from "./settings.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const settingsRouter = Router();

settingsRouter.get("/settings", authorizeRole("admin"), settings.obtener);
settingsRouter.put("/settings", authorizeRole("admin"), settings.guardar);
settingsRouter.put("/settings/capacity", authorizeRole("admin"), settings.guardarCapacidad);

export default settingsRouter;
