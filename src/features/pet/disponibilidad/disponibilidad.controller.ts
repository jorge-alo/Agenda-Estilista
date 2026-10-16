import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware";
import { DisponibilidadPetError, obtenerDisponibilidad } from "./disponibilidad.service";
import type { ConsultaDisponibilidadPet } from "./disponibilidad.service";

const INT_MAX = 2147483647;
const QUERY_KEYS = new Set(["mascotaId", "servicioId", "fecha", "extraIds"]);

function errorQuery(message: string): DisponibilidadPetError {
  return new DisponibilidadPetError(400, "PET_AVAILABILITY_INVALID_QUERY", message);
}

function enteroId(value: unknown, nombre: string): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw errorQuery(`${nombre} debe ser un entero positivo`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > INT_MAX) throw errorQuery(`${nombre} está fuera de rango`);
  return number;
}

function scalar(query: Record<string, unknown>, nombre: "mascotaId" | "servicioId" | "fecha"): string {
  const value = query[nombre];
  if (typeof value !== "string" || value.length === 0) throw errorQuery(`${nombre} es obligatorio y debe aparecer una sola vez`);
  return value;
}

function fechaReal(value: string): string {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw errorQuery("fecha debe usar YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw errorQuery("fecha no existe en el calendario");
  }
  return value;
}

function parsearQuery(raw: unknown): ConsultaDisponibilidadPet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw errorQuery("Query inválida");
  const query = raw as Record<string, unknown>;
  if (Object.keys(query).some(key => !QUERY_KEYS.has(key))) throw errorQuery("Hay parámetros no permitidos");

  const mascotaId = enteroId(scalar(query, "mascotaId"), "mascotaId");
  const servicioId = enteroId(scalar(query, "servicioId"), "servicioId");
  const fecha = fechaReal(scalar(query, "fecha"));
  const rawExtras = query.extraIds === undefined ? [] : Array.isArray(query.extraIds) ? query.extraIds : [query.extraIds];
  const extraIds = rawExtras.map(value => enteroId(value, "extraIds"));
  if (new Set(extraIds).size !== extraIds.length) throw errorQuery("extraIds no puede contener duplicados");
  return { mascotaId, servicioId, fecha, extraIds };
}

function localDelJwt(req: AuthRequest): number {
  const localId: unknown = req.user?.localId;
  if (typeof localId !== "number" || !Number.isSafeInteger(localId) || localId < 1 || localId > INT_MAX) {
    throw new DisponibilidadPetError(401, "UNAUTHORIZED", "No autorizado");
  }
  return localId;
}

export async function obtener(req: AuthRequest, res: Response) {
  try {
    const localId = localDelJwt(req);
    const consulta = parsearQuery(req.query);
    return res.json(await obtenerDisponibilidad(localId, consulta));
  } catch (error: unknown) {
    if (error instanceof DisponibilidadPetError) {
      const message = error.status >= 500 ? "Error calculando disponibilidad PET" : error.message;
      return res.status(error.status).json({ error: message, code: error.code });
    }
    return res.status(500).json({ error: "Error calculando disponibilidad PET", code: "PET_AVAILABILITY_ERROR" });
  }
}
