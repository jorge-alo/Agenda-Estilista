import { horaAMinutos } from "../disponibilidad/disponibilidad.engine";
import { fechaPetValida } from "../disponibilidad/disponibilidad.types";

export interface CrearTurnoPetPayload {
  mascotaId: number;
  clienteId: number;
  servicioId: number;
  extraIds: number[];
  fecha: string;
  hora: string;
}

export interface TurnoPetCreado {
  id: number;
  fecha: string;
  hora: string;
  horaFin: string;
  estado: "activo";
  mascotaId: number;
  clienteId: number;
  servicioId: number;
}

export interface ReprogramarTurnoPetPayload {
  fecha: string;
  hora: string;
}

export interface TurnoPetReprogramado {
  id: number;
  fecha: string;
  hora: string;
  horaFin: string;
  estado: "activo";
  mascotaId: number;
  clienteId: number | null;
  servicioId: number | null;
}

export class TurnoPetError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

const campos = ["mascotaId", "clienteId", "servicioId", "extraIds", "fecha", "hora"];

function id(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

export function validarCrearTurnoPet(body: unknown): CrearTurnoPetPayload {
  const error = () => new TurnoPetError(400, "PET_TURNO_INVALID_BODY", "Datos de turno PET inválidos");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw error();
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).length !== campos.length || campos.some(key => !(key in raw))
    || Object.keys(raw).some(key => !campos.includes(key))) throw error();
  if (!id(raw.mascotaId) || !id(raw.clienteId) || !id(raw.servicioId)) throw error();
  if (!Array.isArray(raw.extraIds) || !raw.extraIds.every(id)
    || new Set(raw.extraIds).size !== raw.extraIds.length) throw error();
  if (!fechaPetValida(raw.fecha) || typeof raw.hora !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.hora)) throw error();
  horaAMinutos(raw.hora);
  return {
    mascotaId: raw.mascotaId,
    clienteId: raw.clienteId,
    servicioId: raw.servicioId,
    extraIds: raw.extraIds,
    fecha: raw.fecha,
    hora: raw.hora,
  };
}

export function validarReprogramarTurnoPet(body: unknown): ReprogramarTurnoPetPayload {
  const error = () => new TurnoPetError(400, "PET_REPROGRAM_INVALID_BODY", "Fecha y hora de destino inválidas");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw error();
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).length !== 2
    || !Object.prototype.hasOwnProperty.call(raw, "fecha")
    || !Object.prototype.hasOwnProperty.call(raw, "hora")) throw error();
  if (!fechaPetValida(raw.fecha) || typeof raw.hora !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.hora)) throw error();
  horaAMinutos(raw.hora);
  return { fecha: raw.fecha, hora: raw.hora };
}
