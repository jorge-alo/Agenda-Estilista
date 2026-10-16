import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { horaAMinutos, minutosAHora } from "../disponibilidad/disponibilidad.engine";
import { prepararDisponibilidad } from "../disponibilidad/disponibilidad.service";
import { TurnoPetError, type CrearTurnoPetPayload, type TurnoPetCreado } from "./turnos.types";

interface LocalRow extends RowDataPacket { business_type: string }
interface ClienteRow extends RowDataPacket { nombre: string; telefono: string }
interface MascotaRow extends RowDataPacket { activo: number }

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
