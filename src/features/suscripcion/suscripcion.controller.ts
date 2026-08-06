import { Request, Response } from "express";
import { suscripcionService } from "./suscripcion.service";


export const crearLinkSuscripcion = async (req: Request, res: Response) => {
  try {
    const localId = (req as any).user?.localId;
    
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    // Delegamos la lógica al servicio
    const resultado = await suscripcionService.generarPreference(localId);

    res.json({ link: resultado.link });
  } catch (error: any) {
    console.error("Error creando link de suscripción:", error);
    res.status(500).json({ error: error.message || "Error al generar el link de pago" });
  }
};

export const obtenerEstadoSuscripcion = async (req: Request, res: Response) => {
  try {
    const localId = (req as any).user?.localId;
    
    if (!localId) {
      return res.status(401).json({ error: "No autorizado" });
    }

    // Delegamos la lógica al servicio
    const estado = await suscripcionService.obtenerEstado(localId);

    res.json(estado);
  } catch (error: any) {
    console.error("Error obteniendo estado de suscripción:", error);
    res.status(500).json({ error: "Error obteniendo estado" });
  }
};