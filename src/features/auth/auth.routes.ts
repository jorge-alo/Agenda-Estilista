import { Router, Request, Response } from "express";
import { forgotPassword, login, resetPassword } from "./auth.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
import rateLimit from "express-rate-limit";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // máximo 5 intentos por IP en ese lapso
  message: { error: "Demasiados intentos. Probá de nuevo en unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 3, // máximo 3 intentos
  message: { error: "Demasiados intentos. Por favor, espera 15 minutos." }
});

export interface AuthRequest extends Request {
    user?: any;
}


export const AuthRouter = Router();

AuthRouter.post("/login", loginLimiter, login);
AuthRouter.get("/me", authMiddleware, (req: AuthRequest, res: Response) => {
    const nombreLocal = req.user.nombreLocal
    return res.json({
        status: "Ok",
        nombreLocal,
        telefono: req.user.telefono,
        localId: req.user.localId,
    })
});

AuthRouter.post("/forgot-password", forgotPasswordLimiter, forgotPassword);
AuthRouter.post("/reset-password", resetPassword);
