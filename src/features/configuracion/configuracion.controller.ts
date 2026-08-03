import { Response } from "express";
import { AuthRequest } from "../auth/auth.routes";
import * as configuracionService from "./configuracion.service";

export const getConfiguracion = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user.localId;
    const config = await configuracionService.getConfiguracion(localId);
    res.json(config);
  } catch (error: any) {
    res.status(500).json({ error: "Error interno" });
  }
};

export const updateConfiguracion = async (req: AuthRequest, res: Response) => {
  try {
    const localId = req.user.localId;
    const { 
      nombre, telefono, direccion, descripcion, 
      horario_apertura, horario_cierre, requiere_sena // ✅ Agregado
    } = req.body;

    const updated = await configuracionService.updateConfiguracion(localId, {
      nombre,
      telefono,
      direccion,
      descripcion,
      horario_apertura,
      horario_cierre,
      requiere_sena, // ✅ Pasado al servicio
    });

    res.json({ message: "Configuración actualizada", data: updated });
  } catch (error: any) {
    // ... tu manejo de errores existente
  }
};