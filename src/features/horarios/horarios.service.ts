import { pool } from "../../config/db";

export const createHorario = async (
  estilista_id: number,
  dia_semana: number,
  hora_inicio: string,
  hora_fin: string,
  localId: number
) => {
  // 🔒 Verificar que el estilista pertenece a este local antes de crear el horario
  const [estilistaRows]: any = await pool.query(
    "SELECT id FROM estilistas WHERE id = ? AND local_id = ?",
    [estilista_id, localId]
  );

  if (estilistaRows.length === 0) {
    throw new Error("El estilista no pertenece a tu local");
  }

  const [result]: any = await pool.query(
    `INSERT INTO horarios (estilista_id, dia_semana, hora_inicio, hora_fin) VALUES (?, ?, ?, ?)`,
    [estilista_id, dia_semana, hora_inicio, hora_fin]
  );

  return result.insertId;
};

export const getHorariosByEstilista = async (estilista_id: number) => {
  const [rows]: any = await pool.query(
    "SELECT * FROM horarios WHERE estilista_id = ?",
    [estilista_id]
  );

  return rows;
};

export const desactivarHorario = async (id: number, localId: number) => {
  const [result]: any = await pool.query(
    `UPDATE horarios h
     JOIN estilistas e ON h.estilista_id = e.id
     SET h.activo = false
     WHERE h.id = ? AND e.local_id = ?`,
    [id, localId]
  );

  if (result.affectedRows === 0) {
    throw new Error("Horario no encontrado o no pertenece a tu local");
  }
};

export const toggleHorario = async (id: number, localId: number) => {
  const [result]: any = await pool.query(
    `UPDATE horarios h
     JOIN estilistas e ON h.estilista_id = e.id
     SET h.activo = NOT h.activo
     WHERE h.id = ? AND e.local_id = ?`,
    [id, localId]
  );

  if (result.affectedRows === 0) {
    throw new Error("Horario no encontrado o no pertenece a tu local");
  }
};