import { pool } from "../../config/db";

export const createHorario = async (
  estilista_id: number,
  dia_semana: number,
  hora_inicio: string,
  hora_fin: string
) => {
  const [result]: any = await pool.query(
    `INSERT INTO horarios 
     (estilista_id, dia_semana, hora_inicio, hora_fin) 
     VALUES (?, ?, ?, ?)`,
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

export const desactivarHorario = async (id: number) => {
  await pool.query(
    "UPDATE horarios SET activo = false WHERE id = ?",
    [id]
  );
};

export const toggleHorario = async (id: number) => {
  await pool.query(
    `UPDATE horarios 
     SET activo = NOT activo 
     WHERE id = ?`,
    [id]
  );
};