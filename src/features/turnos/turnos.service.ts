import { pool } from "../../config/db";
import { ResultSetHeader } from "mysql2";
import { generarHorarios } from "../../helpers/generarHorarios";
import { sumarMinutos } from "../../helpers/sumarMinutos"
import { normalizeClientPhone } from "../../shared/phone/normalizeClientPhone";
import { ClientPhoneConflictError, clientPhoneDuplicateKey } from "../../shared/phone/clientPhoneDuplicate";
import { duracionBeautyValida } from "../servicios/servicio.validation";

export class ReprogramarError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const createTurno = async (data: any) => {
  const {
    fecha,
    hora,
    estilista_id,
    servicio_id,
    local_id,
    cliente_nombre,
    cliente_telefono,
  } = data;

  const canonical = normalizeClientPhone(cliente_telefono);
  const display = cliente_telefono.trim();

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 🔍 1. Duración del servicio
    const [servicioRows]: any = await connection.query(
      `SELECT s.duracion FROM servicios s
       JOIN locales l ON l.id = s.local_id AND l.business_type = 'BEAUTY'
       WHERE s.id = ? AND s.local_id = ?`,
      [servicio_id, local_id]
    );

    if (servicioRows.length === 0 || !duracionBeautyValida(servicioRows[0].duracion)) {
      throw new Error("Servicio no encontrado");
    }

    const duracion = servicioRows[0].duracion;
    const hora_fin = sumarMinutos(hora, duracion);

    // 🚫 2. Validar solapamiento CON BLOQUEO (FOR UPDATE)
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

    // 👤 3. Buscar/crear cliente
    const [clientes]: any = await connection.query(
      `SELECT id FROM clientes WHERE telefono_normalizado = ? AND local_id = ?`,
      [canonical, local_id]
    );

    let clienteId;

    if (clientes.length > 0) {
      clienteId = clientes[0].id;
    } else {
      try {
        const [clienteResult]: any = await connection.query(
          `INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES (?, ?, ?, ?)`,
          [cliente_nombre, display, canonical, local_id]
        );
        clienteId = clienteResult.insertId;
      } catch (error) {
        const key = clientPhoneDuplicateKey(error);
        if (!key) throw error;
        const [winner]: any = await connection.query(
          `SELECT id FROM clientes WHERE telefono_normalizado = ? AND local_id = ? FOR UPDATE`,
          [canonical, local_id]
        );
        if (!winner.length) throw new ClientPhoneConflictError();
        clienteId = winner[0].id;
      }
    }

    // 💾 4. Insertar turno
    const [result]: any = await connection.query(
      `
      INSERT INTO turnos (
        fecha, hora, hora_fin, estilista_id, servicio_id,
        local_id, cliente_nombre, cliente_telefono, cliente_id, estado
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo')
      `,
      [
        fecha, hora, hora_fin, estilista_id, servicio_id,
        local_id, cliente_nombre, cliente_telefono, clienteId,
      ]
    );

