import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import { DisponibilidadPetError } from "../disponibilidad/disponibilidad.service";
import { cancelarTurnoPet, completarTurnoPet, crearTurnoPet, reprogramarTurnoPet } from "./turnos.service";
import { TurnoPetError, validarCrearTurnoPet, validarReprogramarTurnoPet } from "./turnos.types";

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

export async function reprogramar(req: AuthRequest, res: Response) {
  try {
    const localId: unknown = req.user?.localId;
    if (typeof localId !== "number" || !Number.isInteger(localId) || localId < 1 || localId > 2147483647) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const rawId: unknown = req.params.id;
    if (typeof rawId !== "string" || !/^[1-9]\d*$/.test(rawId)) {
      throw new TurnoPetError(400, "PET_TURNO_INVALID_ID", "ID de turno inválido");
    }
    const turnoId = Number(rawId);
    if (!Number.isSafeInteger(turnoId) || turnoId > 2147483647) {
      throw new TurnoPetError(400, "PET_TURNO_INVALID_ID", "ID de turno inválido");
    }
    const payload = validarReprogramarTurnoPet(req.body);
    return res.status(200).json(await reprogramarTurnoPet(localId, turnoId, payload));
  } catch (error: unknown) {
    if (error instanceof TurnoPetError || error instanceof DisponibilidadPetError) {
      return res.status(error.status).json({
        error: error.status >= 500 ? "Error reprogramando turno PET" : error.message,
        code: error.code,
      });
    }
    return res.status(500).json({ error: "Error reprogramando turno PET" });
  }
}

type CambioEstadoPet = (localId: number, turnoId: number) => Promise<{ id: number; estado: "cancelado" | "completado" }>;

async function cambiarEstadoPet(req: AuthRequest, res: Response, operation: CambioEstadoPet) {
  try {
    const localId: unknown = req.user?.localId;
    if (typeof localId !== "number" || !Number.isInteger(localId) || localId < 1 || localId > 2147483647) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const rawId: unknown = req.params.id;
    if (typeof rawId !== "string" || !/^[1-9]\d*$/.test(rawId)) {
      throw new TurnoPetError(400, "PET_TURNO_INVALID_ID", "ID de turno inválido");
    }
    const turnoId = Number(rawId);
    if (!Number.isSafeInteger(turnoId) || turnoId > 2147483647) {
      throw new TurnoPetError(400, "PET_TURNO_INVALID_ID", "ID de turno inválido");
    }
    return res.status(200).json(await operation(localId, turnoId));
  } catch (error: unknown) {
    if (error instanceof TurnoPetError) {
      return res.status(error.status).json({
        error: error.status >= 500 ? "Error actualizando estado del turno PET" : error.message,
        code: error.code,
      });
    }
    return res.status(500).json({ error: "Error actualizando estado del turno PET" });
  }
}

export async function cancelar(req: AuthRequest, res: Response) {
  return cambiarEstadoPet(req, res, cancelarTurnoPet);
}

export async function completar(req: AuthRequest, res: Response) {
  return cambiarEstadoPet(req, res, completarTurnoPet);
}
