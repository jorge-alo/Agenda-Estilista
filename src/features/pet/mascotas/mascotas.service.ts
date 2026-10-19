import { pool } from "../../../config/db";
import {
  CrearMascotaPayload,
  EditarMascotaPayload,
  EditarReservaOnlinePayload,
  AsociarResponsablePayload,
  CrearResponsablePayload,
  MascotaSearchQuery,
  MascotaSearchResult,
} from "./mascotas.types";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { InvalidClientPhoneError, normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { ClientPhoneConflictError, clientPhoneDuplicateKey } from "../../../shared/phone/clientPhoneDuplicate";

export interface Mascota {
  id: number;
  local_id: number;
  nombre: string;
  raza: string | null;
  fecha_nacimiento: string | null;
  sexo: string | null;
  tamano: string | null;
  tipo_pelo: string | null;
  observaciones: string | null;
  alta_exigencia: number;
  reserva_online_habilitada: number;
  activo: number;
  created_at: string;
  updated_at: string;
}

export interface MascotaConResponsables extends Mascota {
  responsables: Responsable[];
}

export interface Responsable {
  id: number;
  nombre: string;
  telefono: string;
  local_id: number;
  created_at: string;
}

export const crearMascota = async (localId: number, payload: CrearMascotaPayload): Promise<Mascota> => {
  const [result]: any = await pool.query(
    `INSERT INTO mascotas
     (local_id, nombre, raza, fecha_nacimiento, sexo, tamano, tipo_pelo, observaciones, alta_exigencia, reserva_online_habilitada, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)`,
    [
      localId,
      payload.nombre,
      payload.raza,
      payload.fecha_nacimiento,
      payload.sexo,
      payload.tamano,
      payload.tipo_pelo,
      payload.observaciones,
    ]
  );

  const [rows]: any = await pool.query(
    `SELECT id, local_id, nombre, raza,
        DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento,
        sexo, tamano, tipo_pelo, observaciones,
        alta_exigencia, reserva_online_habilitada, activo, created_at, updated_at
     FROM mascotas WHERE id = ? AND local_id = ?`,
    [result.insertId, localId]
  );

  if (rows.length === 0) {
    throw new Error("Mascota no encontrada después de crear");
  }

  return rows[0];
};

export const listarMascotas = async (localId: number): Promise<Mascota[]> => {
  const [rows]: any = await pool.query(
    `SELECT id, local_id, nombre, raza,
        DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento,
        sexo, tamano, tipo_pelo, observaciones,
        alta_exigencia, reserva_online_habilitada, activo, created_at, updated_at
     FROM mascotas WHERE local_id = ? ORDER BY created_at DESC`,
    [localId]
  );
  return rows;
};

interface MascotaSearchRow extends RowDataPacket {
  id: number;
  nombre: string;
  raza: string | null;
}

interface ResponsableSearchRow extends RowDataPacket {
  mascota_id: number;
  id: number;
  nombre: string;
  telefono: string;
}

// An explicit LIKE escape also keeps backslashes literal, independently of the search text.
function searchPattern(text: string): string {
  return `%${text.replace(/[!%_\\]/g, char => `!${char}`)}%`;
}

export const buscarMascotas = async (localId: number, query: MascotaSearchQuery): Promise<MascotaSearchResult[]> => {
  const values: Array<string | number> = [localId];
  let search = "";
  if (query.q !== "") {
    const pattern = searchPattern(query.q);
    values.push(pattern, pattern);
    let phone = "";
    if (/^[+\d\s().-]+$/.test(query.q) && /\d/.test(query.q)) {
      let canonical: string | null = null;
      try { canonical = normalizeClientPhone(query.q); }
      catch (error: unknown) { if (!(error instanceof InvalidClientPhoneError)) throw error; }
      phone = canonical !== null
        ? " OR c.telefono_normalizado = ?"
        : " OR c.telefono_normalizado LIKE ? ESCAPE '!'";
      values.push(canonical ?? searchPattern(query.q.replace(/\D/g, "")));
      phone += " OR (c.telefono_normalizado IS NULL AND c.telefono LIKE ? ESCAPE '!')";
      values.push(pattern);
    }
    search = ` AND (m.nombre LIKE ? ESCAPE '!' OR EXISTS (
      SELECT 1 FROM mascota_clientes mc
      JOIN clientes c ON c.id = mc.cliente_id AND c.local_id = mc.local_id
      WHERE mc.mascota_id = m.id AND mc.local_id = m.local_id
        AND (c.nombre LIKE ? ESCAPE '!'${phone})
    ))`;
  }
  values.push(query.limit);
  const [rows] = await pool.query<MascotaSearchRow[]>(
    `SELECT m.id, m.nombre, m.raza FROM mascotas m
     WHERE m.local_id = ? AND m.activo = 1${search}
     ORDER BY m.nombre ASC, m.id ASC LIMIT ?`,
    values,
  );
  if (rows.length === 0) return [];

  const [responsables] = await pool.query<ResponsableSearchRow[]>(
    `SELECT mc.mascota_id, c.id, c.nombre, c.telefono
     FROM mascota_clientes mc
     JOIN clientes c ON c.id = mc.cliente_id AND c.local_id = mc.local_id
     WHERE mc.local_id = ? AND mc.mascota_id IN (${rows.map(() => "?").join(",")})
     ORDER BY mc.mascota_id ASC, c.nombre ASC, c.id ASC`,
    [localId, ...rows.map(row => row.id)],
  );
  const results = rows.map(row => ({ id: row.id, nombre: row.nombre, raza: row.raza,
    responsables: [] as MascotaSearchResult["responsables"] }));
  const byId = new Map(results.map(item => [item.id, item]));
  for (const responsable of responsables) {
    byId.get(responsable.mascota_id)?.responsables.push({
      id: responsable.id, nombre: responsable.nombre, telefono: responsable.telefono,
    });
  }
  return results;
};

export const obtenerMascota = async (localId: number, mascotaId: number): Promise<Mascota | null> => {
  const [rows]: any = await pool.query(
    `SELECT id, local_id, nombre, raza,
        DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento,
        sexo, tamano, tipo_pelo, observaciones,
        alta_exigencia, reserva_online_habilitada, activo, created_at, updated_at
     FROM mascotas WHERE id = ? AND local_id = ?`,
    [mascotaId, localId]
  );
  return rows.length > 0 ? rows[0] : null;
};

export const obtenerMascotaConResponsables = async (localId: number, mascotaId: number): Promise<MascotaConResponsables | null> => {
  const [rows]: any = await pool.query(
    `SELECT id, local_id, nombre, raza,
        DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento,
        sexo, tamano, tipo_pelo, observaciones,
        alta_exigencia, reserva_online_habilitada, activo, created_at, updated_at
     FROM mascotas WHERE id = ? AND local_id = ?`,
    [mascotaId, localId]
  );

  if (rows.length === 0) return null;
  const mascota = rows[0];

  const [responsables]: any = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.local_id, c.created_at
     FROM clientes c
     JOIN mascota_clientes mc ON mc.cliente_id = c.id
     WHERE mc.mascota_id = ? AND mc.local_id = ?`,
    [mascotaId, localId]
  );

  return { ...mascota, responsables };
};

export const editarMascota = async (localId: number, mascotaId: number, payload: EditarMascotaPayload): Promise<Mascota> => {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (payload.nombre !== undefined) {
    fields.push("nombre = ?");
    values.push(payload.nombre);
  }
  if (payload.raza !== undefined) {
    fields.push("raza = ?");
    values.push(payload.raza);
  }
  if (payload.fecha_nacimiento !== undefined) {
    fields.push("fecha_nacimiento = ?");
    values.push(payload.fecha_nacimiento);
  }
  if (payload.sexo !== undefined) {
    fields.push("sexo = ?");
    values.push(payload.sexo);
  }
  if (payload.tamano !== undefined) {
    fields.push("tamano = ?");
    values.push(payload.tamano);
  }
  if (payload.tipo_pelo !== undefined) {
    fields.push("tipo_pelo = ?");
    values.push(payload.tipo_pelo);
  }
  if (payload.observaciones !== undefined) {
    fields.push("observaciones = ?");
    values.push(payload.observaciones);
  }
  if (payload.activo !== undefined) {
    fields.push("activo = ?");
    values.push(payload.activo ? 1 : 0);
  }
  if (payload.altaExigencia !== undefined) {
    fields.push("alta_exigencia = ?");
    values.push(payload.altaExigencia ? 1 : 0);
  }

  if (fields.length === 0) {
    return obtenerMascota(localId, mascotaId).then(m => {
      if (!m) throw new Error("Mascota no encontrada o no pertenece a tu local");
      return m!;
    });
  }

  values.push(mascotaId, localId);

  const [result]: any = await pool.query(
    `UPDATE mascotas SET ${fields.join(", ")} WHERE id = ? AND local_id = ?`,
    values
  );

  if (result.affectedRows === 0) {
    throw new Error("Mascota no encontrada o no pertenece a tu local");
  }

  const [rows]: any = await pool.query(
    `SELECT id, local_id, nombre, raza,
        DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento,
        sexo, tamano, tipo_pelo, observaciones,
        alta_exigencia, reserva_online_habilitada, activo, created_at, updated_at
     FROM mascotas WHERE id = ? AND local_id = ?`,
    [mascotaId, localId]
  );

  return rows[0];
};

export class MascotaReservaOnlineError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

interface MascotaReservaOnlineRow extends RowDataPacket {
  id: number;
  activo: number;
  reserva_online_habilitada: number;
}

export const editarReservaOnline = async (
  localId: number,
  mascotaId: number,
  payload: EditarReservaOnlinePayload,
): Promise<{ id: number; reservaOnlineHabilitada: boolean }> => {
  const value = payload.reservaOnlineHabilitada ? 1 : 0;
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE mascotas
     SET reserva_online_habilitada = ?
     WHERE id = ? AND local_id = ? AND (? = 0 OR activo = 1)`,
    [value, mascotaId, localId, value],
  );

  if (result.affectedRows === 1) {
    return { id: mascotaId, reservaOnlineHabilitada: payload.reservaOnlineHabilitada };
  }

  const [rows] = await pool.query<MascotaReservaOnlineRow[]>(
    `SELECT id, activo, reserva_online_habilitada
     FROM mascotas WHERE id = ? AND local_id = ?`,
    [mascotaId, localId],
  );
  if (!rows.length) throw new MascotaReservaOnlineError(404, "PET_MASCOTA_NOT_FOUND");
  if (payload.reservaOnlineHabilitada && rows[0].activo !== 1) {
    throw new MascotaReservaOnlineError(409, "PET_MASCOTA_INACTIVE");
  }
  if (rows[0].reserva_online_habilitada !== value) {
    throw new MascotaReservaOnlineError(409, "PET_MASCOTA_RESERVA_ONLINE_CONFLICT");
  }
  return { id: mascotaId, reservaOnlineHabilitada: payload.reservaOnlineHabilitada };
};

