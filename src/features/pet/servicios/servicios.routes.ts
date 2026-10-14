import { Router } from "express";
import * as servicios from "./servicios.controller";

const serviciosRouter = Router();

serviciosRouter.get("/servicios", servicios.listarCatalogo);
serviciosRouter.get("/mascotas/:mascotaId/servicios", servicios.listarConfigurados);
serviciosRouter.post("/mascotas/:mascotaId/servicios", servicios.asignarServicio);
serviciosRouter.patch("/mascotas/:mascotaId/servicios/:servicioId", servicios.editarDuracion);
serviciosRouter.delete("/mascotas/:mascotaId/servicios/:servicioId", servicios.quitarServicio);

export default serviciosRouter;
