import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { evolutionNumberFromE164 } from "../session/session.link";
import { fechaHoraSqlUtc, ventanaRecordatorioPet } from "./recordatorios.time";

interface ClockRow extends RowDataPacket { ahoraUtc: string }
interface CandidatoRow extends RowDataPacket {
  id: number; local_id: number; cliente_id: number; telefono_normalizado: string;
}
interface LocalRow extends RowDataPacket { id: number }
interface TurnoRow extends RowDataPacket { cliente_id: number; mascota_id: number }
interface ClienteRow extends RowDataPacket { telefono_normalizado: string | null }
interface TimeZoneRow extends RowDataPacket { timeZone: string }

export interface CandidatoRecordatorioPet {
  turnoId: number; localId: number; clienteId: number; telefonoCanonical: string;
}
export interface ReclamoRecordatorioPet extends CandidatoRecordatorioPet { recordatorioId: number }
export interface CursorRecordatorioPet { localId: number; turnoId: number }
export interface PaginaRecordatoriosPet {
  candidatos: CandidatoRecordatorioPet[];
  cursor: CursorRecordatorioPet | null;
  hayMas: boolean;
}

export type RelojRecordatorioPet = (connection: PoolConnection) => Promise<Date>;

/** Only the UTC instant crosses from MySQL into JS; no host timezone conversion. */
export const relojMysqlRecordatorioPet: RelojRecordatorioPet = async connection => {
  const [rows] = await connection.query<ClockRow[]>(
    `SELECT CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.'),
       LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%f'), 3), 'Z') AS ahoraUtc`,
  );
  const value = rows[0]?.ahoraUtc;
  const date = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("PET_REMINDER_CLOCK_INVALID");
  }
  return date;
};

export function telefonoUtilizable(value: string | null): value is string {
  if (value === null) return false;
  try {
    return normalizeClientPhone(value) === value && evolutionNumberFromE164(value).length > 0;
  } catch {
    return false;
  }
}

export async function establecerUtc(connection: PoolConnection): Promise<string> {
  const [rows] = await connection.query<TimeZoneRow[]>("SELECT @@session.time_zone AS timeZone");
  const previous = rows[0].timeZone;
  if (previous !== "+00:00") await connection.query("SET time_zone = '+00:00'");
  return previous;
}

export async function restaurarZona(connection: PoolConnection, previous: string | null): Promise<void> {
  try {
    if (previous !== null && previous !== "+00:00") {
      await connection.query("SET time_zone = ?", [previous]);
    }
    connection.release();
  } catch (error) {
    // Never return a session with changed timezone to the shared BEAUTY/PET pool.
    connection.destroy();
    throw error;
  }
}

/** Stable keyset (local_id, turno.id). The cursor advances over RAW rows, even invalid phones. */
export async function seleccionarPaginaRecordatoriosPet(
  cursor: CursorRecordatorioPet | null = null,
  reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
  limite = 50,
): Promise<PaginaRecordatoriosPet> {
  if (!Number.isSafeInteger(limite) || limite < 1 || limite > 50) {
    throw new Error("PET_REMINDER_PAGE_LIMIT_INVALID");
  }
  const connection = await pool.getConnection();
  let previousZone: string | null = null;
  try {
    previousZone = await establecerUtc(connection);
    const window = ventanaRecordatorioPet(await reloj(connection));
    if (!window) return { candidatos: [], cursor: null, hayMas: false };
    const [rows] = await connection.query<CandidatoRow[]>(
      `SELECT t.id, t.local_id, t.cliente_id, c.telefono_normalizado
       FROM turnos t
       JOIN locales l ON l.id = t.local_id AND l.business_type = 'PET_GROOMING'
       JOIN mascota_clientes mc ON mc.local_id = t.local_id
         AND mc.mascota_id = t.mascota_id AND mc.cliente_id = t.cliente_id
       JOIN clientes c ON c.id = t.cliente_id AND c.local_id = t.local_id
       WHERE t.mascota_id IS NOT NULL AND t.estado = 'activo'
         AND t.fecha = ? AND t.created_at IS NOT NULL AND t.created_at < ?
         AND t.cliente_id IS NOT NULL AND c.telefono_normalizado IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pet_recordatorios pr
            WHERE pr.local_id = t.local_id AND pr.tipo = 'APPOINTMENT_REMINDER'
              AND pr.turno_id = t.id AND pr.estado <> 'pending')
         AND (? IS NULL OR t.local_id > ? OR (t.local_id = ? AND t.id > ?))
       ORDER BY t.local_id, t.id LIMIT ?`,
      [window.manana, fechaHoraSqlUtc(window.corteUtc), cursor?.localId ?? null,
        cursor?.localId ?? null, cursor?.localId ?? null, cursor?.turnoId ?? null, limite],
    );
    const last = rows[rows.length - 1];
    return { candidatos: rows.filter(row => telefonoUtilizable(row.telefono_normalizado)).map(row => ({
      turnoId: row.id, localId: row.local_id, clienteId: row.cliente_id,
      telefonoCanonical: row.telefono_normalizado,
    })), cursor: last ? { localId: last.local_id, turnoId: last.id } : null,
    hayMas: rows.length === limite };
  } finally {
    await restaurarZona(connection, previousZone);
  }
}

