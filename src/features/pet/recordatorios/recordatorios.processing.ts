import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { getPetWhatsAppConnectionState, sendPetWhatsAppWithReceipt } from "../../notifications/infrastructure/whatsapp.provider";
import { evolutionNumberFromE164 } from "../session/session.link";
import { buildPetAppointmentReminder } from "./recordatorios.message";
import {
  establecerUtc, relojMysqlRecordatorioPet, restaurarZona, telefonoUtilizable,
  type RelojRecordatorioPet,
} from "./recordatorios.service";
import { fechaHoraSqlUtc, ventanaRecordatorioPet } from "./recordatorios.time";

export const PET_REMINDER_STALE_MS = 180_000;
type EstadoProcesamiento = "pending" | "sending" | "dispatching" | "sent" | "unknown" | "skipped";
type Resultado = "pending" | "sent" | "unknown" | "skipped" | "not_owned";

interface ReminderRow extends RowDataPacket {
  id: number; local_id: number; turno_id: number; estado: EstadoProcesamiento; claim_key: string;
}
interface LocalRow extends RowDataPacket { nombre: string; business_type: string }
interface TurnoRow extends RowDataPacket { mascota_id: number; cliente_id: number; fecha: string; hora: string }
interface PhoneRow extends RowDataPacket { telefono_normalizado: string | null }
interface NameRow extends RowDataPacket { nombre: string }

interface Owner { id: number; localId: number; turnoId: number; claimKey: string }
interface Delivery { number: string; message: string; claimKey: string }
type Validation = { kind: "ready"; delivery: Delivery } | { kind: "skipped" | "pending" | "not_owned" };

function logTransition(owner: Owner, from: EstadoProcesamiento, to: EstadoProcesamiento, reason: string): void {
  console.info("PET reminder transition", {
    reminderId: owner.id, localId: owner.localId, turnoId: owner.turnoId,
    tipo: "APPOINTMENT_REMINDER", from, to, reason,
  });
}

async function inUtcTransaction<T>(action: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  let previous: string | null = null;
  let active = false;
  try {
    previous = await establecerUtc(connection);
    await connection.beginTransaction();
    active = true;
    const result = await action(connection);
    await connection.commit();
    active = false;
    return result;
  } catch (error) {
    if (active) await connection.rollback();
    throw error;
  } finally {
    await restaurarZona(connection, previous);
  }
}

function claimSql(): string {
  return `id = ? AND local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
    AND turno_id = ? AND estado = 'sending' AND claimed_at = ?`;
}
function claimParams(owner: Owner): (number | string)[] {
  return [owner.id, owner.localId, owner.turnoId, owner.claimKey];
}

