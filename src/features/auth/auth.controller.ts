import { Request, Response } from "express";
import jwt from "jsonwebtoken"
import dotenv from 'dotenv'
dotenv.config();
import * as authService from "./auth.service"

export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        const user = await authService.loginUser(email, password);

        const token = jwt.sign(
            {
                userId: user.user.id,
                localId: user.user.local_id,
                rol: user.user.rol,
                nombreLocal: user.nombreLocal,
                telefono: user.telefono
            },
            (process.env.JWT_SECRET as string), // después lo movemos a .env
            { expiresIn: "8h" }
        );

        res.json({ token });
    } catch (error: any) {
        if (error.message === "Usuario bloqueado") {
            return res.status(403).json({ error: "Tu cuenta está bloqueada" });
        }
        res.status(400).json({ error: "Credenciales inválidas" });
    }
};