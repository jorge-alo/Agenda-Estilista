import { Router } from "express";
import * as horarios from "./horarios.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const horariosRouter = Router();
horariosRouter.get("/horarios", authorizeRole("admin"), horarios.listar);
horariosRouter.post("/horarios", authorizeRole("admin"), horarios.crear);
horariosRouter.patch("/horarios/:horarioId", authorizeRole("admin"), horarios.editar);
horariosRouter.delete("/horarios/:horarioId", authorizeRole("admin"), horarios.eliminar);
export default horariosRouter;
