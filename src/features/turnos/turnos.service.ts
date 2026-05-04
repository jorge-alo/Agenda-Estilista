import { pool } from "../../config/db";
import { generarHorarios } from "../../helpers/generarHorarios";
import { sumarMinutos } from "../../helpers/sumarMinutos"


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


  // 🔍 1. Obtener duración del servicio
  const [servicioRows]: any = await pool.query(
    `
    SELECT duracion
    FROM servicios
    WHERE id = ?
    `,
    [servicio_id]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado");
  }

  const duracion = servicioRows[0].duracion;

  // 🧠 2. Calcular hora_fin
  const hora_fin = sumarMinutos(hora, duracion);

  // 🚫 3. Validar solapamiento
  const [rows]: any = await pool.query(
    `
    SELECT id
    FROM turnos
    WHERE estilista_id = ?
    AND fecha = ?
    AND estado != 'cancelado'
    AND (
      (? < hora_fin)
      AND
      (? > hora)
    )
    `,
    [
      estilista_id,
      fecha,
      hora,
      hora_fin
    ]
  );

  if (rows.length > 0) {
    throw new Error("Ese horario ya está ocupado");
  }

  // 👤 4. Buscar cliente existente
  const [clientes]: any = await pool.query(
    `
    SELECT id
    FROM clientes
    WHERE telefono = ?
    AND local_id = ?
    `,
    [
      cliente_telefono,
      local_id
    ]
  );


  let clienteId;

  // 👤 5. Crear cliente si no existe
  if (clientes.length > 0) {

    clienteId = clientes[0].id;

  } else {

    const [clienteResult]: any = await pool.query(
      `
      INSERT INTO clientes (
        nombre,
        telefono,
        local_id
      )
      VALUES (?, ?, ?)
      `,
      [
        cliente_nombre,
        cliente_telefono,
        local_id
      ]
    );

    clienteId = clienteResult.insertId;
  }


  // 💾 6. Insertar turno
  const [result]: any = await pool.query(
    `
    INSERT INTO turnos (
      fecha,
      hora,
      hora_fin,
      estilista_id,
      servicio_id,
      local_id,
      cliente_nombre,
      cliente_telefono,
      cliente_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      fecha,
      hora,
      hora_fin,
      estilista_id,
      servicio_id,
      local_id,
      cliente_nombre,
      cliente_telefono,
      clienteId
    ]
  );

  return result.insertId;
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
    "SELECT id, nombre, descripcion, direccion, telefono, horario_apertura, horario_cierre FROM locales WHERE slug = ?",
    [slug]
  );

  if (localRows.length === 0) {
    throw new Error("Local no encontrado");
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

  // 📆 4. Turnos existentes (IMPORTANTE: traer hora_fin)
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

  // 💇 5. Duración del servicio
  const [servicioRows]: any = await pool.query(
    "SELECT duracion FROM servicios WHERE id = ?",
    [servicio_id]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado");
  }

  const duracion = servicioRows[0].duracion;

  // 🧱 6. Generar slots desde DB
  let horarios: string[] = [];

  for (const h of horariosDB) {
    const slots = generarHorarios(h.hora_inicio, h.hora_fin);
    horarios = [...horarios, ...slots];
  }

  // 🧠 7. Calcular disponibilidad REAL (con solapamiento)
  const disponibles: string[] = [];

  for (const horaInicio of horarios) {
    const horaFin = sumarMinutos(horaInicio, duracion);

    // 🔥 NUEVO: verificar que el turno entre dentro del horario del estilista
    const dentroDelHorario = horariosDB.some(
      (h: any) => horaInicio >= h.hora_inicio && horaFin <= h.hora_fin
    );

    if (!dentroDelHorario) continue; // ← descartamos este slot

    let solapado = false;

    for (const turno of turnos) {
      const ocupadoInicio = turno.hora;
      const ocupadoFin = turno.hora_fin;

      const hayConflicto =
        horaInicio < ocupadoFin && horaFin > ocupadoInicio;

      if (hayConflicto) {
        solapado = true;
        break;
      }
    }

    // 🔒 Verificar bloqueos manuales
    for (const bloqueo of bloqueos) {

      const bloqueoInicio = bloqueo.hora_inicio;
      const bloqueoFin = bloqueo.hora_fin;

      const hayConflictoBloqueo =
        horaInicio < bloqueoFin &&
        horaFin > bloqueoInicio;

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
    ocupados: turnos.map((t: any) => t.hora),
    duracion,
    nombreLocal: localRows[0].nombre,
    descripcion: localRows[0].descripcion,
    direccion: localRows[0].direccion,
    telefono: localRows[0].telefono,
    horario_apertura: localRows[0].horario_apertura,
    horario_cierre: localRows[0].horario_cierre,
  };
};

export const cancelarTurno = async (id: number) => {
  await pool.query(
    "UPDATE turnos SET estado = 'cancelado' WHERE id = ?",
    [id]
  );
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

export const completarTurno = async (id: number) => {
  await pool.query(
    "UPDATE turnos SET estado = 'completado' WHERE id = ?",
    [id]
  );
};

export const getDisponibilidadAdmin = async (
  localId: number,
  fecha: string,
  estilistaId: number,
  servicio_id: number
) => {
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

  // 💇 4. Duración del servicio
  const [servicioRows]: any = await pool.query(
    "SELECT duracion FROM servicios WHERE id = ?",
    [servicio_id]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado");
  }

  const duracion = servicioRows[0].duracion;

  // 🧱 5. Generar slots
  let horarios: string[] = [];
  for (const h of horariosDB) {
    const slots = generarHorarios(h.hora_inicio, h.hora_fin);
    horarios = [...horarios, ...slots];
  }

  // 🧠 6. Calcular disponibilidad
  const disponibles: string[] = [];
  for (const horaInicio of horarios) {
    const horaFin = sumarMinutos(horaInicio, duracion);

    // 🔥 Verificar que el turno entre dentro del horario del estilista
    const dentroDelHorario = horariosDB.some(
      (h: any) => horaInicio >= h.hora_inicio && horaFin <= h.hora_fin
    );

    if (!dentroDelHorario) continue;

    let solapado = false;

    for (const turno of turnos) {
      if (horaInicio < turno.hora_fin && horaFin > turno.hora) {
        solapado = true;
        break;
      }
    }

    // 🔒 Verificar bloqueos manuales
    for (const bloqueo of bloqueos) {

      const bloqueoInicio =
        bloqueo.hora_inicio;

      const bloqueoFin =
        bloqueo.hora_fin;

      const hayConflictoBloqueo =
        horaInicio < bloqueoFin &&
        horaFin > bloqueoInicio;

      if (hayConflictoBloqueo) {

        solapado = true;

        break;
      }
    }

    if (!solapado) disponibles.push(horaInicio);
  }

  return {
    disponibles,
    ocupados: turnos.map((t: any) => t.hora),
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
  } = data;
  console.log("ID del turno:", id, "tipo:", typeof id)
  // 🔍 1. Obtener duración del servicio
  const [servicioRows]: any = await pool.query(
    "SELECT duracion FROM servicios WHERE id = ?",
    [servicio_id]
  );

  if (servicioRows.length === 0) {
    throw new Error("Servicio no encontrado");
  }

  const duracion = servicioRows[0].duracion;

  // 🧠 2. Calcular hora_fin
  const hora_fin = sumarMinutos(hora, duracion);

  // 🚫 3. Validar solapamiento REAL (nivel pro)
  const [rows]: any = await pool.query(
    `SELECT id FROM turnos 
     WHERE estilista_id = ?
     AND fecha = ?
     AND estado != 'cancelado'
     AND id != ?
     AND (
       (? < hora_fin) AND (? > hora)
     )`,
    [estilista_id, fecha, id, hora, hora_fin]
  );

  if (rows.length > 0) {
    throw new Error("Ese horario ya está ocupado");
  }

  // ✅ así debería estar, actualiza el turno existente
  const [result]: any = await pool.query(
    `UPDATE turnos 
     SET fecha = ?, hora = ?, hora_fin = ?, estilista_id = ?, servicio_id = ?, cliente_nombre = ?, cliente_telefono = ?
     WHERE id = ?`,
    [fecha, hora, hora_fin, estilista_id, servicio_id, cliente_nombre, cliente_telefono, id]
  );

  return result.insertId;
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