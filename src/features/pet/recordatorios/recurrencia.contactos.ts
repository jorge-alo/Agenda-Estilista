import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { pool } from "../../../config/db";
import { relojMysqlRecordatorioPet, telefonoUtilizable, type RelojRecordatorioPet } from "./recordatorios.service";
import { fechaHoraSqlUtc } from "./recordatorios.time";
import type { ResolverAutorizacionRecurrenciaPet } from "./recurrencia.service";

export class ContactoRecurrenciaError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export type OperacionContactoRecurrencia = {
  tipo: "autorizacion"; clienteId: number; telefonoCanonical: string;
  verificadaAt: string; referenciaVerificacion: string;
} | { tipo: "baja"; telefonoCanonical: string; referenciaBaja: string };

interface ContactoRow extends RowDataPacket {
  estado: string;
  cliente_id_autorizado: number | null;
  verificada_at_utc: string | null;
  referencia_verificacion: string | null;
}

/** Must run before selection, even with zero D30 rows: missing migration is NOT no consent. */
export async function prepararFuenteContactosRecurrencia(
  reader: Pick<PoolConnection, "query">, localId: number,
): Promise<ResolverAutorizacionRecurrenciaPet> {
  await reader.query(`SELECT estado, cliente_id_autorizado, verificada_at, referencia_verificacion
    FROM pet_recurrencia_contactos WHERE local_id = ? LIMIT 0`, [localId]);
  return async contacto => {
    if (contacto.localId !== localId) throw new ContactoRecurrenciaError("PET_RECURRENCE_TENANT_MISMATCH");
    const [rows] = await reader.query<ContactoRow[]>(
      `SELECT estado, cliente_id_autorizado,
        CONCAT(DATE_FORMAT(verificada_at, '%Y-%m-%dT%H:%i:%s.'),
          LEFT(DATE_FORMAT(verificada_at, '%f'), 3), 'Z') AS verificada_at_utc,
        referencia_verificacion
       FROM pet_recurrencia_contactos WHERE local_id = ? AND telefono_normalizado = ?`,
      [localId, contacto.telefonoCanonical],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.estado === "baja") return { estado: "baja" };
    if (row.estado === "habilitada" && row.cliente_id_autorizado !== null) {
      return { estado: "habilitada", localId, clienteId: row.cliente_id_autorizado, telefonoCanonical: contacto.telefonoCanonical };
    }
    if (row.estado !== "autorizada" || row.cliente_id_autorizado === null
      || !row.verificada_at_utc || !row.referencia_verificacion) {
      throw new ContactoRecurrenciaError("PET_RECURRENCE_CONTACT_INVALID");
    }
    return { estado: "autorizada", localId, clienteId: row.cliente_id_autorizado,
      telefonoCanonical: contacto.telefonoCanonical, verificadaAt: row.verificada_at_utc,
      referenciaVerificacion: row.referencia_verificacion };
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function referencia(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255;
}

/** Strict JSON contract: evidence references, never conversations or implicit commercial consent. */
export function validarLoteContactosRecurrencia(value: unknown): OperacionContactoRecurrencia[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new ContactoRecurrenciaError("PET_RECURRENCE_BATCH_INVALID");
  }
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.telefonoCanonical !== "string" || !telefonoUtilizable(item.telefonoCanonical)
      || seen.has(item.telefonoCanonical)) throw new ContactoRecurrenciaError("PET_RECURRENCE_CONTACT_INVALID");
    seen.add(item.telefonoCanonical);
    if (item.tipo === "autorizacion" && Object.keys(item).length === 5
      && typeof item.clienteId === "number" && Number.isSafeInteger(item.clienteId) && item.clienteId > 0
      && typeof item.verificadaAt === "string" && referencia(item.referenciaVerificacion)) {
      const date = new Date(item.verificadaAt);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== item.verificadaAt
        || date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999) {
        throw new ContactoRecurrenciaError("PET_RECURRENCE_VERIFICATION_INVALID");
      }
      return { tipo: "autorizacion", clienteId: item.clienteId, telefonoCanonical: item.telefonoCanonical,
        verificadaAt: item.verificadaAt, referenciaVerificacion: item.referenciaVerificacion.trim() };
    }
    if (item.tipo === "baja" && Object.keys(item).length === 3 && referencia(item.referenciaBaja)) {
      return { tipo: "baja", telefonoCanonical: item.telefonoCanonical, referenciaBaja: item.referenciaBaja.trim() };
    }
    throw new ContactoRecurrenciaError("PET_RECURRENCE_CONTACT_INVALID");
  });
}

type ResultadoContacto = "autorizar" | "registrar_baja" | "baja_respetada" | "sin_cambios";

