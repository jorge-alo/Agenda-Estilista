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

  let turnoId: number;
  let telefono: string;
  let localNombre: string;
  let servicioNombre: string;
  let localIdFinal: number;
  let precio: number;
  let mpAccessToken: string | null;
  let requiereSena: boolean;

  try {
    await connection.beginTransaction();

    // 🔎 1. buscar local (✅ AGREGAMOS requiere_sena)
    const [localRows]: any = await connection.query(
      `SELECT id, telefono, nombre, mp_access_token, requiere_sena FROM locales WHERE slug = ?`,
      [slug]
    );

    if (localRows.length === 0) {
      throw new Error("Local no encontrado");
    }

    localNombre = localRows[0].nombre;
    localIdFinal = localRows[0].id;
    telefono = localRows[0].telefono;
    mpAccessToken = localRows[0].mp_access_token;
    requiereSena = Boolean(localRows[0].requiere_sena); // ✅ OBTENEMOS EL VALOR (default true)

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
    const hora_fin = sumarMinutos(hora, duracion);

    // 🚫 3. validar solapamiento CON BLOQUEO
    const [rows]: any = await connection.query(
      `SELECT id FROM turnos 
       WHERE estilista_id = ? AND fecha = ? AND estado != 'cancelado' 
       AND (? < hora_fin AND ? > hora) 
       FOR UPDATE`,
      [estilista_id, fecha, hora, hora_fin]
    );

    if (rows.length > 0) {
      throw new Error("Ese horario ya está ocupado");
    }

    // 👤 4. buscar o crear cliente
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

    // 💾 5. insertar turno con ESTADO DINÁMICO
    const estadoInicial = requiereSena ? 'pendiente_pago' : 'activo';

    const [result]: any = await connection.query(
      `INSERT INTO turnos (
        fecha, hora, hora_fin, estilista_id, servicio_id, 
        local_id, cliente_nombre, cliente_telefono, cliente_id, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fecha, hora, hora_fin, estilista_id, servicio_id,
        localIdFinal, cliente_nombre, cliente_telefono, clienteId, estadoInicial
      ]
    );

    turnoId = result.insertId;

    // ✅ COMMIT: liberamos los locks
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

  // 💳 6. GENERAR LINK DE PAGO **SOLO SI REQUIERE SEÑA**
  if (requiereSena) {
    // ✅ AQUÍ SÍ validamos, porque si el local ELIGE cobrar seña, es OBLIGATORIO tener MP configurado
    if (!mpAccessToken) {
      throw new Error(
        "Este local tiene activado el cobro de seña, pero no ha configurado Mercado Pago. Contactá al administrador."
      );
    }

    try {
      const mpResult = await pagosService.crearPreference({
        turnoId,
        localId: localIdFinal,
        servicioNombre,
        monto: precio,
        tipo: "seña",
        porcentajeSeña: 30,
        accessToken: mpAccessToken,
         slug,
      });

      return {
        id: turnoId,
        telefono,
        localNombre,
        servicioNombre,
        localId: localIdFinal,
        mpLink: mpResult.initPoint, // ✅ Devuelve el link para redirigir
      };
    } catch (error: any) {
      console.error("❌ ERROR GENERANDO LINK DE PAGO:", error);
      throw new Error("Turno reservado, pero no se pudo generar el link de pago. Por favor intentá de nuevo.");
    }
  }

  // ✅ 7. SI NO REQUIERE SEÑA: El turno ya está 'activo' y no hay link de pago
  return {
    id: turnoId,
    telefono,
    localNombre,
    servicioNombre,
    localId: localIdFinal,
    mpLink: null, // ✅ El frontend usará esto para saber que debe mostrar "Éxito" directamente
  };
};

export const obtenerTurnoPublico = async (turnoId: number) => {
  const [turnos]: any = await pool.query(
    `SELECT t.fecha, t.hora, t.cliente_nombre, t.estado,
            s.nombre AS servicioNombre,
            l.nombre AS localNombre
     FROM turnos t
     JOIN servicios s ON t.servicio_id = s.id
     JOIN locales l ON t.local_id = l.id
     WHERE t.id = ?`,
    [turnoId]
  );

  if (turnos.length === 0) {
    throw new Error("Turno no encontrado");
  }

  return turnos[0];
};