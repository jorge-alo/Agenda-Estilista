import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
export interface AuthRequest extends Request {
  user?: any;
}
export const authMiddleware = (
    req: AuthRequest,
    res: Response,
    next: NextFunction) => {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "No autorizado" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ error: "Token inválido" });
    }
};