import { pool } from "../../config/db";

export const createServicio = async (
  nombre: string,
  duracion: number,
  precio: number,
  local_id: number
) => {
  const [result]: any = await pool.query(
    "INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, ?, ?, ?)",
    [nombre, duracion, precio, local_id]
  );

  return result.insertId;
};

export const getServiciosByLocal = async (slug: string) => {
  const [rows]: any = await pool.query(
    `
    SELECT s.* 
    FROM servicios s
    JOIN locales l ON s.local_id = l.id
    WHERE l.slug = ?
    `,
    [slug]
  );

  return rows;
};

export const getServiciosAdminByLocalId = async (localId: number) => {
  const [rows]: any = await pool.query(
    `
    SELECT * 
    FROM servicios
    WHERE local_id = ?
    `,
    [localId]
  );

  return rows;
};



export const asignarServicioAEstilista = async (
  estilista_id: number,
  servicio_id: number,
  localId: number
) => {
  // 🔒 Verificar que tanto el estilista como el servicio pertenecen a este local
  const [check]: any = await pool.query(
    `
    SELECT
      (SELECT COUNT(*) FROM estilistas WHERE id = ? AND local_id = ?) AS estilista_ok,
      (SELECT COUNT(*) FROM servicios WHERE id = ? AND local_id = ?) AS servicio_ok
    `,
    [estilista_id, localId, servicio_id, localId]
  );

  if (check[0].estilista_ok === 0 || check[0].servicio_ok === 0) {
    throw new Error("El estilista o el servicio no pertenece a tu local");
  }

  try {
    await pool.query(
      "INSERT INTO estilista_servicios (estilista_id, servicio_id) VALUES (?, ?)",
      [estilista_id, servicio_id]
    );
  } catch (error: any) {
    if (error.code === "ER_DUP_ENTRY") {
      throw new Error("El servicio ya está asignado a este estilista");
    }
    throw error;
  }
};

export const getServiciosByEstilista = async (estilista_id: number) => {
  const [rows]: any = await pool.query(
    `
    SELECT s.*
    FROM servicios s
    JOIN estilista_servicios es ON s.id = es.servicio_id
    WHERE es.estilista_id = ?
    AND s.activo = true
    `,
    [estilista_id]
  );

  return rows;
};

export const deleteServicio = async (id: number, localId: number) => {
  const hoy = new Date().toISOString().split("T")[0];

  const [turnos]: any = await pool.query(
    "SELECT id FROM turnos WHERE servicio_id = ? AND fecha >= ? AND estado = 'activo' AND local_id = ?",
    [id, hoy, localId]
  );

  if (turnos.length > 0) {
    throw new Error("Tiene turnos asociados");
  }

  await pool.query(
    "UPDATE turnos SET servicio_id = NULL WHERE servicio_id = ? AND local_id = ?",
    [id, localId]
  );

  // 🔒 Verificar que el servicio realmente pertenece a este local ANTES de borrar
  const [servicioRows]: any = await pool.query(
    "SELECT id FROM servicios WHERE id = ? AND local_id = ?",
    [id, localId]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado o no pertenece a tu local");
  }

  await pool.query("DELETE FROM estilista_servicios WHERE servicio_id = ?", [id]);
  await pool.query("DELETE FROM servicios WHERE id = ? AND local_id = ?", [id, localId]);
};

export const toggleServicio = async (id: number, localId: number) => {
   const [result]: any = await pool.query(
    `UPDATE servicios SET activo = NOT activo WHERE id = ? AND local_id = ?`,
    [id, localId]
  );

  if (result.affectedRows === 0) {
    throw new Error("Servicio no encontrado o no pertenece a tu local");
  }
};

// service
export const desasignarServicio = async (
  estilista_id: number,
  servicio_id: number,
  localId: number
) => {
  const [check]: any = await pool.query(
    `SELECT COUNT(*) AS ok FROM estilistas WHERE id = ? AND local_id = ?`,
    [estilista_id, localId]
  );

  if (check[0].ok === 0) {
    throw new Error("El estilista no pertenece a tu local");
  }

  await pool.query(
    "DELETE FROM estilista_servicios WHERE estilista_id = ? AND servicio_id = ?",
    [estilista_id, servicio_id]
  );
};