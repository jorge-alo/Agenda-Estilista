import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../../config/db';
import { telefonoUtilizable } from './recordatorios.service';

export class PreferenciaD30Error extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export interface PreferenciaD30 {
  estado: 'habilitada' | 'autorizada' | 'baja' | 'sin_registro' | 'no_disponible';
  habilitada: boolean;
  revision: number;
  telefono: string | null;
}
export interface CambioD30 {
  habilitada: boolean;
  revision: number;
  telefono: string;
  operacionId: string;
}
interface Contacto extends RowDataPacket {
  estado: 'habilitada' | 'autorizada' | 'baja'; revision: number;
  cliente_id_autorizado: number | null;
}

export function validarCambioD30(body: unknown): CambioD30 {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PreferenciaD30Error(400, 'PET_D30_INVALID');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'habilitada,operacionId,revision,telefono'
    || typeof b.habilitada !== 'boolean' || typeof b.revision !== 'number' || !Number.isSafeInteger(b.revision)
    || b.revision < 0 || typeof b.telefono !== 'string' || !telefonoUtilizable(b.telefono)
    || typeof b.operacionId !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(b.operacionId)) {
    throw new PreferenciaD30Error(400, 'PET_D30_INVALID');
  }
  return b as unknown as CambioD30;
}

export async function leerPreferenciaD30(tx: Pick<PoolConnection, 'query'>, localId: number, clienteId: number): Promise<PreferenciaD30> {
  const [clients] = await tx.query<(RowDataPacket & { telefono_normalizado: string | null })[]>(
    'SELECT telefono_normalizado FROM clientes WHERE local_id=? AND id=?', [localId, clienteId]);
  if (!clients.length) throw new PreferenciaD30Error(404, 'PET_D30_NOT_FOUND');
  const telefono = clients[0].telefono_normalizado;
  if (!telefonoUtilizable(telefono)) return { estado: 'no_disponible', habilitada: false, revision: 0, telefono: null };
  const [contacts] = await tx.query<Contacto[]>(
    'SELECT estado,revision,cliente_id_autorizado FROM pet_recurrencia_contactos WHERE local_id=? AND telefono_normalizado=?', [localId, telefono]);
  const c = contacts[0];
  const compatible = !c || c.estado === 'baja' || c.cliente_id_autorizado === clienteId;
  return { estado: !compatible ? 'no_disponible' : c?.estado ?? 'sin_registro',
    habilitada: compatible && (c?.estado === 'habilitada' || c?.estado === 'autorizada'), revision: c?.revision ?? 0, telefono };
}

/** Caller owns local X. A new identity is initialized atomically with its creation. */
export async function inicializarPreferenciaD30(tx: PoolConnection, localId: number, clienteId: number,
  telefono: string, habilitada: boolean, operadorId: number): Promise<void> {
  const [existing] = await tx.query<RowDataPacket[]>(
    'SELECT estado FROM pet_recurrencia_contactos WHERE local_id=? AND telefono_normalizado=? FOR UPDATE', [localId, telefono]);
  if (existing.length) return; // Never inherit/reassign a historical permission or lift a phone opt-out.
  await tx.query(`INSERT INTO pet_recurrencia_contactos
    (local_id,telefono_normalizado,estado,cliente_id_autorizado,origen,operador_id,baja_at,referencia_baja,created_at,updated_at)
    VALUES (?,?,?,?,'alta_responsable',?,IF(? IS TRUE,NULL,UTC_TIMESTAMP(3)),?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
  [localId, telefono, habilitada ? 'habilitada' : 'baja', clienteId, operadorId,
    habilitada, habilitada ? null : 'checkbox_alta_desmarcado']);
}

export async function cambiarPreferenciaD30(localId: number, clienteId: number, operadorId: number, b: CambioD30) {
  const tx = await pool.getConnection();
  try {
    await tx.beginTransaction();
    await tx.query('SELECT id FROM locales WHERE id=? FOR UPDATE', [localId]);
    await tx.query('SELECT id FROM clientes WHERE local_id=? AND id=? FOR SHARE', [localId, clienteId]);
    const actual = await leerPreferenciaD30(tx, localId, clienteId);
    if (actual.telefono !== b.telefono) throw new PreferenciaD30Error(409, 'PET_D30_PHONE_CHANGED');
    const [events] = await tx.query<(RowDataPacket & { cliente_id: number; telefono_normalizado: string; estado: string; operador_id: number; revision: number })[]>(
      'SELECT cliente_id,telefono_normalizado,estado,operador_id,revision FROM pet_recurrencia_contacto_eventos WHERE local_id=? AND operacion_id=?', [localId, b.operacionId]);
    if (events.length) {
      const e = events[0];
      if (e.cliente_id !== clienteId || e.telefono_normalizado !== b.telefono || e.operador_id !== operadorId
        || e.revision !== b.revision + 1 || (e.estado !== 'baja') !== b.habilitada) throw new PreferenciaD30Error(409, 'PET_D30_OPERATION_CONFLICT');
      await tx.commit();
      return actual; // Already applied: return current state, never replay over a later decision.
    }
    if (actual.revision !== b.revision || (b.habilitada && actual.estado === 'no_disponible')) {
      throw new PreferenciaD30Error(409, 'PET_D30_CONFLICT');
    }
    if (actual.revision === 0) {
      await tx.query(`INSERT INTO pet_recurrencia_contactos
        (local_id,telefono_normalizado,estado,cliente_id_autorizado,origen,operador_id,operacion_id,baja_at,referencia_baja,created_at,updated_at)
        VALUES (?,?,?,?,'ficha',?,?,IF(? IS TRUE,NULL,UTC_TIMESTAMP(3)),?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [localId, b.telefono, b.habilitada ? 'habilitada' : 'baja', clienteId, operadorId, b.operacionId, b.habilitada, b.habilitada ? null : 'checkbox_ficha']);
    } else {
      const [changed] = await tx.query<ResultSetHeader>(`UPDATE pet_recurrencia_contactos SET estado=?,cliente_id_autorizado=?,
        verificada_at=NULL,referencia_verificacion=NULL,origen='ficha',operador_id=?,operacion_id=?,
        baja_at=IF(? IS TRUE,NULL,UTC_TIMESTAMP(3)),referencia_baja=?,updated_at=UTC_TIMESTAMP(3)
        WHERE local_id=? AND telefono_normalizado=? AND revision=?`,
      [b.habilitada ? 'habilitada' : 'baja', clienteId, operadorId, b.operacionId, b.habilitada,
        b.habilitada ? null : 'checkbox_ficha', localId, b.telefono, b.revision]);
      if (changed.affectedRows !== 1) throw new PreferenciaD30Error(409, 'PET_D30_CONFLICT');
    }
    const result = await leerPreferenciaD30(tx, localId, clienteId);
    await tx.commit();
    return result;
  } catch (error) { await tx.rollback(); throw error; }
  finally { tx.release(); }
}
