import { pool } from "../../config/db";

export const obtenerClientesService = async (localId: number) => {
  const [rows]: any = await pool.query(
    `
    SELECT
      c.id,
      c.nombre,
      c.telefono,
      COUNT(t.id) AS total_turnos,
      MAX(t.fecha) AS ultima_visita,
      
      /* ✅ SUBCONSULTA: Obtiene el nombre del servicio del turno más reciente (no cancelado) */
      (
        SELECT s.nombre
        FROM turnos t2
        INNER JOIN servicios s ON t2.servicio_id = s.id
        WHERE t2.cliente_id = c.id 
          AND t2.estado != 'cancelado' 
        ORDER BY t2.fecha DESC, t2.id DESC
        LIMIT 1
      ) AS ultimo_servicio

    FROM clientes c
    /* Solo contamos turnos que no estén cancelados para el total y la fecha */
    LEFT JOIN turnos t ON t.cliente_id = c.id AND t.estado != 'cancelado'
    
    WHERE c.local_id = ?
    GROUP BY c.id, c.nombre, c.telefono
    ORDER BY ultima_visita DESC
    `,
    [localId]
  );

  return rows;
};