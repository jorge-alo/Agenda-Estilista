import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requirePetBusiness } from "../../middlewares/requirePetBusiness";
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

petRouter.post("/mascotas", crearMascota);
petRouter.get("/mascotas", listarMascotas);
petRouter.get("/mascotas/:id", obtenerMascota);
petRouter.patch("/mascotas/:id", editarMascota);

petRouter.post("/responsables", crearResponsable);

petRouter.post("/mascotas/:mascotaId/responsables", asociarResponsable);
petRouter.delete("/mascotas/:mascotaId/responsables/:clienteId", desasociarResponsable);

export default petRouter;