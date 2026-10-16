import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { calcularDuracionTotal, horaAMinutos, minutosAHora } from "../disponibilidad/disponibilidad.engine";
import { obtenerSettingsHighDemand, prepararDisponibilidad, prepararSlotsPorContexto } from "../disponibilidad/disponibilidad.service";
import { TurnoPetError, type ConsultaListadoTurnosPet, type CrearTurnoPetPayload, type ReprogramarTurnoPetPayload, type TurnoPetAdminListado, type TurnoPetCreado, type TurnoPetReprogramado } from "./turnos.types";

interface LocalRow extends RowDataPacket { business_type: string }
interface ClienteRow extends RowDataPacket { nombre: string; telefono: string }
interface MascotaRow extends RowDataPacket { activo: number }
interface TurnoPetSnapshotRow extends RowDataPacket {
  id: number;
  fecha: string;
  hora: string;
  hora_fin: string;
  estado: string;
  mascota_id: number;
  cliente_id: number | null;
  servicio_id: number | null;
  duracion_servicio_snapshot: number | null;
}
interface MascotaHighDemandRow extends RowDataPacket { activo: number; alta_exigencia: number }
interface ExtraSnapshotRow extends RowDataPacket { duracion_minutos: number }
interface TurnoEstadoRow extends RowDataPacket { estado: string }
interface TurnoPetListadoRow extends RowDataPacket {
  id: number;
  fecha: string;
  hora: string;
  hora_fin: string | null;
  estado: string | null;
  mascota_id: number;
  mascota_nombre: string;
  alta_exigencia_snapshot: number | null;
  cliente_id: number | null;
  cliente_nombre: string;
  cliente_telefono: string;
  servicio_id: number | null;
  servicio_nombre_snapshot: string;
  duracion_servicio_snapshot: number;
}
interface TurnoExtraListadoRow extends RowDataPacket {
  turno_id: number;
  extra_id: number | null;
  nombre_snapshot: string;
  duracion_minutos: number;
}

