import { pool } from "../../../config/db";
import {
  CrearMascotaPayload,
  EditarMascotaPayload,
  AsociarResponsablePayload,
  CrearResponsablePayload,
} from "./mascotas.types";

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

export const crearResponsable = async (localId: number, payload: CrearResponsablePayload): Promise<{ id: number; nombre: string; telefono: string; local_id: number; created_at: string; isNew: boolean }> => {
  const [existing]: any = await pool.query(
    `SELECT * FROM clientes WHERE telefono = ? AND local_id = ?`,
    [payload.telefono, localId]
  );

  if (existing.length > 0) {
    return { ...existing[0], isNew: false };
  }

  const [result]: any = await pool.query(
    `INSERT INTO clientes (nombre, telefono, local_id) VALUES (?, ?, ?)`,
    [payload.nombre, payload.telefono, localId]
  );

  const [rows]: any = await pool.query(
    `SELECT * FROM clientes WHERE id = ? AND local_id = ?`,
    [result.insertId, localId]
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
