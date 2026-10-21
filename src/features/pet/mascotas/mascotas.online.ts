import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { InvalidClientPhoneError, normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { enteroPositivo } from "../servicios/servicios.types";
import { PetSettingsError, validarPayload } from "../settings/settings.types";

export class MascotaReservaOnlineError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export type MascotaOnlineRow = RowDataPacket & {
  id: number;
  activo: number;
  alta_exigencia: number;
  reserva_online_habilitada: number;
};

/** Always acquire the domain's local lock before the pet lock; all reads are current. */
export async function bloquearMascotaOnline(connection: PoolConnection, localId: number, mascotaId: number): Promise<MascotaOnlineRow> {
  await connection.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [localId]);
  const [rows] = await connection.query<MascotaOnlineRow[]>(
    `SELECT id, activo, alta_exigencia, reserva_online_habilitada
     FROM mascotas WHERE id = ? AND local_id = ? FOR UPDATE`, [mascotaId, localId],
  );
  if (!rows.length) throw new MascotaReservaOnlineError(404, "PET_MASCOTA_NOT_FOUND");
  return rows[0];
}

/** Call only while holding local X -> mascota X, and retain every lock until commit. */
export async function validarElegibilidadOnline(connection: PoolConnection, localId: number, mascota: MascotaOnlineRow): Promise<void> {
  if (mascota.activo !== 1) throw new MascotaReservaOnlineError(409, "PET_MASCOTA_INACTIVE");

  // Discovery is not authority. Recheck each parent and exact link with current
  // point reads, in parent -> relation order (also protects legacy cascades).
  const [responsables] = await connection.query<(RowDataPacket & { cliente_id: number })[]>(
    "SELECT cliente_id FROM mascota_clientes WHERE mascota_id = ? AND local_id = ? ORDER BY cliente_id",
    [mascota.id, localId],
  );
  let responsableUtilizable = false;
  for (const candidate of responsables) {
    const [clientes] = await connection.query<(RowDataPacket & { telefono_normalizado: string | null })[]>(
      "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE", [candidate.cliente_id, localId],
    );
    const canonical = clientes[0]?.telefono_normalizado;
    if (typeof canonical !== "string") continue;
    try {
      // Same normalizer and exact canonical lookup used by PET session access.
      if (normalizeClientPhone(canonical) !== canonical) continue;
    } catch (error: unknown) {
      if (error instanceof InvalidClientPhoneError) continue;
      throw error;
    }
    const [links] = await connection.query<RowDataPacket[]>(
      "SELECT mascota_id FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ? FOR SHARE",
      [mascota.id, candidate.cliente_id, localId],
    );
    if (links.length) { responsableUtilizable = true; break; }
  }
  if (!responsableUtilizable) throw new MascotaReservaOnlineError(409, "PET_ONLINE_REQUIRES_RESPONSIBLE");

  const [servicios] = await connection.query<(RowDataPacket & { servicio_id: number })[]>(
    "SELECT servicio_id FROM mascota_servicios WHERE mascota_id = ? AND local_id = ? ORDER BY servicio_id",
    [mascota.id, localId],
  );
  let servicioElegible = false;
  for (const candidate of servicios) {
    const [catalogo] = await connection.query<(RowDataPacket & { activo: number | null })[]>(
      "SELECT activo FROM servicios WHERE id = ? AND local_id = ? FOR SHARE", [candidate.servicio_id, localId],
    );
    if (catalogo[0]?.activo !== 1) continue;
    const [links] = await connection.query<(RowDataPacket & { duracion_minutos: number | null })[]>(
      "SELECT duracion_minutos FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ? AND local_id = ? FOR SHARE",
      [mascota.id, candidate.servicio_id, localId],
    );
    if (enteroPositivo(links[0]?.duracion_minutos)) { servicioElegible = true; break; }
  }
  if (!servicioElegible) throw new MascotaReservaOnlineError(409, "PET_ONLINE_REQUIRES_SERVICE");

  if (mascota.alta_exigencia === 1) {
    const [settings] = await connection.query<RowDataPacket[]>(
      `SELECT high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day
       FROM pet_settings WHERE local_id = ? FOR SHARE`, [localId],
    );
    if (!settings.length) throw new MascotaReservaOnlineError(409, "PET_ONLINE_REQUIRES_HIGH_DEMAND_SETTINGS");
    try {
      validarPayload({
        highDemandRule: settings[0].high_demand_rule,
        highDemandGapMinutes: settings[0].high_demand_gap_minutes,
        highDemandMaxPerDay: settings[0].high_demand_max_per_day,
      });
    } catch (error: unknown) {
      if (error instanceof PetSettingsError) throw new MascotaReservaOnlineError(409, "PET_ONLINE_REQUIRES_HIGH_DEMAND_SETTINGS");
      throw error;
    }
  }
}
