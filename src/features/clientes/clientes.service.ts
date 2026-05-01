import { pool } from "../../config/db";

export const obtenerClientesService =
  async (localId: number) => {

    const [rows] = await pool.query(
      `
      SELECT
        c.id,
        c.nombre,
        c.telefono,
        COUNT(t.id) AS total_turnos,
        MAX(t.fecha) AS ultima_visita
      FROM clientes c

      LEFT JOIN turnos t
        ON t.cliente_id = c.id

      WHERE c.local_id = ?

      GROUP BY c.id

      ORDER BY ultima_visita DESC
      `,
      [localId]
    );

    return rows;
  };