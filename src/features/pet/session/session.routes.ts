import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { requestAccess } from "./session.controller";

export const petSessionPublicRouter = Router();
const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: req => `${ipKeyGenerator(req.ip ?? "", 56)}:${String(req.params.slug)}`,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intentá nuevamente más tarde." },
});

petSessionPublicRouter.post("/:slug/session/request", requestLimiter, requestAccess);
