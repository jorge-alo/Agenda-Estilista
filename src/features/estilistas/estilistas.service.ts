import { pool } from "../../config/db";

export const createEstilista = async (nombre: string, localId: number) => {
  const [result]: any = await pool.query(
    "INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)",
    [nombre, localId]
  );

  return result.insertId;
};

export const getEstilistasByLocal = async (slug: string) => {
  const [local]: any = await pool.query(
    "SELECT id FROM locales WHERE slug = ?",
    [slug]
  );

  const localId = local[0].id;

  const [rows]: any = await pool.query(
    "SELECT id, nombre FROM estilistas WHERE local_id = ?",
    [localId]
  );

  return rows;
};

export const getEstilistasByLocalId = async (localId: number) => {
  console.log("VAlor de localId en getEstilistasByLocal", localId);
    const [rows]: any = await pool.query(
        "SELECT id, nombre FROM estilistas WHERE local_id = ?",
        [localId]
    );

    return rows;
};

export const updateEstilista = async (id: number, nombre: string, localId: number) => {
  const [result]: any = await pool.query(
    "UPDATE estilistas SET nombre = ? WHERE id = ? AND local_id = ?",
    [nombre, id, localId]
  );

  if (result.affectedRows === 0) {
    throw new Error("Estilista no encontrado o no pertenece a tu local");
  }
};

export const deleteEstilista = async (id: number, localId: number) => {
  // 🔒 Verificar que el estilista pertenece a este local
  const [estilistaRows]: any = await pool.query(
    "SELECT id FROM estilistas WHERE id = ? AND local_id = ?",
    [id, localId]
  );

  if (estilistaRows.length === 0) {
    throw new Error("Estilista no encontrado o no pertenece a tu local");
  }

  // 🚫 Bloquear si tiene turnos activos futuros (mismo patrón que deleteServicio)
  const hoy = new Date().toISOString().split("T")[0];

  const [turnos]: any = await pool.query(
    "SELECT id FROM turnos WHERE estilista_id = ? AND fecha >= ? AND estado = 'activo' AND local_id = ?",
    [id, hoy, localId]
  );

  if (turnos.length > 0) {
    throw new Error("Tiene turnos activos futuros");
  }

  // Limpieza de relaciones dependientes
  await pool.query("DELETE FROM estilista_servicios WHERE estilista_id = ?", [id]);
  await pool.query("DELETE FROM horarios WHERE estilista_id = ?", [id]);
  await pool.query("DELETE FROM bloqueos_horarios WHERE estilista_id = ? AND local_id = ?", [id, localId]);

  await pool.query("DELETE FROM estilistas WHERE id = ? AND local_id = ?", [id, localId]);
};