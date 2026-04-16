import { Router, Request, Response } from "express";
import { login, register } from "./auth.controller";
import { authMiddleware } from "../../middlewares/auth.middleware";
export interface AuthRequest extends Request {
  user?: any;
}


export const AuthRouter = Router();

AuthRouter.post("/register", authMiddleware, register);
AuthRouter.post("/login",  login);
AuthRouter.get("/me", authMiddleware,  (req: AuthRequest, res: Response) => {
    const nombreLocal = req.user.nombreLocal
    return res.json({
        status: "Ok",
        nombreLocal,
        telefono: req.user.telefono
    })
});
