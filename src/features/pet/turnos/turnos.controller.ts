import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import { DisponibilidadPetError } from "../disponibilidad/disponibilidad.service";
import { cancelarTurnoPet, completarTurnoPet, crearTurnoPet, listarTurnosPetAdmin, reprogramarTurnoPet } from "./turnos.service";
import { fechaPetValida } from "../disponibilidad/disponibilidad.types";
import { TurnoPetError, validarCrearTurnoPet, validarReprogramarTurnoPet, type ConsultaListadoTurnosPet } from "./turnos.types";

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

function parsearConsultaListado(raw: unknown): ConsultaListadoTurnosPet {
  const fail = () => new TurnoPetError(400, "PET_TURNOS_INVALID_QUERY", "Use fecha o el rango desde/hasta con fechas YYYY-MM-DD válidas");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
  const query = raw as Record<string, unknown>;
  const keys = Object.keys(query);
  if (keys.length === 0 || keys.some(key => !["fecha", "desde", "hasta"].includes(key))) throw fail();

  if (Object.prototype.hasOwnProperty.call(query, "fecha")) {
    if (keys.length !== 1 || !fechaPetValida(query.fecha)) throw fail();
    return { fecha: query.fecha };
  }

  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(query, "desde")
    || !Object.prototype.hasOwnProperty.call(query, "hasta")
    || !fechaPetValida(query.desde) || !fechaPetValida(query.hasta)
    || query.desde > query.hasta) throw fail();
  return { desde: query.desde, hasta: query.hasta };
}

export async function listar(req: AuthRequest, res: Response) {
  try {
    const localId: unknown = req.user?.localId;
    if (typeof localId !== "number" || !Number.isInteger(localId) || localId < 1 || localId > 2147483647) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const consulta = parsearConsultaListado(req.query);
    return res.json(await listarTurnosPetAdmin(localId, consulta));
  } catch (error: unknown) {
    if (error instanceof TurnoPetError) {
      return res.status(error.status).json({ error: error.status >= 500 ? "Error listando turnos PET" : error.message, code: error.code });
    }
    return res.status(500).json({ error: "Error listando turnos PET" });
  }
}
