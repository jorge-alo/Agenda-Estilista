import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import { DisponibilidadPetError } from "../disponibilidad/disponibilidad.service";
import { crearTurnoPet } from "./turnos.service";
import { TurnoPetError, validarCrearTurnoPet } from "./turnos.types";

export async function crear(req: AuthRequest, res: Response) {
  try {
    const localId: unknown = req.user?.localId;
    if (typeof localId !== "number" || !Number.isInteger(localId) || localId < 1 || localId > 2147483647) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const payload = validarCrearTurnoPet(req.body);
    return res.status(201).json(await crearTurnoPet(localId, payload));
  } catch (error: unknown) {
    if (error instanceof TurnoPetError || error instanceof DisponibilidadPetError) {
      return res.status(error.status).json({
        error: error.status >= 500 ? "Error creando turno PET" : error.message,
        code: error.code,
      });
    }
    return res.status(500).json({ error: "Error creando turno PET" });
  }
}