    await connection.commit();
    return result.insertId;
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

export const getTurnosByFecha = async (fecha: string, localId: number) => {
  const [rows]: any = await pool.query(
    `SELECT 
        t.*, 
        e.nombre as estilista_nombre,
        s.nombre as servicio_nombre
     FROM turnos t
     JOIN estilistas e ON t.estilista_id = e.id
     JOIN servicios s ON t.servicio_id = s.id
     WHERE t.fecha = ? AND t.local_id = ? AND t.estado = 'activo'
     ORDER BY t.hora ASC`,
    [fecha, localId]
  );

  return rows;
};

export const getTurnosByFechaPublico = async (
  fecha: string,
  slug: string
) => {
  const [localRows]: any = await pool.query(
    "SELECT id FROM locales WHERE slug = ?",
    [slug]
  );

  if (localRows.length === 0) {
    throw new Error("Local no encontrado");
  }

  const localId = localRows[0].id;

  return getTurnosByFecha(fecha, localId);
};
export const getDisponibilidad = async (
  slug: string,
  fecha: string,
  estilistaId: number,
  servicio_id: number
) => {
  // 🔍 1. Obtener local
  const [localRows]: any = await pool.query(
    "SELECT id, nombre, descripcion, direccion, telefono, horario_apertura, horario_cierre, activo, suscripcion_estado, suscripcion_vencimiento FROM locales WHERE slug = ? AND business_type = 'BEAUTY'",
    [slug]
  );

  if (localRows.length === 0) {
    throw new Error("Local no encontrado");
  }

  const local = localRows[0];

  // ✅ NUEVO: Validar si el local está bloqueado por el SuperAdmin o por falta de pago
  const hoy = new Date();
  const vencimiento = local.suscripcion_vencimiento ? new Date(local.suscripcion_vencimiento) : null;
  const estaVencido = vencimiento ? hoy > vencimiento : false;

  // 🕵️‍♂️ RASTREADOR 1: Ver qué datos trae realmente de la BD
  console.log("🔍 DEBUG BACKEND SERVICE - DATOS DEL LOCAL:", {
    activo: local.activo,
    estado: local.suscripcion_estado,
    vencimientoDB: local.suscripcion_vencimiento,
    fechaHoy: hoy.toISOString(),
    estaVencido: estaVencido
  });

  if (local.activo === 0 || local.suscripcion_estado === 'vencido' || estaVencido) {
    // Lanzamos un error específico que el frontend podrá reconocer
    throw new Error("LOCAL_SUSCRIPCION_VENCIDA");
  }

  const localId = localRows[0].id;
  const nombreLocal = localRows[0].nombre

  if (!estilistaId || !servicio_id || isNaN(estilistaId) || isNaN(servicio_id)) {
    return {
      disponibles: [],
      ocupados: [],
      duracion: 0,
      nombreLocal: localRows[0].nombre,
      descripcion: localRows[0].descripcion,
      direccion: localRows[0].direccion,
      telefono: localRows[0].telefono,
      horario_apertura: localRows[0].horario_apertura,
      horario_cierre: localRows[0].horario_cierre,
    };
  }

  // Validar antes de cualquier limpieza de pendientes o cálculo de intervalos.
  const [servicioRows]: any = await pool.query(
    `SELECT s.duracion FROM servicios s
     JOIN locales l ON l.id = s.local_id AND l.business_type = 'BEAUTY'
     WHERE s.id = ? AND s.local_id = ?`,
    [servicio_id, localId]
  );
  if (servicioRows.length === 0 || !duracionBeautyValida(servicioRows[0].duracion)) {
    throw new Error("Servicio no encontrado");
  }
  const duracion = servicioRows[0].duracion;

  const [diaCompleto]: any =
    await pool.query(
      `
    SELECT id
    FROM bloqueos_horarios
    WHERE fecha = ?
    AND local_id = ?
    AND estilista_id = ?
    AND es_dia_completo = true
    LIMIT 1
    `,
      [
        fecha,
        localId,
        estilistaId
      ]
    );

  if (diaCompleto.length > 0) {

    return {
      disponibles: [],
      ocupados: [],
      duracion: 0,
      nombreLocal: localRows[0].nombre,
      descripcion: localRows[0].descripcion,
      direccion: localRows[0].direccion,
      telefono: localRows[0].telefono,
      horario_apertura: localRows[0].horario_apertura,
      horario_cierre: localRows[0].horario_cierre,
      bloqueado: true
    };
  }


  // 📅 2. Día de la semana
  const getDiaSemanaDB = (fecha: string) => {
    const [year, month, day] = fecha.split("-").map(Number);
    const fechaLocal = new Date(year, month - 1, day); // 🔥 LOCAL
    let d = fechaLocal.getDay();
    return d;
  };
  const diaSemana = getDiaSemanaDB(fecha);
  console.log("Dia JS:", new Date(fecha).getDay());
  console.log("Dia DB:", diaSemana);
  // ⏰ 3. Horarios del estilista
  const [horariosDB]: any = await pool.query(
    `SELECT hora_inicio, hora_fin 
     FROM horarios 
     WHERE estilista_id = ? AND dia_semana = ? AND activo = true`,
    [estilistaId, diaSemana]
  );

  if (horariosDB.length === 0) {
    return {
      disponibles: [],
      ocupados: [],
      duracion: 0,
    };
  }

  // 🧹 4. ✅ LIMPIEZA RÁPIDA: Cancelar turnos pendientes de pago con más de 15 minutos
  // Esto libera los horarios "fantasma" antes de calcular la disponibilidad
  await pool.query(
    `UPDATE turnos 
     SET estado = 'cancelado' 
     WHERE local_id = ? 
     AND fecha = ? 
     AND estilista_id = ?
     AND estado = 'pendiente_pago' 
     AND created_at <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
    [localId, fecha, estilistaId]
  );

  // 📆 5. Turnos existentes (✅ CORREGIDO: incluye 'pendiente_pago' para bloquear el horario mientras el cliente paga)
  const [turnos]: any = await pool.query(
    `SELECT hora, hora_fin 
     FROM turnos 
     WHERE fecha = ? AND local_id = ? AND estilista_id = ? AND estado IN ('activo', 'pendiente_pago')`,
    [fecha, localId, estilistaId]
  );

  const [bloqueos]: any = await pool.query(
    `
  SELECT hora_inicio, hora_fin
  FROM bloqueos_horarios
  WHERE fecha = ?
  AND local_id = ?
  AND estilista_id = ?
  `,
    [fecha, localId, estilistaId]
  );

  // 🧱 6. Generar slots desde DB
  let horarios: string[] = [];

  for (const h of horariosDB) {
    // Normalizar a HH:MM
    const hInicio = h.hora_inicio.slice(0, 5);
    const hFin = h.hora_fin.slice(0, 5);
    const slots = generarHorarios(hInicio, hFin);
    horarios = [...horarios, ...slots];
  }

  //🧠 8. Calcular disponibilidad REAL (con solapamiento)
  const disponibles: string[] = [];

  // ✅ NUEVO: Obtener la fecha y hora actual en Argentina (UTC-3)
  // Esto soluciona el problema de que Railway/Vercel usan hora UTC
  const ahoraARG = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  
  const fechaHoyString = `${ahoraARG.getFullYear()}-${String(ahoraARG.getMonth() + 1).padStart(2, '0')}-${String(ahoraARG.getDate()).padStart(2, '0')}`;
  
  const esHoy = fecha === fechaHoyString;
  
  const minutosAhora = ahoraARG.getHours() * 60 + ahoraARG.getMinutes();

  // 🕵️‍♂️ DEBUG: Para verificar que la hora de Argentina es correcta
  console.log("🔍 DEBUG HORA ARGENTINA:", {
    fechaRecibida: fecha,
    fechaHoyString: fechaHoyString,
    esHoy: esHoy,
    horaARG: ahoraARG.toLocaleTimeString("es-AR"),
    minutosAhora: minutosAhora
  });

  for (const horaInicio of horarios) {
    const horaFin = sumarMinutos(horaInicio, duracion);

    // 🔥 Verificar que el turno entre dentro del horario del estilista
    const dentroDelHorario = horariosDB.some(
      (h: any) => {
        const hInicio = h.hora_inicio.slice(0, 5);
        const hFin = h.hora_fin.slice(0, 5);
        return horaInicio >= hInicio && horaFin <= hFin;
      }
    );

    if (!dentroDelHorario) continue;

    // ✅ NUEVO: Si la fecha es HOY, excluir horarios que ya pasaron (en hora Argentina)
    if (esHoy) {
      const [h, m] = horaInicio.split(":").map(Number);
      const minutosSlot = h * 60 + m;
      
      if (minutosSlot <= minutosAhora) {
        continue; // Saltar este horario, ya pasó la hora en Argentina
      }
    }

    let solapado = false;

    for (const turno of turnos) {
      const ocupadoInicio = turno.hora.slice(0, 5);
      const ocupadoFin = turno.hora_fin.slice(0, 5);

      const hayConflicto =
        horaInicio < ocupadoFin && horaFin > ocupadoInicio;

      if (hayConflicto) {
        solapado = true;
        break;
      }
    }

    // 🔒 Verificar bloqueos manuales
    for (const bloqueo of bloqueos) {
      const bloqueoInicio = bloqueo.hora_inicio.slice(0, 5);
      const bloqueoFin = bloqueo.hora_fin.slice(0, 5);

      const hayConflictoBloqueo =
        horaInicio < bloqueoFin && horaFin > bloqueoInicio;

      if (hayConflictoBloqueo) {
        solapado = true;
        break;
      }
    }

    if (!solapado) {
      disponibles.push(horaInicio);
    }
  }

  return {
    disponibles,
    ocupados: turnos.map((t: any) => t.hora.slice(0, 5)),
    duracion,
    nombreLocal: localRows[0].nombre,
    descripcion: localRows[0].descripcion,
    direccion: localRows[0].direccion,
    telefono: localRows[0].telefono,
    horario_apertura: localRows[0].horario_apertura,
    horario_cierre: localRows[0].horario_cierre,
  };
};

export const cancelarTurno = async (id: number, localId: number) => {
  const [result] = await pool.query<ResultSetHeader>(
    "UPDATE turnos SET estado = 'cancelado' WHERE id = ? AND local_id = ? AND estilista_id IS NOT NULL",
    [id, localId]
  );

  if (result.affectedRows === 0) {
    throw new ReprogramarError("TURNO_NO_ENCONTRADO", "Turno no encontrado");
  }
};

export const getTurnosFuturos = async (localId: number) => {
  const hoy = new Date().toISOString().split("T")[0];

  const [rows]: any = await pool.query(
    `SELECT 
            t.*, 
            e.nombre as estilista_nombre,
            s.nombre as servicio_nombre
         FROM turnos t
         JOIN estilistas e ON t.estilista_id = e.id
         JOIN servicios s ON t.servicio_id = s.id
         WHERE t.local_id = ? 
         AND t.fecha >= ? 
         AND t.estado = 'activo'
         ORDER BY t.fecha ASC, t.hora ASC`,
    [localId, hoy]
  );

  return rows;
};

export const completarTurno = async (id: number, localId: number) => {
  const [result] = await pool.query<ResultSetHeader>(
    "UPDATE turnos SET estado = 'completado' WHERE id = ? AND local_id = ? AND estilista_id IS NOT NULL",
    [id, localId]
  );

  if (result.affectedRows === 0) {
    throw new ReprogramarError("TURNO_NO_ENCONTRADO", "Turno no encontrado");
  }
};

export const getDisponibilidadAdmin = async (
  localId: number,
  fecha: string,
  estilistaId: number,
  servicio_id: number
) => {
  const [servicioRows]: any = await pool.query(
    `SELECT s.duracion FROM servicios s
     JOIN locales l ON l.id = s.local_id AND l.business_type = 'BEAUTY'
     WHERE s.id = ? AND s.local_id = ?`,
    [servicio_id, localId]
  );
  if (servicioRows.length === 0 || !duracionBeautyValida(servicioRows[0].duracion)) {
    throw new Error("Servicio no encontrado");
  }
  const duracion = servicioRows[0].duracion;

  // 📅 1. Día de la semana (igual que antes)
  const getDiaSemanaDB = (fecha: string) => {
    const [year, month, day] = fecha.split("-").map(Number);
    const fechaLocal = new Date(year, month - 1, day);
    return fechaLocal.getDay();
  };
  const diaSemana = getDiaSemanaDB(fecha);

  // ⏰ 2. Horarios del estilista
  const [horariosDB]: any = await pool.query(
    `SELECT hora_inicio, hora_fin 
     FROM horarios 
     WHERE estilista_id = ? AND dia_semana = ? AND activo = true`,
    [estilistaId, diaSemana]
  );

  if (horariosDB.length === 0) {
    return { disponibles: [], ocupados: [], duracion: 0 };
  }

  // 📆 3. Turnos existentes
  const [turnos]: any = await pool.query(
    `SELECT hora, hora_fin 
     FROM turnos 
     WHERE fecha = ? AND local_id = ? AND estilista_id = ? AND estado = 'activo'`,
    [fecha, localId, estilistaId]
  );

  const [bloqueos]: any = await pool.query(
    `
  SELECT hora_inicio, hora_fin
  FROM bloqueos_horarios
  WHERE fecha = ?
  AND local_id = ?
  AND estilista_id = ?
  `,
    [fecha, localId, estilistaId]
  );

  // 🧱 5. Generar slots
  let horarios: string[] = [];
  for (const h of horariosDB) {
    // Normalizar a HH:MM
    const hInicio = h.hora_inicio.slice(0, 5);
    const hFin = h.hora_fin.slice(0, 5);
    const slots = generarHorarios(hInicio, hFin);
    horarios = [...horarios, ...slots];
  }

  // 🧠 6. Calcular disponibilidad
  const disponibles: string[] = [];
  for (const horaInicio of horarios) {
    const horaFin = sumarMinutos(horaInicio, duracion);

    // 🔥 Verificar que el turno entre dentro del horario del estilista
    const dentroDelHorario = horariosDB.some((h: any) => {
      const hInicio = h.hora_inicio.slice(0, 5);
      const hFin = h.hora_fin.slice(0, 5);
      return horaInicio >= hInicio && horaFin <= hFin;
    });

    if (!dentroDelHorario) continue;

    let solapado = false;

    for (const turno of turnos) {
      const ocupadoInicio = turno.hora.slice(0, 5);
      const ocupadoFin = turno.hora_fin.slice(0, 5);

      if (horaInicio < ocupadoFin && horaFin > ocupadoInicio) {
        solapado = true;
        break;
      }
    }

    // Control contra bloqueos
    if (!solapado) {
      for (const bloqueo of bloqueos) {
        const bloqueoInicio = bloqueo.hora_inicio.slice(0, 5);
        const bloqueoFin = bloqueo.hora_fin.slice(0, 5);

        if (horaInicio < bloqueoFin && horaFin > bloqueoInicio) {
          solapado = true;
          break;
        }
      }
    }

    if (!solapado) disponibles.push(horaInicio);
  }

  return {
    disponibles,
    ocupados: turnos.map((t: any) => t.hora.slice(0, 5)),
    duracion,
  };
};

export const reprogramarTurno = async (data: any) => {
  const {
    id,
    fecha,
    hora,
    estilista_id,
    servicio_id,
    cliente_nombre,
    cliente_telefono,
    local_id,
  } = data;

  const isPosInt = (v: any) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0;
  };

  const isStr = (v: any) => typeof v === "string" || v instanceof String;

  // Validación mínima
  if (!isPosInt(id)) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  if (!isStr(fecha) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha.trim())) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  if (!isStr(hora)) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  const horaTrim = hora.trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(horaTrim)) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  const horaNormalizada = horaTrim.slice(0, 5);
  const horaParts = horaNormalizada.split(":").map(Number);
  if (horaParts[0] < 0 || horaParts[0] > 23 || horaParts[1] < 0 || horaParts[1] > 59) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  if (!isPosInt(estilista_id)) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  if (!isPosInt(servicio_id)) {
    throw new ReprogramarError("DATOS_INVALIDOS", "Datos inválidos");
  }
  const clienteNombreVal = isStr(cliente_nombre) ? cliente_nombre.trim() : "";
  const clienteTelefonoVal = isStr(cliente_telefono) ? cliente_telefono.trim() : "";
  // Según correcciones: quitar obligatoriedad de nombre/telefono
  // (no lanzar error si están vacíos)

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Lock turno objetivo
    const [turnoLock]: any = await connection.query(
      "SELECT id, estado FROM turnos WHERE id = ? AND local_id = ? FOR UPDATE",
      [id, local_id]
    );
    if (turnoLock.length === 0) {
      throw new ReprogramarError("TURNO_NO_ENCONTRADO", "Turno no encontrado");
    }
    if (turnoLock[0].estado === "pendiente_pago") {
      throw new ReprogramarError("TURNO_PENDIENTE_PAGO", "Este turno está pendiente de pago y no se puede reprogramar");
    }
    if (turnoLock[0].estado !== "activo") {
      throw new ReprogramarError("ESTADO_NO_PERMITIDO", "Solo se pueden reprogramar turnos activos");
    }

    // 2. Validar servicio por local y obtener duración
    const [servicioRows]: any = await connection.query(
      `SELECT s.duracion FROM servicios s
       JOIN locales l ON l.id = s.local_id AND l.business_type = 'BEAUTY'
       WHERE s.id = ? AND s.local_id = ?`,
      [servicio_id, local_id]
    );
    if (servicioRows.length === 0 || !duracionBeautyValida(servicioRows[0].duracion)) {
      throw new ReprogramarError("SERVICIO_NO_ENCONTRADO", "Servicio no encontrado");
    }
    const duracion = servicioRows[0].duracion;

    // 3. Validar estilista por local
    const [estilistaRows]: any = await connection.query(
      "SELECT id FROM estilistas WHERE id = ? AND local_id = ?",
      [estilista_id, local_id]
    );
    if (estilistaRows.length === 0) {
      throw new ReprogramarError("ESTILISTA_NO_ENCONTRADO", "Estilista no encontrado");
    }

    // 4. Calcular hora_fin (guarda de medianoche DESPUÉS de leer duración)
    const hora_fin_calc = sumarMinutos(horaNormalizada, duracion);
    if (hora_fin_calc <= horaNormalizada) {
      throw new ReprogramarError("DATOS_INVALIDOS", "El turno no puede cruzar la medianoche");
    }

    // 5. Chequeo de solapamiento CON FOR UPDATE
    const [rowsSolap]: any = await connection.query(
      `SELECT id FROM turnos
       WHERE estilista_id = ?
       AND fecha = ?
       AND local_id = ?
       AND estado != 'cancelado'
       AND id != ?
       AND (? < hora_fin AND ? > hora)
       FOR UPDATE`,
      [estilista_id, fecha, local_id, id, horaNormalizada, hora_fin_calc]
    );
    if (rowsSolap.length > 0) {
      throw new ReprogramarError("HORARIO_OCUPADO", "Ese horario ya está ocupado");
    }

    // 6. UPDATE
    await connection.query(
      `UPDATE turnos
       SET fecha = ?, hora = ?, hora_fin = ?, estilista_id = ?, servicio_id = ?, cliente_nombre = ?, cliente_telefono = ?
       WHERE id = ? AND local_id = ?`,
      [
        fecha,
        horaNormalizada,
        hora_fin_calc,
        estilista_id,
        servicio_id,
        clienteNombreVal,
        clienteTelefonoVal,
        id,
        local_id,
      ]
    );

    await connection.commit();
    return Number(id);
  } catch (error: any) {
    await connection.rollback();
    if (error instanceof ReprogramarError) {
      throw error;
    }
    if (error.code === "ER_DUP_ENTRY") {
      throw new ReprogramarError("HORARIO_OCUPADO", "Ese horario ya está ocupado");
    }
    throw error;
  } finally {
    connection.release();
  }
};

export const getTurnosByRango = async (desde: string, hasta: string, localId: number) => {
  const [rows]: any = await pool.query(
    `SELECT 
        t.*, 
        e.nombre as estilista_nombre,
        s.nombre as servicio_nombre
     FROM turnos t
     JOIN estilistas e ON t.estilista_id = e.id
     JOIN servicios s ON t.servicio_id = s.id
     WHERE t.local_id = ?
       AND t.fecha BETWEEN ? AND ?
       AND t.estado != 'cancelado'
     ORDER BY t.fecha ASC, t.hora ASC`,
    [localId, desde, hasta]
  );

  return rows;
};
