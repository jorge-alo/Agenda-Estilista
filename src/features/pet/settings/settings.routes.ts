import { Router } from "express";
import * as settings from "./settings.controller";

const settingsRouter = Router();

settingsRouter.get("/settings", settings.obtener);
settingsRouter.put("/settings", settings.guardar);

export default settingsRouter;
