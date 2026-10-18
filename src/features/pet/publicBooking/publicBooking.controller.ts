import type { NextFunction, Request, Response } from "express";
import { obtenerOpcionesReserva } from "./publicBooking.service";
import { PublicBookingError, validarMascotaId } from "./publicBooking.types";

export async function obtener(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  try {
    const context = req.petSession;
    if (!context) {
      res.status(401).json({ error: "PET_SESSION_INVALID" });
      return;
    }
    const mascotaId = validarMascotaId(req.params.mascotaId);
    const opciones = await obtenerOpcionesReserva(context.localId, context.clienteId, mascotaId);
    res.status(200).json(opciones);
  } catch (error: unknown) {
    if (error instanceof PublicBookingError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    next(error);
  }
}
