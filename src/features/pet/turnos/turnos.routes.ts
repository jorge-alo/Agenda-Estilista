import { Router } from "express";
import { authorizeRole } from "../../../middlewares/authorizeRole";
import { crear, reprogramar } from "./turnos.controller";

const turnosRouter = Router();

// authMiddleware and requirePetBusiness are already applied in pet.routes.ts.
turnosRouter.post("/turnos", authorizeRole("admin"), crear);
turnosRouter.patch("/turnos/:id/reprogramar", authorizeRole("admin"), reprogramar);

export default turnosRouter;
