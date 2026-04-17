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
  servicio_id: number
) => {
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

export const deleteServicio = async (id: number) => {
  const hoy = new Date().toISOString().split("T")[0]; // "2026-04-17"

  const [turnos]: any = await pool.query(
    "SELECT id FROM turnos WHERE servicio_id = ? AND fecha >= ?",
    [id, hoy]
  );

  if (turnos.length > 0) {
    throw new Error("Tiene turnos asociados");
  }

  await pool.query(
    "DELETE FROM estilista_servicios WHERE servicio_id = ?",
    [id]
  );

  await pool.query(
    "DELETE FROM servicios WHERE id = ?",
    [id]
  );
};

export const toggleServicio = async (id: number) => {
  await pool.query(
    `UPDATE servicios 
     SET activo = NOT activo 
     WHERE id = ?`,
    [id]
  );
};

export const desasignarServicio = async (
  estilista_id: number,
  servicio_id: number
) => {
  await pool.query(
    "DELETE FROM estilista_servicios WHERE estilista_id = ? AND servicio_id = ?",
    [estilista_id, servicio_id]
  );
};