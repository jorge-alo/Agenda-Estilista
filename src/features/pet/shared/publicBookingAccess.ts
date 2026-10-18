import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { contextoTemporalArgentina } from "../disponibilidad/disponibilidad.service";
import { fechaPetValida } from "../disponibilidad/disponibilidad.types";

export interface PetPublicBookingLocal {
  activo: number;
  business_type: string;
  suscripcion_estado: string | null;
  /** DATE rendered explicitly by SQL, never a mysql2/host-local Date. */
  suscripcion_vencimiento: string | null;
}

export class PetPublicBookingUnavailableError extends Error {
  constructor() { super("PET_BOOKING_UNAVAILABLE"); }
}

export class PetPublicLocalUnavailableError extends Error {
  constructor() { super("PET_PUBLIC_LOCAL_UNAVAILABLE"); }
}

function fechaCalendario(value: unknown): value is string {
  return typeof value === "string" && value.length === 10 && fechaPetValida(value);
}

/** The single commercial rule. NULL is not unlimited/trial; the last day is inclusive. */
export function publicBookingEnabled(local: PetPublicBookingLocal, hoyArgentina: string): boolean {
  if (!fechaCalendario(hoyArgentina)
    || (local.suscripcion_vencimiento !== null && !fechaCalendario(local.suscripcion_vencimiento))
    || ![null, "activo", "vencido", "pendiente_pago"].includes(local.suscripcion_estado)) {
    throw new Error("PET_PUBLIC_BOOKING_INTEGRITY");
  }
  return local.activo === 1 && local.business_type === "PET_GROOMING"
    && local.suscripcion_estado === "activo" && local.suscripcion_vencimiento !== null
    && local.suscripcion_vencimiento >= hoyArgentina;
}

/** Pure conversion of an explicitly UTC DB instant, independent of host/browser TZ. */
export function fechaArgentinaDesdeUtcDb(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) throw new Error("PET_PUBLIC_BOOKING_CLOCK_INVALID");
  const instante = new Date(value);
  if (!Number.isFinite(instante.getTime()) || instante.toISOString() !== value) {
    throw new Error("PET_PUBLIC_BOOKING_CLOCK_INVALID");
  }
  return contextoTemporalArgentina(instante).fecha;
}

type SqlReader = Pool | PoolConnection;
interface ClockRow extends RowDataPacket { ahoraUtc: string }
interface LocalRow extends RowDataPacket, PetPublicBookingLocal {}

export async function fechaArgentinaDb(reader: SqlReader): Promise<string> {
  // No FROM/table read: this cannot establish an InnoDB consistent snapshot.
  // A NEW statement after the local lock avoids using a waiting query's old clock.
  const [rows] = await reader.query<ClockRow[]>(
    `SELECT CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'),
       LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%f'), 3), 'Z') AS ahoraUtc`,
  );
  return fechaArgentinaDesdeUtcDb(rows[0]?.ahoraUtc);
}

/** Transactional callers pass their already-locked local row, not a fresh pool read. */
export async function requirePetPublicBookingEnabled(reader: SqlReader, local: PetPublicBookingLocal): Promise<void> {
  if (!publicBookingEnabled(local, await fechaArgentinaDb(reader))) throw new PetPublicBookingUnavailableError();
}

/** C/D are non-durable snapshots. E and first visit use the locked-row entry above. */
export async function requirePetPublicBookingForLocal(reader: SqlReader, localId: number): Promise<void> {
  const [rows] = await reader.query<LocalRow[]>(
    `SELECT activo, business_type, suscripcion_estado,
       DATE_FORMAT(suscripcion_vencimiento, '%Y-%m-%d') AS suscripcion_vencimiento
     FROM locales WHERE id = ?`, [localId],
  );
  if (!rows.length || rows[0].activo !== 1 || rows[0].business_type !== "PET_GROOMING") {
    throw new PetPublicLocalUnavailableError();
  }
  await requirePetPublicBookingEnabled(reader, rows[0]);
}
