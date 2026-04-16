import { Request, Response } from "express";
import jwt from "jsonwebtoken"
import dotenv from 'dotenv'
dotenv.config();
import * as authService from "./auth.service"

export const register = async (req: Request, res: Response) => {

    console.log("🔥 REGISTER HIT");
    console.log("BODY:", req.body);
    try {
        const { email, password, nombreLocal, telefono } = req.body;
        console.log("Valor de req.body", req.body);
        
        const userId = await authService.registerUser(
            email,
            password,
            nombreLocal, 
            telefono
        );

        res.json({ status: "Ok", message: "Usuario creado", userId });
    } catch (error: any) {
        if (error.message === "El email ya está registrado") {
            return res.status(400).json({ error: error.message });
        }

        // error de MySQL (duplicate)
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({ error: "El email ya existe" });
        }

        res.status(500).json({ error: "Error interno" });
    }
};

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
    } catch (error) {
        res.status(400).json({ error: "Credenciales inválidas" });
    }
};