import { Router } from "express";
import * as extras from "./extras.controller";

const extrasRouter = Router();

extrasRouter.get("/extras", extras.listarCatalogo);
extrasRouter.post("/extras", extras.crearExtra);
extrasRouter.patch("/extras/:extraId", extras.editarExtra);
extrasRouter.delete("/extras/:extraId", extras.eliminarExtra);

extrasRouter.get("/mascotas/:mascotaId/extras", extras.listarConfigurados);
extrasRouter.post("/mascotas/:mascotaId/extras", extras.asignarExtra);
extrasRouter.patch("/mascotas/:mascotaId/extras/:extraId", extras.editarDuracion);
extrasRouter.delete("/mascotas/:mascotaId/extras/:extraId", extras.quitarExtra);

export default extrasRouter;
