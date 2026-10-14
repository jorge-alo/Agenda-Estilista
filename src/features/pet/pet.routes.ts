import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requirePetBusiness } from "../../middlewares/requirePetBusiness";
import serviciosRouter from "./servicios/servicios.routes";
import mascotasRouter from "./mascotas/mascotas.routes";

const petRouter = Router();

petRouter.use(authMiddleware);
petRouter.use(requirePetBusiness);

petRouter.use(serviciosRouter);
petRouter.use(mascotasRouter);

export default petRouter;
