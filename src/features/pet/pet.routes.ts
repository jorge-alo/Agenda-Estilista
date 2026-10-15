import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requirePetBusiness } from "../../middlewares/requirePetBusiness";
import serviciosRouter from "./servicios/servicios.routes";
import mascotasRouter from "./mascotas/mascotas.routes";
import extrasRouter from "./extras/extras.routes";
import horariosRouter from "./horarios/horarios.routes";
import bloqueosRouter from "./bloqueos/bloqueos.routes";

const petRouter = Router();

petRouter.use(authMiddleware);
petRouter.use(requirePetBusiness);

petRouter.use(serviciosRouter);
petRouter.use(mascotasRouter);
petRouter.use(extrasRouter);
petRouter.use(horariosRouter);
petRouter.use(bloqueosRouter);

export default petRouter;
