import type { PoolConnection } from "mysql2/promise";
import type { SeleccionCreacionTurnoPet } from "./turnos.types";

/**
 * Lock only: no eligibility, duration or availability rules live here. All
 * preflight reads are current reads, so PET-07's first consistent read starts
 * AFTER configuration is stable. Missing rows are rejected by PET-07 itself.
 */
export async function bloquearConfiguracionCreacion(
  connection: PoolConnection,
  localId: number,
  seleccion: SeleccionCreacionTurnoPet,
): Promise<void> {
  await connection.query(
    "SELECT id FROM servicios WHERE id = ? AND local_id = ? FOR SHARE",
    [seleccion.servicioId, localId],
  );
  await connection.query(
    `SELECT servicio_id FROM mascota_servicios
     WHERE mascota_id = ? AND servicio_id = ? AND local_id = ? FOR SHARE`,
    [seleccion.mascotaId, seleccion.servicioId, localId],
  );
  for (const extraId of [...seleccion.extraIds].sort((a, b) => a - b)) {
    await connection.query("SELECT id FROM extras WHERE id = ? AND local_id = ? FOR SHARE", [extraId, localId]);
    await connection.query(
      `SELECT extra_id FROM mascota_extras
       WHERE mascota_id = ? AND extra_id = ? AND local_id = ? FOR SHARE`,
      [seleccion.mascotaId, extraId, localId],
    );
  }
}