async function transitionSending(
  connection: PoolConnection, owner: Owner, next: "pending" | "skipped" | "dispatching", reason: string,
): Promise<string | null> {
  const [result] = await connection.query<ResultSetHeader>(
    `UPDATE pet_recordatorios SET estado = ?,
       claimed_at = ${next === "pending" ? "NULL" : next === "dispatching" ? "UTC_TIMESTAMP(3)" : "claimed_at"}
     WHERE ${claimSql()}`, [next, ...claimParams(owner)],
  );
  if (result.affectedRows !== 1) return null;
  logTransition(owner, "sending", next, reason);
  if (next !== "dispatching") return owner.claimKey;
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(claimed_at, '%Y-%m-%d %H:%i:%s.%f') AS claim_key
     FROM pet_recordatorios WHERE id = ? AND local_id = ?`, [owner.id, owner.localId],
  );
  return rows[0].claim_key as string;
}

/** The only send authorization is the atomic sending -> dispatching transition. */
async function validateAndMaybeDispatch(
  owner: Owner, action: "check" | "dispatch" | "defer", reloj: RelojRecordatorioPet,
): Promise<Validation> {
  return inUtcTransaction(async connection => {
    // The PET booking writer uses this same local -> turn order. Never hold it over HTTP.
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT nombre, business_type FROM locales WHERE id = ? FOR UPDATE", [owner.localId],
    );
    if (!locales.length) return { kind: "not_owned" };
    const window = ventanaRecordatorioPet(await reloj(connection));
    if (locales[0].business_type !== "PET_GROOMING" || !window) {
      return (await transitionSending(connection, owner, "skipped", "ineligible_or_window"))
        ? { kind: "skipped" } : { kind: "not_owned" };
    }
    const [turnos] = await connection.query<TurnoRow[]>(
      `SELECT mascota_id, cliente_id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,
         TIME_FORMAT(hora, '%H:%i') AS hora FROM turnos
       WHERE id = ? AND local_id = ? AND estado = 'activo' AND fecha = ?
         AND mascota_id IS NOT NULL AND cliente_id IS NOT NULL
         AND created_at IS NOT NULL AND created_at < ? FOR UPDATE`,
      [owner.turnoId, owner.localId, window.manana, fechaHoraSqlUtc(window.corteUtc)],
    );
    if (!turnos.length) return (await transitionSending(connection, owner, "skipped", "turno_ineligible"))
      ? { kind: "skipped" } : { kind: "not_owned" };
    const turno = turnos[0];
    const [links] = await connection.query<RowDataPacket[]>(
      `SELECT cliente_id FROM mascota_clientes WHERE local_id = ? AND mascota_id = ? AND cliente_id = ? FOR SHARE`,
      [owner.localId, turno.mascota_id, turno.cliente_id],
    );
    const [clientes] = await connection.query<PhoneRow[]>(
      "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE",
      [turno.cliente_id, owner.localId],
    );
    const [pets] = await connection.query<NameRow[]>(
      "SELECT nombre FROM mascotas WHERE id = ? AND local_id = ? FOR SHARE", [turno.mascota_id, owner.localId],
    );
    const [reminders] = await connection.query<ReminderRow[]>(
      `SELECT id, local_id, turno_id, estado,
         DATE_FORMAT(claimed_at, '%Y-%m-%d %H:%i:%s.%f') AS claim_key
       FROM pet_recordatorios WHERE ${claimSql()} AND cliente_id = ? AND cliente_local_id = ? FOR UPDATE`,
      [...claimParams(owner), turno.cliente_id, owner.localId],
    );
    if (!reminders.length) {
      return (await transitionSending(connection, owner, "skipped", "recipient_changed"))
        ? { kind: "skipped" } : { kind: "not_owned" };
    }
    const phone = clientes[0]?.telefono_normalizado ?? null;
    if (!links.length || !pets.length || !telefonoUtilizable(phone)) {
      return (await transitionSending(connection, owner, "skipped", "recipient_ineligible"))
        ? { kind: "skipped" } : { kind: "not_owned" };
    }
    // Any wait for a relationship/client lock can consume the operational window.
    if (!ventanaRecordatorioPet(await reloj(connection))) {
      return (await transitionSending(connection, owner, "skipped", "window_expired"))
        ? { kind: "skipped" } : { kind: "not_owned" };
    }
    const message = buildPetAppointmentReminder({
      localNombre: locales[0].nombre, mascotaNombre: pets[0].nombre,
      fecha: turno.fecha, hora: turno.hora,
    });
    const number = evolutionNumberFromE164(phone);
    if (action === "check") return { kind: "ready", delivery: { number, message, claimKey: owner.claimKey } };
    if (action === "defer") return (await transitionSending(connection, owner, "pending", "preflight_unavailable"))
      ? { kind: "pending" } : { kind: "not_owned" };
    const claimKey = await transitionSending(connection, owner, "dispatching", "send_authorized");
    return claimKey ? { kind: "ready", delivery: { number, message, claimKey } } : { kind: "not_owned" };
  });
}

async function finishDispatch(owner: Owner, claimKey: string, receipt: string | null): Promise<Resultado> {
  const next = receipt === null ? "unknown" : "sent";
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE pet_recordatorios SET estado = ?, accepted_at = ${receipt === null ? "NULL" : "UTC_TIMESTAMP(3)"},
       provider_message_id = ?
     WHERE id = ? AND local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
       AND turno_id = ? AND estado = 'dispatching' AND claimed_at = ?`,
    [next, receipt, owner.id, owner.localId, owner.turnoId, claimKey],
  );
  if (result.affectedRows !== 1) return "unknown";
  logTransition(owner, "dispatching", next, receipt === null ? "provider_ambiguous" : "provider_accepted");
  return next;
}

/** Invoked manually or by a future scheduler. No real HTTP in tests: mock the provider. */
export async function procesarRecordatorioPet(
  recordatorioId: number, reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
  provider = { connection: getPetWhatsAppConnectionState, send: sendPetWhatsAppWithReceipt },
): Promise<Resultado> {
  if (!Number.isSafeInteger(recordatorioId) || recordatorioId <= 0) return "not_owned";
  const [rows] = await pool.query<ReminderRow[]>(
    `SELECT id, local_id, turno_id, estado,
       DATE_FORMAT(claimed_at, '%Y-%m-%d %H:%i:%s.%f') AS claim_key
     FROM pet_recordatorios WHERE id = ? AND tipo = 'APPOINTMENT_REMINDER' AND estado = 'sending'`,
    [recordatorioId],
  );
  if (!rows.length || !rows[0].claim_key) return "not_owned";
  const owner: Owner = { id: rows[0].id, localId: rows[0].local_id,
    turnoId: rows[0].turno_id, claimKey: rows[0].claim_key };
  const first = await validateAndMaybeDispatch(owner, "check", reloj);
  if (first.kind !== "ready") return first.kind;
  let state: "open" | "closed" | "unavailable";
  try { state = await provider.connection(String(owner.localId)); }
  catch { state = "unavailable"; }
  if (state !== "open") {
    const retry = await validateAndMaybeDispatch(owner, "defer", reloj);
    return retry.kind === "ready" ? "not_owned" : retry.kind;
  }
  const final = await validateAndMaybeDispatch(owner, "dispatch", reloj);
  if (final.kind !== "ready") return final.kind;
  try {
    const receipt = await provider.send(final.delivery.number, final.delivery.message, String(owner.localId));
    return await finishDispatch(owner, final.delivery.claimKey, receipt);
  } catch {
    // Once dispatching, even an HTTP error or a failed sent UPDATE may conceal an accepted send.
    try { return await finishDispatch(owner, final.delivery.claimKey, null); }
    catch { return "unknown"; } // An abandoned dispatching is later recovered as unknown.
  }
}

