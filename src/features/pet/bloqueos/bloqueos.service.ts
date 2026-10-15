import type { RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise";
import { pool } from "../../../config/db";
import { BloqueoError, reconstruir, type Bloqueo, type BloqueoPayload } from "./bloqueos.types";

type BloqueoRow = RowDataPacket & Bloqueo;
const columnas = "id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, hora_inicio, hora_fin, motivo, es_dia_completo";

async function bloquearLocal(connection: PoolConnection, localId: number): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT id FROM locales WHERE id = ? FOR UPDATE", [localId]);
  if (!rows.length) throw new BloqueoError(404, "Local no encontrado");
}

export async function listar(localId: number, rango: { desde?: string; hasta?: string }): Promise<Bloqueo[]> {
  const values: unknown[] = [localId];
  let filtro = "";
  if (rango.desde !== undefined && rango.hasta !== undefined) {
    filtro = " AND fecha BETWEEN ? AND ?";
    values.push(rango.desde, rango.hasta);
  }
  const [rows] = await pool.query<BloqueoRow[]>(`SELECT ${columnas} FROM bloqueos_local WHERE local_id = ?${filtro} ORDER BY fecha, hora_inicio, id`, values);
  return rows;
}

export async function guardar(localId: number, payload: BloqueoPayload, bloqueoId?: number): Promise<Bloqueo> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await bloquearLocal(connection, localId);
    let actual: Bloqueo | undefined;
    if (bloqueoId !== undefined) {
      const [rows] = await connection.query<BloqueoRow[]>(`SELECT ${columnas} FROM bloqueos_local WHERE id = ? AND local_id = ? FOR UPDATE`, [bloqueoId, localId]);
      if (!rows.length) throw new BloqueoError(404, "Bloqueo no encontrado");
      actual = rows[0];
    }
    const final = reconstruir(payload, actual);
    // Primera lectura consistente tras adquirir el lock local: ve el commit
    // anterior sin tomar gap locks que interfieran con otros locales.
    // No consultar horarios: un bloqueo dentro de un horario es válido.
    const [conflictos] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM bloqueos_local WHERE local_id = ? AND fecha = ? AND id <> ?
       AND (? = 1 OR es_dia_completo = 1 OR (? < hora_fin AND ? > hora_inicio))`,
      [localId, final.fecha, bloqueoId ?? 0, final.es_dia_completo, final.hora_inicio, final.hora_fin]
    );
    if (conflictos.length) throw new BloqueoError(409, "Bloqueo solapado");
    let id = bloqueoId;
    if (id === undefined) {
      const [result] = await connection.query<ResultSetHeader>(
        "INSERT INTO bloqueos_local (local_id, fecha, hora_inicio, hora_fin, motivo, es_dia_completo) VALUES (?, ?, ?, ?, ?, ?)",
        [localId, final.fecha, final.hora_inicio, final.hora_fin, final.motivo, final.es_dia_completo]
      );
      id = result.insertId;
    } else {
      await connection.query(
        "UPDATE bloqueos_local SET fecha = ?, hora_inicio = ?, hora_fin = ?, motivo = ?, es_dia_completo = ? WHERE id = ? AND local_id = ?",
        [final.fecha, final.hora_inicio, final.hora_fin, final.motivo, final.es_dia_completo, id, localId]
      );
    }
    await connection.commit();
    return { id, ...final };
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export async function eliminar(localId: number, bloqueoId: number): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await bloquearLocal(connection, localId);
    const [result] = await connection.query<ResultSetHeader>("DELETE FROM bloqueos_local WHERE id = ? AND local_id = ?", [bloqueoId, localId]);
    if (!result.affectedRows) throw new BloqueoError(404, "Bloqueo no encontrado");
    await connection.commit();
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
