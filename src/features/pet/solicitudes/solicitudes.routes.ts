import { Router } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { authorizeRole } from "../../../middlewares/authorizeRole";
import { cambiarEstado, convertir, crear, listar } from "./solicitudes.controller";

export const solicitudesPublicRouter = Router();
const solicitudLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: req => `${ipKeyGenerator(req.ip ?? "", 56)}:${String(req.params.slug)}`,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
solicitudesPublicRouter.post("/:slug/solicitudes", solicitudLimiter, crear);

export const solicitudesAdminRouter = Router();
solicitudesAdminRouter.get("/solicitudes", authorizeRole("admin"), listar);
solicitudesAdminRouter.patch("/solicitudes/:id/estado", authorizeRole("admin"), cambiarEstado);
solicitudesAdminRouter.post("/solicitudes/:id/convertir", authorizeRole("admin"), convertir);
