import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import {
  DisponibilidadPetError,
  formatearSlots,
  prepararDisponibilidad,
  type ConsultaDisponibilidadPet,
  type RespuestaDisponibilidadPet,
} from "../disponibilidad/disponibilidad.service";
import { autorizarMascota } from "./publicBooking.authorization";
import {
  PublicBookingError,
  duracionPublica,
  type OpcionesReserva,
  type OpcionesReservaExtra,
  type OpcionesReservaServicio,
} from "./publicBooking.types";

interface ServicioRow extends RowDataPacket {
  id: number;
  nombre: string;
  duracion_minutos: number;
}

interface ExtraRow extends RowDataPacket {
  id: number;
  nombre: string;
  duracion_minutos: number;
}

async function listarServiciosPublicos(localId: number, mascotaId: number): Promise<OpcionesReservaServicio[]> {
  const [rows] = await pool.query<ServicioRow[]>(
    `SELECT s.id, s.nombre, ms.duracion_minutos
     FROM mascota_servicios ms
     JOIN servicios s ON s.id = ms.servicio_id AND s.local_id = ms.local_id
     WHERE ms.mascota_id = ? AND ms.local_id = ? AND s.activo = 1
     ORDER BY s.nombre, s.id`,
    [mascotaId, localId],
  );
  return rows.map(row => ({
    id: row.id,
    nombre: row.nombre,
    duracionMinutos: duracionPublica(row.duracion_minutos, `mascota_servicios[${row.id}]`),
  }));
}

async function listarExtrasPublicos(localId: number, mascotaId: number): Promise<OpcionesReservaExtra[]> {
  const [rows] = await pool.query<ExtraRow[]>(
    `SELECT e.id, e.nombre, me.duracion_minutos
     FROM mascota_extras me
     JOIN extras e ON e.id = me.extra_id AND e.local_id = me.local_id
     WHERE me.mascota_id = ? AND me.local_id = ? AND e.activo = 1
     ORDER BY e.nombre, e.id`,
    [mascotaId, localId],
  );
  return rows.map(row => ({
    id: row.id,
    nombre: row.nombre,
    duracionExtraMinutos: duracionPublica(row.duracion_minutos, `mascota_extras[${row.id}]`),
  }));
}

/**
 * Read-only, non-durable snapshot: availability and booking will revalidate.
 * Servicios and extras are fetched separately to avoid a cartesian product.
 */
export async function obtenerOpcionesReserva(localId: number, clienteId: number, mascotaId: number): Promise<OpcionesReserva> {
  await autorizarMascota(localId, clienteId, mascotaId);
  const [servicios, extras] = await Promise.all([
    listarServiciosPublicos(localId, mascotaId),
    listarExtrasPublicos(localId, mascotaId),
  ]);
  return { servicios, extras };
}

/**
 * Explicit internal -> public mapping. Only known PET-07 disqualifications are
 * translated; integrity errors, RangeError and anything unrecognized are
 * rethrown into the sanitized 500 pipeline. Empty slots are a valid answer.
 */
const MAPEO_DISPONIBILIDAD: Record<string, { status: number; code: string }> = {
  PET_MASCOTA_NOT_FOUND: { status: 404, code: "PET_MASCOTA_UNAVAILABLE" },
  PET_MASCOTA_INACTIVA: { status: 404, code: "PET_MASCOTA_UNAVAILABLE" },
  PET_SERVICIO_NOT_FOUND: { status: 404, code: "PET_SERVICE_UNAVAILABLE" },
  PET_SERVICIO_INACTIVO: { status: 404, code: "PET_SERVICE_UNAVAILABLE" },
  PET_SERVICIO_NO_ASOCIADO: { status: 404, code: "PET_SERVICE_UNAVAILABLE" },
  PET_EXTRA_NOT_FOUND: { status: 404, code: "PET_EXTRA_UNAVAILABLE" },
  PET_EXTRA_INACTIVO: { status: 404, code: "PET_EXTRA_UNAVAILABLE" },
  PET_EXTRA_NO_ASOCIADO: { status: 404, code: "PET_EXTRA_UNAVAILABLE" },
  PET_HIGH_DEMAND_SETTINGS_REQUIRED: { status: 409, code: "PET_BOOKING_UNAVAILABLE" },
};

function mapearErrorDisponibilidad(error: unknown): never {
  if (error instanceof DisponibilidadPetError) {
    const mapped = MAPEO_DISPONIBILIDAD[error.code];
    if (mapped) throw new PublicBookingError(mapped.status, mapped.code, error.message);
  }
  throw error;
}

/**
 * Informative, non-durable snapshot: no transaction, locks or holds. The booking
 * flow (PET-12E) revalidates every rule under a transaction. The shared domain
 * (prepararDisponibilidad) stays the single source of truth for durations,
 * service/extra validation, schedules, blocks, occupancy, high-demand and TZ.
 */
export async function obtenerDisponibilidadPublica(
  localId: number,
  clienteId: number,
  consulta: ConsultaDisponibilidadPet,
): Promise<RespuestaDisponibilidadPet> {
  await autorizarMascota(localId, clienteId, consulta.mascotaId);
  try {
    const resultado = await prepararDisponibilidad(pool, localId, consulta);
    return {
      fecha: consulta.fecha,
      duracionMinutos: resultado.duracionMinutos,
      slots: formatearSlots(resultado.slots),
    };
  } catch (error: unknown) {
    mapearErrorDisponibilidad(error);
  }
}
