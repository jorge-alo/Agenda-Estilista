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
    fecha?: string
  ) => {

    let query = `
      SELECT
        b.id,
        b.fecha,
        b.hora_inicio,
        b.hora_fin,
        b.motivo,
        e.nombre AS estilista_nombre

      FROM bloqueos_horarios b

      JOIN estilistas e
        ON e.id = b.estilista_id

      WHERE b.local_id = ?
    `;

    const params: any[] = [localId];

    // 🔍 filtro opcional por fecha
    if (fecha) {
      query += ` AND b.fecha = ?`;
      params.push(fecha);
    }

    query += `
      ORDER BY
        b.fecha ASC,
        b.hora_inicio ASC
    `;

    const [rows] =
      await pool.query(query, params);

    return rows;
  };

 export const eliminarBloqueo = async (id: number, localId: number) => {
  const [result]: any = await pool.query(
    `DELETE FROM bloqueos_horarios WHERE id = ? AND local_id = ?`,
    [id, localId]
  );

  if (result.affectedRows === 0) {
    throw new Error("Bloqueo no encontrado o no pertenece a tu local");
  }
};