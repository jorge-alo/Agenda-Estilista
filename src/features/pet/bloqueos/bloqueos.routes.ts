import { Router } from "express";
import * as bloqueos from "./bloqueos.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const bloqueosRouter = Router();
bloqueosRouter.get("/bloqueos", authorizeRole("admin"), bloqueos.listar);
bloqueosRouter.post("/bloqueos", authorizeRole("admin"), bloqueos.crear);
bloqueosRouter.patch("/bloqueos/:bloqueoId", authorizeRole("admin"), bloqueos.editar);
bloqueosRouter.delete("/bloqueos/:bloqueoId", authorizeRole("admin"), bloqueos.eliminar);
export default bloqueosRouter;
