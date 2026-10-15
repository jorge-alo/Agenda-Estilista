import { Router } from "express";
import * as bloqueos from "./bloqueos.controller";

const bloqueosRouter = Router();
bloqueosRouter.get("/bloqueos", bloqueos.listar);
bloqueosRouter.post("/bloqueos", bloqueos.crear);
bloqueosRouter.patch("/bloqueos/:bloqueoId", bloqueos.editar);
bloqueosRouter.delete("/bloqueos/:bloqueoId", bloqueos.eliminar);
export default bloqueosRouter;
