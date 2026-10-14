import { Router } from "express";
import {
  crearMascota,
  listarMascotas,
  obtenerMascota,
  editarMascota,
  crearResponsable,
  asociarResponsable,
  desasociarResponsable,
} from "./mascotas.controller";

const mascotasRouter = Router();

mascotasRouter.post("/mascotas", crearMascota);
mascotasRouter.get("/mascotas", listarMascotas);
mascotasRouter.get("/mascotas/:id", obtenerMascota);
mascotasRouter.patch("/mascotas/:id", editarMascota);

mascotasRouter.post("/responsables", crearResponsable);

mascotasRouter.post("/mascotas/:mascotaId/responsables", asociarResponsable);
mascotasRouter.delete("/mascotas/:mascotaId/responsables/:clienteId", desasociarResponsable);

export default mascotasRouter;
