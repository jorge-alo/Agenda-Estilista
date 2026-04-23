import { Request, Response, NextFunction } from "express";

export const authorizeRole = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const user = (req as any).user; // lo pone el middleware JWT que ya tenés

        if (!user || !roles.includes(user.rol)) {
            return res.status(403).json({ error: "Acceso denegado" });
        }

        // Normalizamos rol por si viene como string[]
        const rol = Array.isArray(user.rol) ? user.rol[0] : user.rol;
        if (!roles.includes(rol)) {
            return res.status(403).json({ error: "Acceso denegado" });
        }
        next();
    };
};