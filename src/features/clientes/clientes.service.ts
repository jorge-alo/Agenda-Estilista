import { pool } from "../../config/db";

export const obtenerClientesService = async (localId: number) => {
  const [rows]: any = await pool.query(
    `
    SELECT
      c.id,
      c.nombre,
      c.telefono,
      
      /* ✅ Contamos turnos PASADOS (fecha <= hoy) que no estén cancelados */
      COUNT(CASE WHEN t.fecha <= CURDATE() AND t.estado != 'cancelado' THEN 1 END) AS total_turnos,
      
      /* ✅ Última visita: la fecha más reciente de un turno ya ocurrido */
      MAX(CASE WHEN t.fecha <= CURDATE() AND t.estado != 'cancelado' THEN t.fecha END) AS ultima_visita,
      
      /* ✅ Último servicio del turno más reciente ya ocurrido */
      (
        SELECT s.nombre
        FROM turnos t2
        INNER JOIN servicios s ON t2.servicio_id = s.id
        WHERE t2.cliente_id = c.id 
          AND t2.fecha <= CURDATE()
          AND t2.estado != 'cancelado' 
        ORDER BY t2.fecha DESC, t2.id DESC
        LIMIT 1
      ) AS ultimo_servicio

    FROM clientes c
    LEFT JOIN turnos t ON t.cliente_id = c.id
    
    WHERE c.local_id = ?
    GROUP BY c.id, c.nombre, c.telefono
    ORDER BY ultima_visita DESC
    `,
    [localId]
  );

  return rows;
};