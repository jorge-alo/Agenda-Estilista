import { pool } from "../../config/db";
import { sumarMinutos } from "../../helpers/sumarMinutos";
import { pagosService } from "../pagos/pagos.service";

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

  // Variables que necesitamos fuera del try de la transacción
  let turnoId: number;
  let telefono: string;
  let localNombre: string;
  let servicioNombre: string;
  let localIdFinal: number;
  let precio: number;

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

    localNombre = localRows[0].nombre;
    localIdFinal = localRows[0].id;
    telefono = localRows[0].telefono;

    // 🔥 2. obtener duración y PRECIO del servicio
    const [servicioRows]: any = await connection.query(
      `SELECT duracion, nombre, precio FROM servicios WHERE id = ?`,
      [servicio_id]
    );

    if (servicioRows.length === 0) {
      throw new Error("Servicio no encontrado");
    }

    servicioNombre = servicioRows[0].nombre;
    const duracion = servicioRows[0].duracion;
    precio = servicioRows[0].precio;

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
      [cliente_telefono, localIdFinal]
    );

    let clienteId;

    if (clientes.length > 0) {
      clienteId = clientes[0].id;
    } else {
      const [clienteResult]: any = await connection.query(
        `INSERT INTO clientes (nombre, telefono, local_id) VALUES (?, ?, ?)`,
        [cliente_nombre, cliente_telefono, localIdFinal]
      );
      clienteId = clienteResult.insertId;
    }

    // 💾 6. insertar turno con estado 'pendiente_pago'
    const [result]: any = await connection.query(
      `
      INSERT INTO turnos (
        fecha, hora, hora_fin, estilista_id, servicio_id,
        local_id, cliente_nombre, cliente_telefono, cliente_id, estado
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente_pago')
      `,
      [
        fecha, hora, hora_fin, estilista_id, servicio_id,
        localIdFinal, cliente_nombre, cliente_telefono, clienteId,
      ]
    );

    turnoId = result.insertId;

    // ✅ COMMIT ACÁ - liberamos los locks ANTES de llamar a Mercado Pago
    await connection.commit();

  } catch (error: any) {
    await connection.rollback();

    if (error.code === "ER_DUP_ENTRY") {
      throw new Error("Ese horario ya está ocupado");
    }

    throw error;
  } finally {
    connection.release();
  }

  // 💳 7. GENERAR LINK DE PAGO DE MERCADO PAGO
  // Esto ahora corre SIN transacción abierta y SIN locks de la tabla turnos,
  // así que no puede haber lock wait timeout ni deadlock con pagosService.
  try {
    const mpResult = await pagosService.crearPreference({
      turnoId,
      localId: localIdFinal,
      servicioNombre,
      monto: precio,
      tipo: 'seña',
      porcentajeSeña: 30,
    });

    return {
      id: turnoId,
      telefono,
      localNombre,
      servicioNombre,
      localId: localIdFinal,
      mpLink: mpResult.initPoint,
    };
  } catch (mpError: any) {
    console.error("Error generando link de pago:", mpError);
    // El turno ya quedó creado en estado 'pendiente_pago'.
    // El cleanup de 15 minutos en getDisponibilidad lo va a cancelar solo.
    throw new Error("Turno reservado, pero no se pudo generar el link de pago. Por favor intentá de nuevo.");
  }
};