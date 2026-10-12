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
  } catch (error: unknown) {
    const status = typeof error === "object" && error !== null
      && "status" in error && typeof error.status === "number" ? error.status : undefined;
    console.error("Error creando link de suscripción:", { status });
    res.status(500).json({ error: "Error al generar el link de pago de suscripción" });
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
  } catch (error: unknown) {
    const status = typeof error === "object" && error !== null
      && "status" in error && typeof error.status === "number" ? error.status : undefined;
    console.error("Error obteniendo estado de suscripción:", { status });
    res.status(500).json({ error: "Error obteniendo estado" });
  }
};