/** Existing convenience selector; the scheduled worker uses bounded keyset pages instead. */
export async function seleccionarRecordatoriosPet(
  reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
): Promise<CandidatoRecordatorioPet[]> {
  const all: CandidatoRecordatorioPet[] = [];
  let cursor: CursorRecordatorioPet | null = null;
  for (;;) {
    const page = await seleccionarPaginaRecordatoriosPet(cursor, reloj);
    all.push(...page.candidatos);
    if (!page.hayMas || !page.cursor) return all;
    cursor = page.cursor;
  }
}

/** Local X -> turno X -> relationship/client S: same booking lock order, no HTTP under locks. */
export async function reclamarRecordatorioPet(
  localId: number, turnoId: number,
  reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
): Promise<ReclamoRecordatorioPet | null> {
  const connection = await pool.getConnection();
  let started = false;
  let previousZone: string | null = null;
  try {
    previousZone = await establecerUtc(connection);
    await connection.beginTransaction();
    started = true;
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT id FROM locales WHERE id = ? AND business_type = 'PET_GROOMING' FOR UPDATE", [localId],
    );
    if (!locales.length) { await connection.rollback(); started = false; return null; }
    // Read clock AFTER waiting for the local lock. An old selector snapshot cannot authorize this claim.
    const window = ventanaRecordatorioPet(await reloj(connection));
    if (!window) { await connection.rollback(); started = false; return null; }
    const [turnos] = await connection.query<TurnoRow[]>(
      `SELECT cliente_id, mascota_id FROM turnos
       WHERE id = ? AND local_id = ? AND mascota_id IS NOT NULL
         AND cliente_id IS NOT NULL AND estado = 'activo' AND fecha = ?
         AND created_at IS NOT NULL AND created_at < ? FOR UPDATE`,
      [turnoId, localId, window.manana, fechaHoraSqlUtc(window.corteUtc)],
    );
    if (!turnos.length) { await connection.rollback(); started = false; return null; }
    const turno = turnos[0];
    const [relaciones] = await connection.query<RowDataPacket[]>(
      `SELECT cliente_id FROM mascota_clientes
       WHERE local_id = ? AND mascota_id = ? AND cliente_id = ? FOR SHARE`,
      [localId, turno.mascota_id, turno.cliente_id],
    );
    if (!relaciones.length) { await connection.rollback(); started = false; return null; }
    const [clientes] = await connection.query<ClienteRow[]>(
      "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE",
      [turno.cliente_id, localId],
    );
    const canonical = clientes[0]?.telefono_normalizado ?? null;
    if (!telefonoUtilizable(canonical)) { await connection.rollback(); started = false; return null; }
    // Waiting on a relationship or client lock must not move a claim past 12:00 ART.
    const finalWindow = ventanaRecordatorioPet(await reloj(connection));
    if (!finalWindow || finalWindow.manana !== window.manana) {
      await connection.rollback(); started = false; return null;
    }
    const [existing] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM pet_recordatorios WHERE local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
       AND turno_id = ? FOR UPDATE`, [localId, turnoId],
    );
    let recordatorioId: number;
    if (existing.length) {
      const [pending] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM pet_recordatorios WHERE id = ? AND local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
         AND turno_id = ? AND estado = 'pending' FOR UPDATE`, [existing[0].id, localId, turnoId],
      );
      if (!pending.length) { await connection.rollback(); started = false; return null; }
      recordatorioId = pending[0].id;
    } else {
      const [insert] = await connection.query<ResultSetHeader>(
        `INSERT INTO pet_recordatorios
         (local_id, tipo, turno_id, cliente_id, cliente_local_id, estado, created_at)
         VALUES (?, 'APPOINTMENT_REMINDER', ?, ?, ?, 'pending', UTC_TIMESTAMP(3))`,
        [localId, turnoId, turno.cliente_id, localId],
      );
      recordatorioId = insert.insertId;
    }
    // Only one worker can claim an existing pending row. Do not create another identity.
    const [claimed] = await connection.query<ResultSetHeader>(
      `UPDATE pet_recordatorios SET estado = 'sending', claimed_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND local_id = ? AND estado = 'pending'`, [recordatorioId, localId],
    );
    if (claimed.affectedRows !== 1) throw new Error("PET_REMINDER_CLAIM_CONFLICT");
    await connection.commit();
    started = false;
    return { recordatorioId, turnoId, localId,
      clienteId: turno.cliente_id, telefonoCanonical: canonical };
  } catch (error: unknown) {
    if (started) await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") return null;
    throw error;
  } finally {
    await restaurarZona(connection, previousZone);
  }
}