/** Default is READ ONLY. Apply serializes by local X -> contact X -> client S, atomic whole batch. */
export async function operarContactosRecurrencia(
  opciones: { localId: number; operaciones: unknown; aplicar?: boolean },
  db: Pick<Pool, "getConnection"> = pool, reloj: RelojRecordatorioPet = relojMysqlRecordatorioPet,
) {
  if (!Number.isSafeInteger(opciones.localId) || opciones.localId < 1) {
    throw new ContactoRecurrenciaError("PET_RECURRENCE_LOCAL_INVALID");
  }
  if (opciones.aplicar !== undefined && typeof opciones.aplicar !== "boolean") {
    throw new ContactoRecurrenciaError("PET_RECURRENCE_MODE_INVALID");
  }
  const operaciones = validarLoteContactosRecurrencia(opciones.operaciones);
  const aplicar = opciones.aplicar === true;
  const connection = await db.getConnection();
  let started = false;
  try {
    if (aplicar) await connection.beginTransaction();
    else await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    started = true;
    const [locals] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM locales WHERE id = ? AND business_type = 'PET_GROOMING'${aplicar ? " FOR UPDATE" : ""}`,
      [opciones.localId],
    );
    if (!locals.length) throw new ContactoRecurrenciaError("PET_RECURRENCE_PET_LOCAL_REQUIRED");
    await prepararFuenteContactosRecurrencia(connection, opciones.localId);
    const resultados: { posicion: number; resultado: ResultadoContacto }[] = [];
    for (const [posicion, item] of operaciones.entries()) {
      // Current read under local X: an import cannot race a phone-scoped opt-out.
      const [contacts] = await connection.query<ContactoRow[]>(
        `SELECT estado, cliente_id_autorizado FROM pet_recurrencia_contactos
         WHERE local_id = ? AND telefono_normalizado = ?${aplicar ? " FOR UPDATE" : ""}`,
        [opciones.localId, item.telefonoCanonical],
      );
      const old = contacts[0];
      if (old?.estado === "baja") {
        resultados.push({ posicion, resultado: item.tipo === "autorizacion" ? "baja_respetada" : "sin_cambios" });
        continue;
      }
      if (old && old.estado !== "autorizada" && old.estado !== "habilitada") throw new ContactoRecurrenciaError("PET_RECURRENCE_CONTACT_INVALID");
      if (item.tipo === "autorizacion") {
        const [clients] = await connection.query<(RowDataPacket & { telefono_normalizado: string | null })[]>(
          `SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ?${aplicar ? " FOR SHARE" : ""}`,
          [item.clienteId, opciones.localId],
        );
        if (clients[0]?.telefono_normalizado !== item.telefonoCanonical) {
          throw new ContactoRecurrenciaError("PET_RECURRENCE_CLIENT_PHONE_MISMATCH");
        }
        if (new Date(item.verificadaAt) > await reloj(connection)) {
          throw new ContactoRecurrenciaError("PET_RECURRENCE_VERIFICATION_FUTURE");
        }
        if (old) {
          if (old.cliente_id_autorizado !== item.clienteId) {
            throw new ContactoRecurrenciaError("PET_RECURRENCE_CONTACT_OWNER_MISMATCH");
          }
          resultados.push({ posicion, resultado: "sin_cambios" });
          continue;
        }
        if (aplicar) {
          const [result] = await connection.query<ResultSetHeader>(
            `INSERT INTO pet_recurrencia_contactos
              (local_id, telefono_normalizado, estado, cliente_id_autorizado, verificada_at,
                referencia_verificacion, origen, created_at, updated_at)
             VALUES (?, ?, 'autorizada', ?, ?, ?, 'importacion', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
            [opciones.localId, item.telefonoCanonical, item.clienteId,
              fechaHoraSqlUtc(new Date(item.verificadaAt)), item.referenciaVerificacion],
          );
          if (result.affectedRows !== 1) throw new ContactoRecurrenciaError("PET_RECURRENCE_WRITE_CONFLICT");
        }
        resultados.push({ posicion, resultado: "autorizar" });
      } else {
        if (aplicar) {
          const [result] = old ? await connection.query<ResultSetHeader>(
            `UPDATE pet_recurrencia_contactos SET estado = 'baja', baja_at = UTC_TIMESTAMP(3),
              referencia_baja = ?, origen='importacion', operador_id=NULL, operacion_id=?, updated_at = UTC_TIMESTAMP(3)
             WHERE local_id = ? AND telefono_normalizado = ? AND estado IN ('autorizada','habilitada')`,
            [item.referenciaBaja, randomUUID(), opciones.localId, item.telefonoCanonical],
          ) : await connection.query<ResultSetHeader>(
            `INSERT INTO pet_recurrencia_contactos
              (local_id, telefono_normalizado, estado, baja_at, referencia_baja, origen, created_at, updated_at)
             VALUES (?, ?, 'baja', UTC_TIMESTAMP(3), ?, 'importacion', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
            [opciones.localId, item.telefonoCanonical, item.referenciaBaja],
          );
          if (result.affectedRows !== 1) throw new ContactoRecurrenciaError("PET_RECURRENCE_WRITE_CONFLICT");
        }
        resultados.push({ posicion, resultado: "registrar_baja" });
      }
    }
    if (aplicar) { await connection.commit(); started = false; }
    return { simulacion: !aplicar, localId: opciones.localId, total: operaciones.length, resultados };
  } finally {
    try { if (started) await connection.rollback(); }
    catch (error) { connection.destroy(); throw error; }
    connection.release();
  }
}
