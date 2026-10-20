import { Router } from "express";
import * as servicios from "./servicios.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const serviciosRouter = Router();

serviciosRouter.get("/servicios", authorizeRole("admin"), servicios.listarCatalogo);
serviciosRouter.get("/mascotas/:mascotaId/servicios", authorizeRole("admin"), servicios.listarConfigurados);
serviciosRouter.post("/mascotas/:mascotaId/servicios", authorizeRole("admin"), servicios.asignarServicio);
serviciosRouter.patch("/mascotas/:mascotaId/servicios/:servicioId", authorizeRole("admin"), servicios.editarDuracion);
serviciosRouter.delete("/mascotas/:mascotaId/servicios/:servicioId", authorizeRole("admin"), servicios.quitarServicio);

export default serviciosRouter;
