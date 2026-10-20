import { Router } from "express";
import * as extras from "./extras.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const extrasRouter = Router();

extrasRouter.get("/extras", authorizeRole("admin"), extras.listarCatalogo);
extrasRouter.post("/extras", authorizeRole("admin"), extras.crearExtra);
extrasRouter.patch("/extras/:extraId", authorizeRole("admin"), extras.editarExtra);
extrasRouter.delete("/extras/:extraId", authorizeRole("admin"), extras.eliminarExtra);

extrasRouter.get("/mascotas/:mascotaId/extras", authorizeRole("admin"), extras.listarConfigurados);
extrasRouter.post("/mascotas/:mascotaId/extras", authorizeRole("admin"), extras.asignarExtra);
extrasRouter.patch("/mascotas/:mascotaId/extras/:extraId", authorizeRole("admin"), extras.editarDuracion);
extrasRouter.delete("/mascotas/:mascotaId/extras/:extraId", authorizeRole("admin"), extras.quitarExtra);

export default extrasRouter;
