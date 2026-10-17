import { pool } from "../../../config/db";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { CrearSolicitud, EstadoSolicitud, SolicitudError } from "./solicitudes.types";
import { SolicitudSnapshot, validarConversion } from "./conversion.types";

interface SolicitudRow extends RowDataPacket {
  id: number;
  responsable_nombre: string;
  responsable_telefono: string;
  responsable_telefono_secundario: string | null;
  mascota_nombre: string;
  mascota_raza: string | null;
  mascota_fecha_nacimiento: string | null;
  mascota_tamano: string | null;
  mascota_sexo: string | null;
  motivo_contacto: string | null;
  estado: EstadoSolicitud;
  created_at: Date;
  updated_at: Date;
}

export async function resolverLocal(slug: string): Promise<number> {
  const [locales] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM locales WHERE slug = ? AND activo = 1 AND business_type = 'PET_GROOMING'",
    [slug]
  );
  if (locales.length === 0) throw new SolicitudError(404, "PET_LOCAL_NOT_FOUND");
  return locales[0].id as number;
}

export async function crear(localId: number, data: CrearSolicitud): Promise<void> {
  await pool.query(
    `INSERT INTO solicitudes_pet
     (local_id, responsable_nombre, responsable_telefono, responsable_telefono_secundario,
      mascota_nombre, mascota_raza, mascota_fecha_nacimiento, mascota_tamano, mascota_sexo, motivo_contacto)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [localId, data.responsableNombre, data.responsableTelefono, data.responsableTelefonoSecundario,
      data.mascotaNombre, data.mascotaRaza, data.mascotaFechaNacimiento, data.mascotaTamano, data.mascotaSexo, data.motivoContacto]
  );
}

export async function listar(localId: number, estado: EstadoSolicitud | null) {
  const [rows] = await pool.query<SolicitudRow[]>(
    `SELECT id, responsable_nombre, responsable_telefono, responsable_telefono_secundario,
            mascota_nombre, mascota_raza, DATE_FORMAT(mascota_fecha_nacimiento, '%Y-%m-%d') AS mascota_fecha_nacimiento,
            mascota_tamano, mascota_sexo, motivo_contacto, estado, created_at, updated_at
     FROM solicitudes_pet WHERE local_id = ? ${estado ? "AND estado = ?" : ""}
     ORDER BY created_at DESC, id DESC`,
    estado ? [localId, estado] : [localId]
  );
  return rows.map(row => ({
    id: row.id,
    responsable: { nombre: row.responsable_nombre, telefono: row.responsable_telefono, telefonoSecundario: row.responsable_telefono_secundario },
    mascota: { nombre: row.mascota_nombre, raza: row.mascota_raza, fechaNacimiento: row.mascota_fecha_nacimiento,
      tamano: row.mascota_tamano, sexo: row.mascota_sexo },
    motivoContacto: row.motivo_contacto,
    estado: row.estado,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function cambiarEstado(localId: number, id: number, destino: EstadoSolicitud): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT estado FROM solicitudes_pet WHERE id = ? AND local_id = ?", [id, localId]);
  if (!rows.length) throw new SolicitudError(404, "PET_SOLICITUD_NOT_FOUND");
  const origen = rows[0].estado as EstadoSolicitud;
  if (!((origen === "NUEVA" && (destino === "CONTACTADA" || destino === "DESCARTADA")) ||
    (origen === "CONTACTADA" && destino === "DESCARTADA"))) {
    throw new SolicitudError(409, "PET_SOLICITUD_STATE_TRANSITION_INVALID");
  }
  const [result] = await pool.query<ResultSetHeader>(
    "UPDATE solicitudes_pet SET estado = ? WHERE id = ? AND local_id = ? AND estado = ?",
    [destino, id, localId, origen]
  );
  if (result.affectedRows === 0) throw new SolicitudError(409, "PET_SOLICITUD_STATE_TRANSITION_INVALID");
}

interface SolicitudConversionRow extends RowDataPacket, SolicitudSnapshot {
  estado: EstadoSolicitud;
}

interface ClienteIdRow extends RowDataPacket { id: number }

export async function convertir(localId: number, id: number, body: unknown) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [locales] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM locales WHERE id = ? FOR UPDATE", [localId]
    );
    if (!locales.length) throw new SolicitudError(404, "PET_SOLICITUD_NOT_FOUND");

    // Primera lectura de la solicitud bajo lock; no crear un snapshot anterior al lock local.
    const [solicitudes] = await connection.query<SolicitudConversionRow[]>(
      `SELECT responsable_nombre, responsable_telefono, mascota_nombre, mascota_raza,
              DATE_FORMAT(mascota_fecha_nacimiento, '%Y-%m-%d') AS mascota_fecha_nacimiento,
              mascota_tamano, mascota_sexo, estado
       FROM solicitudes_pet WHERE id = ? AND local_id = ? FOR UPDATE`,
      [id, localId]
    );
    if (!solicitudes.length) throw new SolicitudError(404, "PET_SOLICITUD_NOT_FOUND");
    const solicitud = solicitudes[0];
    if (solicitud.estado !== "NUEVA" && solicitud.estado !== "CONTACTADA") {
      throw new SolicitudError(409, "PET_SOLICITUD_NOT_CONVERTIBLE");
    }
    const ficha = validarConversion(body, solicitud);

    const [clientes] = await connection.query<ClienteIdRow[]>(
      "SELECT id FROM clientes WHERE telefono = ? AND local_id = ?",
      [ficha.responsable.telefono, localId]
    );
    let clienteId: number;
    let reutilizado = clientes.length > 0;
    if (reutilizado) {
      clienteId = clientes[0].id;
    } else {
      try {
        const [insert] = await connection.query<ResultSetHeader>(
          "INSERT INTO clientes (nombre, telefono, local_id) VALUES (?, ?, ?)",
          [ficha.responsable.nombre, ficha.responsable.telefono, localId]
        );
        clienteId = insert.insertId;
      } catch (error: unknown) {
        const duplicate = error as { code?: string; sqlMessage?: string };
        if (duplicate.code !== "ER_DUP_ENTRY" || !duplicate.sqlMessage?.includes("unique_cliente_local")) throw error;
        // Un escritor legacy pudo insertar el mismo teléfono fuera del lock de locales.
        const [ganador] = await connection.query<ClienteIdRow[]>(
          "SELECT id FROM clientes WHERE telefono = ? AND local_id = ? FOR UPDATE",
          [ficha.responsable.telefono, localId]
        );
        if (!ganador.length) throw new Error("Cliente no encontrado tras colisión UNIQUE");
        clienteId = ganador[0].id;
        reutilizado = true;
      }
    }

    const [mascota] = await connection.query<ResultSetHeader>(
      `INSERT INTO mascotas
       (local_id, nombre, raza, fecha_nacimiento, sexo, tamano, tipo_pelo, observaciones,
        alta_exigencia, reserva_online_habilitada, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)`,
      [localId, ficha.mascota.nombre, ficha.mascota.raza, ficha.mascota.fechaNacimiento,
        ficha.mascota.sexo, ficha.mascota.tamano, ficha.mascota.tipoPelo, ficha.mascota.observaciones]
    );
    await connection.query(
      "INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
      [localId, mascota.insertId, clienteId]
    );
    const [updated] = await connection.query<ResultSetHeader>(
      `UPDATE solicitudes_pet
       SET estado = 'CONVERTIDA', cliente_id = ?, mascota_id = ?, converted_at = NOW(), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND local_id = ? AND estado IN ('NUEVA', 'CONTACTADA')`,
      [clienteId, mascota.insertId, id, localId]
    );
    if (updated.affectedRows !== 1) throw new SolicitudError(409, "PET_SOLICITUD_NOT_CONVERTIBLE");
    await connection.commit();
    return { solicitudId: id, estado: "CONVERTIDA" as const, cliente: { id: clienteId, reutilizado }, mascota: { id: mascota.insertId } };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