export const crearResponsable = async (localId: number, payload: CrearResponsablePayload): Promise<{ id: number; nombre: string; telefono: string; local_id: number; created_at: string; isNew: boolean }> => {
  const canonical = normalizeClientPhone(payload.telefono);
  const display = payload.telefono.trim();
  const [existing]: any = await pool.query(
    `SELECT id, nombre, telefono, local_id, created_at FROM clientes WHERE telefono_normalizado = ? AND local_id = ?`,
    [canonical, localId]
  );

  if (existing.length > 0) {
    return { ...existing[0], isNew: false };
  }

  let id: number;
  try {
    const [result]: any = await pool.query(
      `INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES (?, ?, ?, ?)`,
      [payload.nombre, display, canonical, localId]
    );
    id = result.insertId;
  } catch (error) {
    const key = clientPhoneDuplicateKey(error);
    if (!key) throw error;
    const [winner]: any = await pool.query(
      `SELECT id, nombre, telefono, local_id, created_at FROM clientes
       WHERE telefono_normalizado = ? AND local_id = ?`,
      [canonical, localId]
    );
    if (!winner.length) throw new ClientPhoneConflictError();
    return { ...winner[0], isNew: false };
  }

  const [rows]: any = await pool.query(
    `SELECT id, nombre, telefono, local_id, created_at FROM clientes WHERE id = ? AND local_id = ?`,
    [id, localId]
  );

  return { ...rows[0], isNew: true };
};