export async function crearTurnoPet(localId: number, data: CrearTurnoPetPayload): Promise<TurnoPetCreado> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Lock even when there are no turns: all PET reservations of this local serialize here.
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT id, business_type FROM locales WHERE id = ? FOR UPDATE", [localId],
    );
    if (!locales.length) throw new TurnoPetError(404, "PET_LOCAL_NOT_FOUND", "Local no encontrado");
    if (locales[0].business_type !== "PET_GROOMING") {
      throw new TurnoPetError(403, "PET_LOCAL_REQUIRED", "Funcionalidad solo para PET_GROOMING");
    }

    const [mascotas] = await connection.query<MascotaRow[]>(
      "SELECT activo FROM mascotas WHERE id = ? AND local_id = ?",
      [data.mascotaId, localId],
    );
    if (!mascotas.length) throw new TurnoPetError(404, "PET_MASCOTA_NOT_FOUND", "Mascota no encontrada");
    if (mascotas[0].activo !== 1) {
      throw new TurnoPetError(409, "PET_MASCOTA_INACTIVA", "La mascota no está activa para nuevas reservas");
    }

    const [clientes] = await connection.query<ClienteRow[]>(
      "SELECT nombre, telefono FROM clientes WHERE id = ? AND local_id = ?",
      [data.clienteId, localId],
    );
    if (!clientes.length) throw new TurnoPetError(404, "PET_CLIENTE_NOT_FOUND", "Responsable no encontrado");
    const [relaciones] = await connection.query<RowDataPacket[]>(
      `SELECT cliente_id FROM mascota_clientes
       WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?`,
      [data.mascotaId, data.clienteId, localId],
    );
    if (!relaciones.length) {
      throw new TurnoPetError(409, "PET_RESPONSABLE_NO_ASOCIADO", "Responsable no asociado a la mascota");
    }
    const context = await prepararDisponibilidad(connection, localId, data, { lockSettings: true });

    const slot = context.slots.find(candidate => candidate.startMinutes === horaAMinutos(data.hora));
    if (!slot) throw new TurnoPetError(409, "PET_SLOT_UNAVAILABLE", "El horario ya no está disponible");
    const horaFin = minutosAHora(slot.endMinutes);

    const [turno] = await connection.query<ResultSetHeader>(
      `INSERT INTO turnos (
        local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_id,
        cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot,
        duracion_servicio_snapshot, alta_exigencia_snapshot, estado, pago_id
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', NULL)`,
      [localId, data.fecha, data.hora, horaFin, data.mascotaId, data.clienteId,
        clientes[0].nombre, clientes[0].telefono, data.servicioId,
        context.servicioNombre, context.duracionServicio, context.altaExigencia],
    );
    for (const extra of context.extras) {
      await connection.query(
        `INSERT INTO turno_extras (turno_id, extra_id, nombre_snapshot, duracion_minutos)
         VALUES (?, ?, ?, ?)`,
        [turno.insertId, extra.id, extra.nombre, extra.duracionMinutos],
      );
    }
    await connection.commit();
    return {
      id: turno.insertId, fecha: data.fecha, hora: data.hora, horaFin, estado: "activo",
      mascotaId: data.mascotaId, clienteId: data.clienteId, servicioId: data.servicioId,
    };
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function reprogramarTurnoPet(
  localId: number,
  turnoId: number,
  data: ReprogramarTurnoPetPayload,
): Promise<TurnoPetReprogramado> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT id, business_type FROM locales WHERE id = ? FOR UPDATE", [localId],
    );
    if (!locales.length) throw new TurnoPetError(404, "PET_LOCAL_NOT_FOUND", "Local no encontrado");
    if (locales[0].business_type !== "PET_GROOMING") {
      throw new TurnoPetError(403, "PET_LOCAL_REQUIRED", "Funcionalidad solo para PET_GROOMING");
    }

    const [turnos] = await connection.query<TurnoPetSnapshotRow[]>(
      `SELECT id, fecha, hora, hora_fin, estado, mascota_id, cliente_id, servicio_id,
              duracion_servicio_snapshot
       FROM turnos
       WHERE id = ? AND local_id = ? AND mascota_id IS NOT NULL
       FOR UPDATE`,
      [turnoId, localId],
    );
    if (!turnos.length) throw new TurnoPetError(404, "PET_TURNO_NOT_FOUND", "Turno no encontrado");
    const turno = turnos[0];
    if (turno.estado !== "activo") {
      throw new TurnoPetError(409, "PET_TURNO_STATE_NOT_REPROGRAMMABLE", "Solo se pueden reprogramar turnos activos");
    }

    if (turno.duracion_servicio_snapshot === null) {
      throw new TurnoPetError(500, "PET_TURNO_SNAPSHOT_INVALID", "El turno no tiene duración de servicio válida");
    }
    const [extras] = await connection.query<ExtraSnapshotRow[]>(
      "SELECT duracion_minutos FROM turno_extras WHERE turno_id = ? ORDER BY id FOR SHARE",
      [turnoId],
    );
    const duracionTotal = calcularDuracionTotal(
      turno.duracion_servicio_snapshot,
      extras.map(extra => extra.duracion_minutos),
    );

    const [mascotas] = await connection.query<MascotaHighDemandRow[]>(
      "SELECT activo, alta_exigencia FROM mascotas WHERE id = ? AND local_id = ? FOR SHARE",
      [turno.mascota_id, localId],
    );
    if (!mascotas.length) throw new TurnoPetError(404, "PET_MASCOTA_NOT_FOUND", "Mascota no encontrada");
    if (mascotas[0].activo !== 1) throw new TurnoPetError(409, "PET_MASCOTA_INACTIVA", "La mascota no está activa");
    if (mascotas[0].alta_exigencia !== 0 && mascotas[0].alta_exigencia !== 1) {
      throw new TurnoPetError(500, "PET_TURNO_SNAPSHOT_INVALID", "La clasificación actual de la mascota es inválida");
    }

    const altaExigencia = mascotas[0].alta_exigencia === 1;
    const settings = altaExigencia ? await obtenerSettingsHighDemand(connection, localId, true) : null;
    const slots = await prepararSlotsPorContexto(connection, localId, {
      fecha: data.fecha,
      duracionMinutos: duracionTotal,
      altaExigencia,
      settings,
      excludeTurnoId: turnoId,
    });
    const slot = slots.find(candidate => candidate.startMinutes === horaAMinutos(data.hora));
    if (!slot) throw new TurnoPetError(409, "PET_SLOT_UNAVAILABLE", "El horario ya no está disponible");
    const horaFin = minutosAHora(slot.endMinutes);

    await connection.query<ResultSetHeader>(
      `UPDATE turnos
       SET fecha = ?, hora = ?, hora_fin = ?, alta_exigencia_snapshot = ?
       WHERE id = ? AND local_id = ? AND mascota_id IS NOT NULL AND estado = 'activo'`,
      [data.fecha, data.hora, horaFin, mascotas[0].alta_exigencia, turnoId, localId],
    );
    await connection.commit();
    return {
      id: turnoId,
      fecha: data.fecha,
      hora: data.hora,
      horaFin,
      estado: "activo",
      mascotaId: turno.mascota_id,
      clienteId: turno.cliente_id,
      servicioId: turno.servicio_id,
    };
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cambiarEstadoTurnoPet(
  localId: number,
  turnoId: number,
  nuevoEstado: "cancelado" | "completado",
): Promise<{ id: number; estado: "cancelado" | "completado" }> {
  const code = nuevoEstado === "cancelado"
    ? "PET_TURNO_STATE_NOT_CANCELLABLE"
    : "PET_TURNO_STATE_NOT_COMPLETABLE";
  const action = nuevoEstado === "cancelado" ? "cancelar" : "completar";
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT id, business_type FROM locales WHERE id = ? FOR UPDATE", [localId],
    );
    if (!locales.length) throw new TurnoPetError(404, "PET_LOCAL_NOT_FOUND", "Local no encontrado");
    if (locales[0].business_type !== "PET_GROOMING") {
      throw new TurnoPetError(403, "PET_LOCAL_REQUIRED", "Funcionalidad solo para PET_GROOMING");
    }

    const [turnos] = await connection.query<TurnoEstadoRow[]>(
      `SELECT estado FROM turnos
       WHERE id = ? AND local_id = ? AND mascota_id IS NOT NULL
       FOR UPDATE`,
      [turnoId, localId],
    );
    if (!turnos.length) throw new TurnoPetError(404, "PET_TURNO_NOT_FOUND", "Turno no encontrado");
    if (turnos[0].estado !== "activo") {
      throw new TurnoPetError(409, code, `Solo se pueden ${action} turnos PET activos`);
    }

    const [result] = await connection.query<ResultSetHeader>(
      `UPDATE turnos
       SET estado = ?
       WHERE id = ? AND local_id = ? AND mascota_id IS NOT NULL AND estado = 'activo'`,
      [nuevoEstado, turnoId, localId],
    );
    if (result.affectedRows !== 1) {
      throw new TurnoPetError(409, code, `Solo se pueden ${action} turnos PET activos`);
    }

    await connection.commit();
    transactionStarted = false;
    return { id: turnoId, estado: nuevoEstado };
  } catch (error: unknown) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function cancelarTurnoPet(localId: number, turnoId: number) {
  return cambiarEstadoTurnoPet(localId, turnoId, "cancelado");
}

