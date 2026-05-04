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
    const { nombre, telefono, direccion, descripcion, horario_apertura, horario_cierre } = req.body;

    const updated = await configuracionService.updateConfiguracion(localId, {
      nombre,
      telefono,
      direccion,
      descripcion,
      horario_apertura,
      horario_cierre,
    });

    res.json({ message: "Configuración actualizada", data: updated });
  } catch (error: any) {
    if (error.message === "No hay campos para actualizar") {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error interno" });
  }
};