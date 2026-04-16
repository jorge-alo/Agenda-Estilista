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