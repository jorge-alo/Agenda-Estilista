import { pool } from "../../config/db";
import { sumarMinutos } from "../../helpers/sumarMinutos";

export const createTurnoPublico = async (data: any) => {
  const {
    slug,
    fecha,
    hora,
    estilista_id,
    servicio_id,
    cliente_nombre,
    cliente_telefono,
  } = data;

  // 🔎 1. buscar local
  const [localRows]: any = await pool.query(
    "SELECT id, telefono FROM locales WHERE slug = ?",
    [slug]
  );

  if (localRows.length === 0) {
    throw new Error("Local no encontrado");
  }

  const localId = localRows[0].id;
  const telefono = localRows[0].telefono
  // 🔥 2. obtener duración del servicio
  const [servicioRows]: any = await pool.query(
    "SELECT duracion FROM servicios WHERE id = ?",
    [servicio_id]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado");
  }

  const duracion = servicioRows[0].duracion;

  // 🧠 3. calcular hora_fin
  const hora_fin = sumarMinutos(hora, duracion);

  // 🚫 4. validar solapamiento REAL
  const [rows]: any = await pool.query(
    `SELECT id FROM turnos 
     WHERE estilista_id = ?
     AND fecha = ?
     AND (
       (? < hora_fin) AND (? > hora)
     )`,
    [estilista_id, fecha, hora, hora_fin]
  );

  if (rows.length > 0) {
    throw new Error("Horario no disponible");
  }

  // 💾 5. insertar turno
  const [result]: any = await pool.query(
    `INSERT INTO turnos 
    (fecha, hora, hora_fin, estilista_id, servicio_id, local_id, cliente_nombre, cliente_telefono)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fecha,
      hora,
      hora_fin,
      estilista_id,
      servicio_id,
      localId,
      cliente_nombre,
      cliente_telefono,
    ]
  );

  return {id: result.insertId, telefono };
};