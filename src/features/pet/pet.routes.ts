import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requirePetBusiness } from "../../middlewares/requirePetBusiness";
import * as servicios from "./pet-servicios.controller";
import {
  crearMascota,
  listarMascotas,
  obtenerMascota,
  editarMascota,
  crearResponsable,
  asociarResponsable,
  desasociarResponsable,
} from "./pet.controller";

const petRouter = Router();

petRouter.use(authMiddleware);
petRouter.use(requirePetBusiness);

petRouter.get("/servicios", servicios.listarCatalogo);
petRouter.get("/mascotas/:mascotaId/servicios", servicios.listarConfigurados);
petRouter.post("/mascotas/:mascotaId/servicios", servicios.asignarServicio);
petRouter.patch("/mascotas/:mascotaId/servicios/:servicioId", servicios.editarDuracion);
petRouter.delete("/mascotas/:mascotaId/servicios/:servicioId", servicios.quitarServicio);

petRouter.post("/mascotas", crearMascota);
petRouter.get("/mascotas", listarMascotas);
petRouter.get("/mascotas/:id", obtenerMascota);
petRouter.patch("/mascotas/:id", editarMascota);

petRouter.post("/responsables", crearResponsable);

petRouter.post("/mascotas/:mascotaId/responsables", asociarResponsable);
petRouter.delete("/mascotas/:mascotaId/responsables/:clienteId", desasociarResponsable);

export default petRouter;
