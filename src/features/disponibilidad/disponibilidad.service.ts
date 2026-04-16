import { pool } from "../../config/db";

export const getDisponibilidad = async (slug: string, fecha: string, servicio_id: number) => {
  const [localRows]: any = await pool.query(
    "SELECT id FROM locales WHERE slug = ?",
    [slug]
  );

  if (localRows.length === 0) {
    throw new Error("Local no encontrado");
  }

  const localId = localRows[0].id;

  const [turnos]: any = await pool.query(
    `SELECT hora, estilista_id 
     FROM turnos 
     WHERE fecha = ? AND local_id = ?`,
    [fecha, localId]
  );

  const [servicioRows]: any = await pool.query(
    "SELECT duracion FROM servicios WHERE id = ?",
    [servicio_id]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado");
  }

  const duracion = servicioRows[0].duracion;

  return { localId, turnos, duracion };
};