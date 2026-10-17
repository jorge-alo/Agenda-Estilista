import { pool } from "../../../config/db";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { CrearSolicitud, EstadoSolicitud, SolicitudError } from "./solicitudes.types";

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
