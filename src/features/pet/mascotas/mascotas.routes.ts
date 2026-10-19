import { Router } from "express";
import {
  crearMascota,
  listarMascotas,
  buscarMascotas,
  obtenerMascota,
  editarMascota,
  crearResponsable,
  asociarResponsable,
  desasociarResponsable,
  editarReservaOnline,
} from "./mascotas.controller";
import { authorizeRole } from "../../../middlewares/authorizeRole";

const mascotasRouter = Router();

mascotasRouter.post("/mascotas", authorizeRole("admin"), crearMascota);
mascotasRouter.get("/mascotas", authorizeRole("admin"), listarMascotas);
mascotasRouter.get("/mascotas/search", authorizeRole("admin"), buscarMascotas);
mascotasRouter.get("/mascotas/:id", authorizeRole("admin"), obtenerMascota);
mascotasRouter.patch("/mascotas/:id", authorizeRole("admin"), editarMascota);
mascotasRouter.patch("/mascotas/:id/reserva-online", authorizeRole("admin"), editarReservaOnline);

mascotasRouter.post("/responsables", authorizeRole("admin"), crearResponsable);

mascotasRouter.post("/mascotas/:mascotaId/responsables", authorizeRole("admin"), asociarResponsable);
mascotasRouter.delete("/mascotas/:mascotaId/responsables/:clienteId", authorizeRole("admin"), desasociarResponsable);

export default mascotasRouter;
