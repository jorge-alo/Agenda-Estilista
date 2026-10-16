import { Router } from "express";
import { authorizeRole } from "../../../middlewares/authorizeRole";
import { cancelar, completar, crear, reprogramar } from "./turnos.controller";

const turnosRouter = Router();

// authMiddleware and requirePetBusiness are already applied in pet.routes.ts.
turnosRouter.post("/turnos", authorizeRole("admin"), crear);
turnosRouter.patch("/turnos/:id/reprogramar", authorizeRole("admin"), reprogramar);
turnosRouter.patch("/turnos/:id/cancelar", authorizeRole("admin"), cancelar);
turnosRouter.patch("/turnos/:id/completar", authorizeRole("admin"), completar);

export default turnosRouter;