export const asociarResponsable = async (localId: number, mascotaId: number, payload: AsociarResponsablePayload): Promise<void> => {
  const [mascota]: any = await pool.query(
    `SELECT id FROM mascotas WHERE id = ? AND local_id = ?`,
    [mascotaId, localId]
  );

  if (mascota.length === 0) {
    throw new Error("Mascota no encontrada o no pertenece a tu local");
  }

  const [cliente]: any = await pool.query(
    `SELECT id FROM clientes WHERE id = ? AND local_id = ?`,
    [payload.clienteId, localId]
  );

  if (cliente.length === 0) {
    throw new Error("Cliente no encontrado o no pertenece a tu local");
  }

  try {
    await pool.query(
      `INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)`,
      [localId, mascotaId, payload.clienteId]
    );
  } catch (error: any) {
    if (error.code === "ER_DUP_ENTRY") {
      throw new Error("El responsable ya está asociado a esta mascota");
    }
    throw error;
  }
};

export const desasociarResponsable = async (localId: number, mascotaId: number, clienteId: number): Promise<void> => {
  const [result]: any = await pool.query(
    `DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?`,
    [mascotaId, clienteId, localId]
  );

  if (result.affectedRows === 0) {
    throw new Error("Asociación no encontrada o no pertenece a tu local");
  }
};
