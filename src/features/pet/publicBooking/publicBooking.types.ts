const INT_MAX = 2147483647;

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
