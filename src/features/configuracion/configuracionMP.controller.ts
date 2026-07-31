import { Response } from "express";
import { AuthRequest } from "../auth/auth.routes";
import * as configuracionMPService from "./configuracionMP.service";

export const configurarMP = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user.localId;
    const { mp_access_token } = req.body;

    // Validar formato del token
    if (!mp_access_token || !mp_access_token.startsWith("APP_USR-")) {
      return res.status(400).json({
        error:
          "El Access Token debe comenzar con 'APP_USR-'. Asegurate de copiar el token de PRODUCCIÓN de Mercado Pago.",
      });
    }

    // Validar que el token sea válido contra MP
    const esValido = await configuracionMPService.validarTokenMP(mp_access_token);
    if (!esValido) {
      return res.status(400).json({
        error:
          "El Access Token es inválido. Verificá que lo hayas copiado correctamente desde tu cuenta de Mercado Pago.",
      });
    }

    // Guardar en la BD
    await configuracionMPService.guardarTokenMP(localId, mp_access_token);

    res.json({ message: "Token de Mercado Pago configurado correctamente" });
  } catch (error: any) {
    console.error("Error configurando MP:", error);
    res.status(500).json({ error: "Error interno" });
  }
};

export const obtenerEstadoMP = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user.localId;
    const estado = await configuracionMPService.obtenerEstadoMP(localId);
    res.json(estado);
  } catch (error: any) {
    console.error("Error obteniendo estado MP:", error);
    res.status(500).json({ error: "Error interno" });
  }
};