import { pool } from "../../config/db";

interface CrearBloqueoDTO {
  local_id: number;
  estilista_id: number;

  fecha: string;

  hora_inicio: string;
  hora_fin: string;

  motivo?: string;
}

export const crearBloqueoService =
  async (
    data: CrearBloqueoDTO
  ) => {

    await pool.query(
      `
      INSERT INTO bloqueos_horarios (
        local_id,
        estilista_id,
        fecha,
        hora_inicio,
        hora_fin,
        motivo
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        data.local_id,
        data.estilista_id,
        data.fecha,
        data.hora_inicio,
        data.hora_fin,
        data.motivo || null
      ]
    );
  };

export const obtenerBloqueosService =
  async (
    localId: number,
    fecha: string
  ) => {

    const [rows] = await pool.query(
      `
      SELECT *
      FROM bloqueos_horarios
      WHERE local_id = ?
      AND fecha = ?
      `,
      [localId, fecha]
    );

    return rows;
  };