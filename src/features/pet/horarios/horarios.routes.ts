import { Router } from "express";
import * as horarios from "./horarios.controller";

const horariosRouter = Router();
horariosRouter.get("/horarios", horarios.listar);
horariosRouter.post("/horarios", horarios.crear);
horariosRouter.patch("/horarios/:horarioId", horarios.editar);
horariosRouter.delete("/horarios/:horarioId", horarios.eliminar);
export default horariosRouter;
