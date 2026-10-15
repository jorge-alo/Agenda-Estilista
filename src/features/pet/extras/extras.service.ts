import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { pool } from "../../../config/db";
import { PetExtraError, type Extra, type ExtraConfigurado, type EditarExtraPayload } from "./extras.types";

type ExtraRow = RowDataPacket & Extra;
type ConfiguradoRow = RowDataPacket & ExtraConfigurado;

function esDuplicado(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY";
}

export async function listarCatalogo(localId: number): Promise<Extra[]> {
  const [rows] = await pool.query<ExtraRow[]>(
    "SELECT id, nombre, activo FROM extras WHERE local_id = ? ORDER BY nombre, id", [localId]
  );
  return rows;
}

export async function crearExtra(localId: number, nombre: string): Promise<Extra> {
  try {
    const [result] = await pool.query<ResultSetHeader>(
      "INSERT INTO extras (local_id, nombre, activo) VALUES (?, ?, 1)", [localId, nombre]
    );
    return { id: result.insertId, nombre, activo: 1 };
  } catch (error: unknown) {
    if (esDuplicado(error)) throw new PetExtraError(409, "Ya existe un extra con ese nombre en tu local");
    throw error;
  }
}

export async function editarExtra(localId: number, extraId: number, payload: EditarExtraPayload): Promise<Extra> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<ExtraRow[]>(
      "SELECT id, nombre, activo FROM extras WHERE id = ? AND local_id = ? FOR UPDATE", [extraId, localId]
    );
    if (!rows.length) throw new PetExtraError(404, "Extra no encontrado");
    const nombre = payload.nombre ?? rows[0].nombre;
    const activo = payload.activo === undefined ? rows[0].activo : Number(payload.activo);
    await connection.query(
      "UPDATE extras SET nombre = ?, activo = ? WHERE id = ? AND local_id = ?", [nombre, activo, extraId, localId]
    );
    await connection.commit();
    return { id: extraId, nombre, activo };
  } catch (error: unknown) {
    await connection.rollback();
    if (esDuplicado(error)) throw new PetExtraError(409, "Ya existe un extra con ese nombre en tu local");
    throw error;
  } finally {
    connection.release();
  }
}

export async function eliminarExtra(localId: number, extraId: number): Promise<void> {
  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM extras WHERE id = ? AND local_id = ?", [extraId, localId]
  );
  if (!result.affectedRows) throw new PetExtraError(404, "Extra no encontrado");
}

export async function listarConfigurados(localId: number, mascotaId: number): Promise<ExtraConfigurado[]> {
  const [mascotas] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM mascotas WHERE id = ? AND local_id = ?", [mascotaId, localId]
  );
  if (!mascotas.length) throw new PetExtraError(404, "Mascota no encontrada");
  const [rows] = await pool.query<ConfiguradoRow[]>(
    `SELECT e.id, e.nombre, e.activo, me.duracion_minutos
     FROM mascota_extras me
     JOIN extras e ON e.id = me.extra_id AND e.local_id = me.local_id
     WHERE me.mascota_id = ? AND me.local_id = ? ORDER BY e.nombre, e.id`, [mascotaId, localId]
  );
  return rows;
}

async function validarPadres(connection: PoolConnection, localId: number, mascotaId: number, extraId: number): Promise<Extra> {
  const [mascotas] = await connection.query<RowDataPacket[]>(
    "SELECT id FROM mascotas WHERE id = ? AND local_id = ? FOR SHARE", [mascotaId, localId]
  );
  if (!mascotas.length) throw new PetExtraError(404, "Mascota no encontrada");
  const [extras] = await connection.query<ExtraRow[]>(
    "SELECT id, nombre, activo FROM extras WHERE id = ? AND local_id = ? FOR SHARE", [extraId, localId]
  );
  if (!extras.length) throw new PetExtraError(404, "Extra no encontrado");
  return extras[0];
}

export async function guardarConfiguracion(localId: number, mascotaId: number, extraId: number, duracion: number, crear: boolean): Promise<ExtraConfigurado> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Igual que PET-03: mantener padres y estado del extra estables hasta escribir.
    const extra = await validarPadres(connection, localId, mascotaId, extraId);
    if (crear) {
      if (extra.activo !== 1) throw new PetExtraError(409, "Extra inactivo");
      await connection.query(
        "INSERT INTO mascota_extras (local_id, mascota_id, extra_id, duracion_minutos) VALUES (?, ?, ?, ?)",
        [localId, mascotaId, extraId, duracion]
      );
    } else {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT extra_id FROM mascota_extras WHERE mascota_id = ? AND extra_id = ? AND local_id = ? FOR UPDATE",
        [mascotaId, extraId, localId]
      );
      if (!rows.length) throw new PetExtraError(404, "Relación no encontrada");
      await connection.query(
        "UPDATE mascota_extras SET duracion_minutos = ? WHERE mascota_id = ? AND extra_id = ? AND local_id = ?",
        [duracion, mascotaId, extraId, localId]
      );
    }
    await connection.commit();
    return { id: extra.id, nombre: extra.nombre, activo: extra.activo, duracion_minutos: duracion };
  } catch (error: unknown) {
    await connection.rollback();
    if (esDuplicado(error)) throw new PetExtraError(409, "Extra ya asociado a la mascota");
    throw error;
  } finally {
    connection.release();
  }
}

export async function quitarConfiguracion(localId: number, mascotaId: number, extraId: number): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await validarPadres(connection, localId, mascotaId, extraId);
    const [result] = await connection.query<ResultSetHeader>(
      "DELETE FROM mascota_extras WHERE mascota_id = ? AND extra_id = ? AND local_id = ?",
      [mascotaId, extraId, localId]
    );
    if (!result.affectedRows) throw new PetExtraError(404, "Relación no encontrada");
    await connection.commit();
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
