import { fechaPetValida } from "../disponibilidad/disponibilidad.types";
import type { ConsultaDisponibilidadPet } from "../disponibilidad/disponibilidad.service";
import type { SeleccionCreacionTurnoPet } from "../turnos/turnos.types";

const INT_MAX = 2147483647;
const MAX_EXTRAS = 100;
const CAMPOS_DISPONIBILIDAD = ["mascotaId", "servicioId", "extraIds", "fecha"];
const CAMPOS_CREACION = [...CAMPOS_DISPONIBILIDAD, "hora"];

export class PublicBookingError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function validarMascotaId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new PublicBookingError(400, "PET_BOOKING_INVALID", "mascotaId inválido");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > INT_MAX) {
    throw new PublicBookingError(400, "PET_BOOKING_INVALID", "mascotaId inválido");
  }
  return number;
}

/** Fail as an integrity error instead of silently publishing a corrupt duration. */
export function duracionPublica(value: number, campo: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Integridad PET: ${campo} con duración inválida`);
  }
  return value;
}

export interface OpcionesReservaServicio {
  id: number;
  nombre: string;
  duracionMinutos: number;
}

export interface OpcionesReservaExtra {
  id: number;
  nombre: string;
  duracionExtraMinutos: number;
}

export interface OpcionesReserva {
  servicios: OpcionesReservaServicio[];
  extras: OpcionesReservaExtra[];
}

function idBody(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= INT_MAX;
}

/**
 * Exact public body: mascotaId, servicioId, extraIds (mandatory, even empty) and fecha.
 * Any extra/missing key, invalid id, more than MAX_EXTRAS ids or duplicate ids is
 * rejected with the same 400. extraIds is normalized ascending without changing meaning.
 */
export function validarConsultaDisponibilidadPublica(body: unknown): ConsultaDisponibilidadPet {
  const fail = () => new PublicBookingError(400, "PET_BOOKING_INVALID", "Consulta de disponibilidad inválida");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail();
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== CAMPOS_DISPONIBILIDAD.length
    || CAMPOS_DISPONIBILIDAD.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
    || keys.some(key => !CAMPOS_DISPONIBILIDAD.includes(key))) throw fail();
  if (!idBody(raw.mascotaId) || !idBody(raw.servicioId)) throw fail();
  if (!Array.isArray(raw.extraIds) || raw.extraIds.length > MAX_EXTRAS || !raw.extraIds.every(idBody)) throw fail();
  if (new Set(raw.extraIds).size !== raw.extraIds.length) throw fail();
  if (!fechaPetValida(raw.fecha)) throw fail();
  return {
    mascotaId: raw.mascotaId,
    servicioId: raw.servicioId,
    extraIds: [...raw.extraIds].sort((a: number, b: number) => a - b),
    fecha: raw.fecha,
  };
}

export interface TurnoPublicoCreado {
  id: number;
  fecha: string;
  hora: string;
  horaFin: string;
  estado: "activo";
}

export function validarCreacionPublica(body: unknown): SeleccionCreacionTurnoPet {
  const fail = () => new PublicBookingError(400, "PET_BOOKING_INVALID", "Datos de reserva inválidos");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail();
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== CAMPOS_CREACION.length
    || CAMPOS_CREACION.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
    || keys.some(key => !CAMPOS_CREACION.includes(key))) throw fail();
  if (typeof raw.hora !== "string" || raw.hora.length !== 5 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.hora)) throw fail();
  if (typeof raw.fecha !== "string" || raw.fecha.length !== 10) throw fail();
  const { hora, ...consulta } = raw;
  return { ...validarConsultaDisponibilidadPublica(consulta), hora };
}
