import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { authorizeRole } from "../../middlewares/authorizeRole";
import { getConfiguracion, updateConfiguracion } from "./configuracion.controller";

const routerConfiguracion = Router();

routerConfiguracion.get("/", authMiddleware, authorizeRole("admin"), getConfiguracion);
routerConfiguracion.put("/", authMiddleware, authorizeRole("admin"), updateConfiguracion);

export default routerConfiguracion;