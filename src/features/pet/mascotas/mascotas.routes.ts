import { Router } from "express";
import {
  crearMascota,
  listarMascotas,
  obtenerMascota,
  editarMascota,
  crearResponsable,
  asociarResponsable,
  desasociarResponsable,
  editarReservaOnline,
} from "./mascotas.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const mascotasRouter = Router();

mascotasRouter.post("/mascotas", crearMascota);
mascotasRouter.get("/mascotas", listarMascotas);
mascotasRouter.get("/mascotas/:id", obtenerMascota);
mascotasRouter.patch("/mascotas/:id", editarMascota);
mascotasRouter.patch("/mascotas/:id/reserva-online", authorizeRole("admin"), editarReservaOnline);

mascotasRouter.post("/responsables", crearResponsable);

mascotasRouter.post("/mascotas/:mascotaId/responsables", asociarResponsable);
mascotasRouter.delete("/mascotas/:mascotaId/responsables/:clienteId", desasociarResponsable);

export default mascotasRouter;
