import { Router } from "express";
import { authorizeRole } from "../../../middlewares/authorizeRole";
import * as settings from "./settings.controller";

const router = Router();

router.get("/payments/settings", authorizeRole("admin"), settings.obtener);
router.put("/payments/settings", authorizeRole("admin"), settings.guardar);

export default router;
