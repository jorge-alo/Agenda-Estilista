import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { PublicBookingError } from "./publicBooking.types";

/**
 * The route only carries the pet id; authority comes exclusively from the PET
 * session. Every possible disqualification (missing, other tenant, unlinked,
 * inactive, online disabled, removed link) collapses into one indistinct 404.
 */
export async function autorizarMascota(localId: number, clienteId: number, mascotaId: number): Promise<void> {
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
