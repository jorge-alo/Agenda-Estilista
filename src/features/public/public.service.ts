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

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 🔎 1. buscar local
    const [localRows]: any = await connection.query(
      `SELECT id, telefono, nombre FROM locales WHERE slug = ?`,
      [slug]
    );

    if (localRows.length === 0) {
      throw new Error("Local no encontrado");
    }

    const localNombre = localRows[0].nombre;
    const localId = localRows[0].id;
    const telefono = localRows[0].telefono;

    // 🔥 2. obtener duración del servicio
    const [servicioRows]: any = await connection.query(
      `SELECT duracion, nombre FROM servicios WHERE id = ?`,
      [servicio_id]
    );

    if (servicioRows.length === 0) {
      throw new Error("Servicio no encontrado");
    }

    const servicioNombre = servicioRows[0].nombre;
    const duracion = servicioRows[0].duracion;

    // 🧠 3. calcular hora_fin
    const hora_fin = sumarMinutos(hora, duracion);

    // 🚫 4. validar solapamiento CON BLOQUEO (FOR UPDATE) + filtro de cancelados
    const [rows]: any = await connection.query(
      `
      SELECT id
      FROM turnos
      WHERE estilista_id = ?
      AND fecha = ?
      AND estado != 'cancelado'
      AND (? < hora_fin AND ? > hora)
      FOR UPDATE
      `,
      [estilista_id, fecha, hora, hora_fin]
    );

    if (rows.length > 0) {
      throw new Error("Ese horario ya está ocupado");
    }

    // 👤 5. buscar cliente existente
    const [clientes]: any = await connection.query(
      `SELECT id FROM clientes WHERE telefono = ? AND local_id = ?`,
      [cliente_telefono, localId]
    );

    let clienteId;

    if (clientes.length > 0) {
      clienteId = clientes[0].id;
    } else {
      const [clienteResult]: any = await connection.query(
        `INSERT INTO clientes (nombre, telefono, local_id) VALUES (?, ?, ?)`,
        [cliente_nombre, cliente_telefono, localId]
      );
      clienteId = clienteResult.insertId;
    }

    // 💾 6. insertar turno
    const [result]: any = await connection.query(
      `
      INSERT INTO turnos (
        fecha, hora, hora_fin, estilista_id, servicio_id,
        local_id, cliente_nombre, cliente_telefono, cliente_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        fecha, hora, hora_fin, estilista_id, servicio_id,
        localId, cliente_nombre, cliente_telefono, clienteId,
      ]
    );

    await connection.commit();

    return {
      id: result.insertId,
      telefono,
      localNombre,
      servicioNombre,
      localId,
    };

  } catch (error: any) {
    await connection.rollback();

    if (error.code === "ER_DUP_ENTRY") {
      throw new Error("Ese horario ya está ocupado");
    }

    throw error;
  } finally {
    connection.release();
  }
};