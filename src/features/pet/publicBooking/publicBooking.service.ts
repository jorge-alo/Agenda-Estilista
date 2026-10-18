import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
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

/**
 * The route only carries the pet id; authority comes exclusively from the PET
 * session. Every possible disqualification (missing, other tenant, unlinked,
 * inactive, online disabled, removed link) collapses into one indistinct 404.
 */
async function autorizarMascota(localId: number, clienteId: number, mascotaId: number): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT 1 FROM mascotas m
     JOIN mascota_clientes mc ON mc.mascota_id = m.id AND mc.local_id = m.local_id
     WHERE m.id = ? AND m.local_id = ? AND mc.cliente_id = ? AND mc.local_id = ?
       AND m.activo = 1 AND m.reserva_online_habilitada = 1
     LIMIT 1`,
    [mascotaId, localId, clienteId, localId],
  );
  if (!rows.length) {
    throw new PublicBookingError(404, "PET_MASCOTA_UNAVAILABLE", "Mascota no disponible para reserva online");
  }
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
