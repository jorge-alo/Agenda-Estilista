import { Router } from "express";
import { authorizeRole } from "../../../middlewares/authorizeRole";
import { crear } from "./turnos.controller";

const turnosRouter = Router();

// authMiddleware and requirePetBusiness are already applied in pet.routes.ts.
turnosRouter.post("/turnos", authorizeRole("admin"), crear);

export default turnosRouter;
