import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { pool } from "../../../config/db";
import { PetServicioError, type ServicioCatalogo, type EditarServicioPayload } from "./servicios.types";

type ServicioCatalogoRow = RowDataPacket & Omit<ServicioCatalogo, "activo"> & { activo: 0 | 1 | null };

function dtoCatalogo(row: Pick<ServicioCatalogoRow, "id" | "nombre" | "activo">): ServicioCatalogo {
  return { id: row.id, nombre: row.nombre, activo: row.activo ?? 0 };
}

async function validarMascota(localId: number, mascotaId: number) {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM mascotas WHERE id = ? AND local_id = ?", [mascotaId, localId]
  );
  if (!rows.length) throw new PetServicioError(404, "Mascota no encontrada");
}

async function validarPadres(connection: PoolConnection, localId: number, mascotaId: number, servicioId: number) {
  const [mascotas] = await connection.query<RowDataPacket[]>(
    "SELECT id FROM mascotas WHERE id = ? AND local_id = ? FOR SHARE", [mascotaId, localId]
  );
  if (!mascotas.length) throw new PetServicioError(404, "Mascota no encontrada");
  const [servicios] = await connection.query<RowDataPacket[]>(
    "SELECT id, activo FROM servicios WHERE id = ? AND local_id = ? FOR SHARE", [servicioId, localId]
  );
  if (!servicios.length) throw new PetServicioError(404, "Servicio no encontrado");
  return servicios[0];
}

export async function listarCatalogo(localId: number): Promise<ServicioCatalogo[]> {
  const [rows] = await pool.query<ServicioCatalogoRow[]>(
    "SELECT id, nombre, activo FROM servicios WHERE local_id = ? ORDER BY nombre ASC, id ASC", [localId]
  );
  return rows.map(dtoCatalogo);
}

export async function crearServicio(localId: number, nombre: string): Promise<ServicioCatalogo> {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO servicios (nombre, duracion, precio, local_id, activo) VALUES (?, NULL, NULL, ?, 1)",
    [nombre, localId]
  );
  return { id: result.insertId, nombre, activo: 1 };
}

export async function editarServicio(localId: number, servicioId: number, payload: EditarServicioPayload): Promise<ServicioCatalogo> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<ServicioCatalogoRow[]>(
      "SELECT id, nombre, activo FROM servicios WHERE id = ? AND local_id = ? FOR UPDATE", [servicioId, localId]
    );
    if (!rows.length) throw new PetServicioError(404, "Servicio no encontrado");
    // Reconstruir solo desde la fila bloqueada; preservar incluso NULL legacy si se omite activo.
    const nombre = payload.nombre ?? rows[0].nombre;
    const activo = payload.activo === undefined ? rows[0].activo : payload.activo ? 1 : 0;
    await connection.query(
      "UPDATE servicios SET nombre = ?, activo = ? WHERE id = ? AND local_id = ?",
      [nombre, activo, servicioId, localId]
    );
    await connection.commit();
    return dtoCatalogo({ id: servicioId, nombre, activo });
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listarConfigurados(localId: number, mascotaId: number) {
  await validarMascota(localId, mascotaId);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.id, s.nombre, s.activo, ms.duracion_minutos
     FROM mascota_servicios ms
     JOIN servicios s ON s.id = ms.servicio_id AND s.local_id = ms.local_id
     WHERE ms.mascota_id = ? AND ms.local_id = ? ORDER BY s.nombre, s.id`, [mascotaId, localId]
  );
  return rows;
}

export async function guardarConfiguracion(localId: number, mascotaId: number, servicioId: number, duracion: number, crear: boolean) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Mantener los padres estables hasta escribir: una desactivación concurrente
    // del servicio no puede intercalarse entre su validación y el INSERT.
    const servicio = await validarPadres(connection, localId, mascotaId, servicioId);
    if (crear) {
      if (servicio.activo !== 1) throw new PetServicioError(409, "Servicio inactivo");
      await connection.query(
        "INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, ?)",
        [localId, mascotaId, servicioId, duracion]
      );
    } else {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT servicio_id FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ? AND local_id = ? FOR UPDATE",
        [mascotaId, servicioId, localId]
      );
      if (!rows.length) throw new PetServicioError(404, "Relación no encontrada");
      await connection.query(
        "UPDATE mascota_servicios SET duracion_minutos = ? WHERE mascota_id = ? AND servicio_id = ? AND local_id = ?",
        [duracion, mascotaId, servicioId, localId]
      );
    }
    await connection.commit();
    return { servicioId, duracion_minutos: duracion };
  } catch (error: unknown) {
    await connection.rollback();
    if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY") {
      throw new PetServicioError(409, "Servicio ya asociado a la mascota");
    }
    throw error;
  } finally {
    connection.release();
  }
}

export async function quitarConfiguracion(localId: number, mascotaId: number, servicioId: number) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await validarPadres(connection, localId, mascotaId, servicioId);
    const [result] = await connection.query<ResultSetHeader>(
      "DELETE FROM mascota_servicios WHERE mascota_id = ? AND servicio_id = ? AND local_id = ?",
      [mascotaId, servicioId, localId]
    );
    if (!result.affectedRows) throw new PetServicioError(404, "Relación no encontrada");
    await connection.commit();
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