export function completarTurnoPet(localId: number, turnoId: number) {
  return cambiarEstadoTurnoPet(localId, turnoId, "completado");
}

export async function listarTurnosPetAdmin(
  localId: number,
  consulta: ConsultaListadoTurnosPet,
): Promise<TurnoPetAdminListado[]> {
  const rangeMode = consulta.fecha === undefined;
  const datePredicate = rangeMode ? "t.fecha BETWEEN ? AND ?" : "t.fecha = ?";
  const dateValues = rangeMode
    ? [consulta.desde, consulta.hasta]
    : [consulta.fecha];
  const [turnos] = await pool.query<TurnoPetListadoRow[]>(
    `SELECT t.id,
            DATE_FORMAT(t.fecha, '%Y-%m-%d') AS fecha,
            TIME_FORMAT(t.hora, '%H:%i') AS hora,
            TIME_FORMAT(t.hora_fin, '%H:%i') AS hora_fin,
            t.estado,
            t.mascota_id,
            m.nombre AS mascota_nombre,
            t.alta_exigencia_snapshot,
            t.cliente_id,
            t.cliente_nombre,
            t.cliente_telefono,
            t.servicio_id,
            t.servicio_nombre_snapshot,
            t.duracion_servicio_snapshot
     FROM turnos t
     INNER JOIN mascotas m
       ON m.id = t.mascota_id AND m.local_id = t.local_id
     WHERE t.local_id = ?
       AND t.mascota_id IS NOT NULL
       AND ${datePredicate}
     ORDER BY ${rangeMode ? "t.fecha ASC, " : ""}t.hora ASC, t.id ASC`,
    [localId, ...dateValues],
  );
  if (!turnos.length) return [];

  const turnoIds = turnos.map(turno => turno.id);
  const placeholders = turnoIds.map(() => "?").join(", ");
  const [extras] = await pool.query<TurnoExtraListadoRow[]>(
    `SELECT te.turno_id, te.extra_id, te.nombre_snapshot, te.duracion_minutos
     FROM turno_extras te
     INNER JOIN turnos t ON t.id = te.turno_id
     WHERE t.local_id = ?
       AND t.mascota_id IS NOT NULL
       AND t.id IN (${placeholders})
     ORDER BY te.turno_id ASC, te.id ASC`,
    [localId, ...turnoIds],
  );
  const extrasPorTurno = new Map<number, TurnoExtraListadoRow[]>();
  for (const extra of extras) {
    const turnoExtras = extrasPorTurno.get(extra.turno_id) ?? [];
    turnoExtras.push(extra);
    extrasPorTurno.set(extra.turno_id, turnoExtras);
  }

  return turnos.map(turno => ({
    id: turno.id,
    fecha: turno.fecha,
    hora: turno.hora,
    horaFin: turno.hora_fin,
    estado: turno.estado,
    mascota: {
      id: turno.mascota_id,
      nombre: turno.mascota_nombre,
      altaExigenciaSnapshot: turno.alta_exigencia_snapshot === null
        ? null
        : turno.alta_exigencia_snapshot === 1,
    },
    responsable: {
      id: turno.cliente_id,
      nombre: turno.cliente_nombre,
      telefono: turno.cliente_telefono,
    },
    servicio: {
      id: turno.servicio_id,
      nombre: turno.servicio_nombre_snapshot,
      duracionMinutos: turno.duracion_servicio_snapshot,
    },
    extras: (extrasPorTurno.get(turno.id) ?? []).map(extra => ({
      id: extra.extra_id,
      nombre: extra.nombre_snapshot,
      duracionMinutos: extra.duracion_minutos,
    })),
  }));
}
