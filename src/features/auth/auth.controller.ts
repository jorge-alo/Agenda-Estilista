import { Request, Response } from "express";
import jwt from "jsonwebtoken"
import dotenv from 'dotenv'
dotenv.config();
import * as authService from "./auth.service"
import type { AuthRequest } from "../../middlewares/auth.middleware";

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

export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });

    await authService.requestPasswordReset(email);
    
    // Siempre respondemos 200 OK por seguridad (previene enumeración de usuarios)
    res.json({ message: "Si el correo está registrado, recibirás un enlace de recuperación." });
  } catch (error) {
    res.status(500).json({ error: "Error al procesar la solicitud" });
  }
};

// ✅ NUEVO: Controlador para guardar la nueva contraseña
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token y nueva contraseña son requeridos" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
    }

    await authService.resetPassword(token, newPassword);
    res.json({ message: "Contraseña actualizada correctamente" });
  } catch (error: any) {
    if (error.message === "Token inválido o expirado") {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error al restablecer la contraseña" });
  }
};

export const me = async (req: AuthRequest, res: Response) => {
  const localId: unknown = req.user?.localId;
  let businessType = null;

  if (localId !== null && localId !== undefined) {
    if (typeof localId !== "number" || !Number.isSafeInteger(localId) || localId < 1 || localId > 2147483647) {
      return res.status(401).json({ error: "Token inválido" });
    }
    try {
      businessType = await authService.getBusinessTypeForLocal(localId);
    } catch (error: unknown) {
      if (error instanceof authService.AuthMeError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      return res.status(500).json({ error: "Error obteniendo contexto del local" });
    }
  }

  return res.json({
    status: "Ok",
    nombreLocal: req.user?.nombreLocal,
    telefono: req.user?.telefono,
    localId,
    businessType,
  });
};
