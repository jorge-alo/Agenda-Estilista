import type { RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise";
import { pool } from "../../../config/db";
import { HorarioError, validarIntervalo, type Horario, type HorarioPayload } from "./horarios.types";

type HorarioRow = RowDataPacket & Horario;

async function bloquearLocal(connection: PoolConnection, localId: number): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT id FROM locales WHERE id = ? FOR UPDATE", [localId]);
  if (!rows.length) throw new HorarioError(404, "Local no encontrado");
}

export async function listar(localId: number): Promise<Horario[]> {
  const [rows] = await pool.query<HorarioRow[]>(
    "SELECT id, dia_semana, hora_inicio, hora_fin, activo FROM horarios_local WHERE local_id = ? ORDER BY dia_semana, hora_inicio, id", [localId]
  );
  return rows;
}

export async function guardar(localId: number, payload: HorarioPayload, horarioId?: number): Promise<Horario> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Serializa incluso con agenda vacía. Siempre adquirir local antes que recurso.
    await bloquearLocal(connection, localId);
    let actual: Horario | undefined;
    if (horarioId !== undefined) {
      const [rows] = await connection.query<HorarioRow[]>(
        "SELECT id, dia_semana, hora_inicio, hora_fin, activo FROM horarios_local WHERE id = ? AND local_id = ? FOR UPDATE", [horarioId, localId]
      );
      if (!rows.length) throw new HorarioError(404, "Horario no encontrado");
      actual = rows[0];
    }
    const dia = payload.diaSemana ?? actual?.dia_semana;
    const inicio = payload.horaInicio ?? actual?.hora_inicio;
    const fin = payload.horaFin ?? actual?.hora_fin;
    const activo = actual ? (payload.activo === undefined ? actual.activo : Number(payload.activo)) : 1;
    if (dia === undefined || inicio === undefined || fin === undefined) throw new HorarioError(400, "Horario incompleto");
    validarIntervalo(inicio, fin);
    if (activo === 1) {
      // Primera lectura consistente tras adquirir el lock local: ve el commit
      // anterior sin tomar gap locks que interfieran con otros locales.
      const [conflictos] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM horarios_local WHERE local_id = ? AND dia_semana = ? AND activo = 1
         AND id <> ? AND ? < hora_fin AND ? > hora_inicio`,
        [localId, dia, horarioId ?? 0, inicio, fin]
      );
      if (conflictos.length) throw new HorarioError(409, "Horario solapado");
    }
    let id = horarioId;
    if (id === undefined) {
      const [result] = await connection.query<ResultSetHeader>(
        "INSERT INTO horarios_local (local_id, dia_semana, hora_inicio, hora_fin, activo) VALUES (?, ?, ?, ?, 1)", [localId, dia, inicio, fin]
      );
      id = result.insertId;
    } else {
      await connection.query(
        "UPDATE horarios_local SET dia_semana = ?, hora_inicio = ?, hora_fin = ?, activo = ? WHERE id = ? AND local_id = ?", [dia, inicio, fin, activo, id, localId]
      );
    }
    await connection.commit();
    return { id, dia_semana: dia, hora_inicio: inicio, hora_fin: fin, activo };
  } catch (error: unknown) {
    await connection.rollback();
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") throw new HorarioError(409, "Horario duplicado (incluidos inactivos)");
    throw error;
  } finally { connection.release(); }
}

export async function eliminar(localId: number, horarioId: number): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await bloquearLocal(connection, localId);
    const [result] = await connection.query<ResultSetHeader>("DELETE FROM horarios_local WHERE id = ? AND local_id = ?", [horarioId, localId]);
    if (!result.affectedRows) throw new HorarioError(404, "Horario no encontrado");
    await connection.commit();
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