async function stillEligibleForRecovery(
  connection: PoolConnection, owner: Owner, now: Date, businessType: string, reloj: RelojRecordatorioPet,
): Promise<boolean> {
  const window = ventanaRecordatorioPet(now);
  if (businessType !== "PET_GROOMING" || !window) return false;
  const [turnos] = await connection.query<TurnoRow[]>(
    `SELECT mascota_id, cliente_id FROM turnos WHERE id = ? AND local_id = ?
       AND estado = 'activo' AND fecha = ? AND mascota_id IS NOT NULL AND cliente_id IS NOT NULL
       AND created_at IS NOT NULL AND created_at < ? FOR UPDATE`,
    [owner.turnoId, owner.localId, window.manana, fechaHoraSqlUtc(window.corteUtc)],
  );
  if (!turnos.length) return false;
  const [links] = await connection.query<RowDataPacket[]>(
    "SELECT cliente_id FROM mascota_clientes WHERE local_id = ? AND mascota_id = ? AND cliente_id = ? FOR SHARE",
    [owner.localId, turnos[0].mascota_id, turnos[0].cliente_id],
  );
  if (!links.length) return false;
  const [clientes] = await connection.query<PhoneRow[]>(
    "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE",
    [turnos[0].cliente_id, owner.localId],
  );
  if (!telefonoUtilizable(clientes[0]?.telefono_normalizado ?? null)) return false;
  const [reminders] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM pet_recordatorios WHERE id = ? AND local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
       AND turno_id = ? AND estado = 'sending' AND claimed_at = ?
       AND cliente_id = ? AND cliente_local_id = ? FOR UPDATE`,
    [...claimParams(owner), turnos[0].cliente_id, owner.localId],
  );
  if (!reminders.length) return false;
  // A delayed row-lock wait cannot extend the sending window.
  return !!ventanaRecordatorioPet(await reloj(connection));
}

/** Idempotent, bounded recovery. Never retry a possibly delivered dispatching. */
export async function recuperarRecordatoriosPet(
  reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
): Promise<{ pending: number; skipped: number; unknown: number }> {
  const connection = await pool.getConnection();
  let candidates: ReminderRow[];
  try {
    const cutoff = fechaHoraSqlUtc(new Date((await reloj(connection)).getTime() - PET_REMINDER_STALE_MS));
    const [rows] = await connection.query<ReminderRow[]>(
      `SELECT id, local_id, turno_id, estado,
         DATE_FORMAT(claimed_at, '%Y-%m-%d %H:%i:%s.%f') AS claim_key
       FROM pet_recordatorios WHERE tipo = 'APPOINTMENT_REMINDER'
         AND estado IN ('sending','dispatching') AND claimed_at < ? ORDER BY id LIMIT 100`, [cutoff],
    );
    candidates = rows;
  } finally { connection.release(); }
  const results = { pending: 0, skipped: 0, unknown: 0 };
  for (const row of candidates) {
    const owner: Owner = { id: row.id, localId: row.local_id, turnoId: row.turno_id, claimKey: row.claim_key };
    const next = await inUtcTransaction(async tx => {
      const [locales] = await tx.query<LocalRow[]>(
        "SELECT nombre, business_type FROM locales WHERE id = ? FOR UPDATE", [owner.localId],
      );
      if (!locales.length) return null;
      const now = await reloj(tx);
      const cutoff = fechaHoraSqlUtc(new Date(now.getTime() - PET_REMINDER_STALE_MS));
      if (row.estado === "sending") {
        const target = await stillEligibleForRecovery(tx, owner, now, locales[0].business_type, reloj)
          ? "pending" : "skipped";
        const [updated] = await tx.query<ResultSetHeader>(
          `UPDATE pet_recordatorios SET estado = ?, claimed_at = ${target === "pending" ? "NULL" : "claimed_at"}
           WHERE id = ? AND local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
             AND turno_id = ? AND estado = 'sending' AND claimed_at = ? AND claimed_at < ?`,
          [target, ...claimParams(owner), cutoff],
        );
        if (!updated.affectedRows) return null;
        logTransition(owner, "sending", target, "stale_before_http");
        return target;
      }
      const [updated] = await tx.query<ResultSetHeader>(
        `UPDATE pet_recordatorios SET estado = 'unknown'
         WHERE id = ? AND local_id = ? AND tipo = 'APPOINTMENT_REMINDER'
           AND turno_id = ? AND estado = 'dispatching' AND claimed_at = ? AND claimed_at < ?`,
        [...claimParams(owner), cutoff],
      );
      if (!updated.affectedRows) return null;
      logTransition(owner, "dispatching", "unknown", "stale_after_authorization");
      return "unknown";
    });
    if (next) results[next]++;
  }
  return results;
}
