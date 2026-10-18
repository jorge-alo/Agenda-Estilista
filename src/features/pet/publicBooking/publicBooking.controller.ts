import type { NextFunction, Request, Response } from "express";
import { crearReservaPublica, obtenerDisponibilidadPublica, obtenerOpcionesReserva } from "./publicBooking.service";
import { PublicBookingError, validarConsultaDisponibilidadPublica, validarCreacionPublica, validarMascotaId } from "./publicBooking.types";

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

export async function disponibilidad(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  try {
    const context = req.petSession;
    if (!context) {
      res.status(401).json({ error: "PET_SESSION_INVALID" });
      return;
    }
    const consulta = validarConsultaDisponibilidadPublica(req.body);
    const resultado = await obtenerDisponibilidadPublica(context.localId, context.clienteId, consulta);
    res.status(200).json(resultado);
  } catch (error: unknown) {
    if (error instanceof PublicBookingError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    next(error);
  }
}

export async function crear(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set("Cache-Control", "no-store");
  try {
    const context = req.petSession;
    const slug = req.params.slug;
    if (!context || typeof slug !== "string") {
      res.status(401).json({ error: "PET_SESSION_INVALID" });
      return;
    }
    const seleccion = validarCreacionPublica(req.body);
    const turno = await crearReservaPublica(context, slug, seleccion);
    res.status(201).json(turno);
  } catch (error: unknown) {
    if (error instanceof PublicBookingError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    next(error);
  }
}
