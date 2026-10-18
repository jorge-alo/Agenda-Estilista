import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { consumeAccess, getSessionMe, logoutSession, requestAccess } from "./session.controller";
import { petPublicSessionMiddleware } from "./petPublicSession.middleware";

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

const consumeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: req => `${ipKeyGenerator(req.ip ?? "", 56)}:${String(req.params.slug)}`,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intentá nuevamente más tarde." },
});

petSessionPublicRouter.post("/:slug/session/consume", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, consumeLimiter, consumeAccess);

petSessionPublicRouter.get("/:slug/session/me", petPublicSessionMiddleware, getSessionMe);
petSessionPublicRouter.post("/:slug/session/logout", logoutSession);
