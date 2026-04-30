import { pool } from "../../config/db";
import { RowDataPacket } from "mysql2";

export interface TurnoResumen
    extends RowDataPacket {

    id: number;

    hora: string;
    hora_fin: string;

    estado:
    | 'activo'
    | 'completado'
    | 'cancelado';

    precio: number;

    clienteNombre: string;

    servicio: string;

    estilista: string;
}

export const getResumenDiaService = async (
    fecha: string,
    localId: number
) => {

    const [turnos] = await pool.query<TurnoResumen[]>(
        `
  SELECT
    t.id,
    t.hora,
    t.hora_fin,
    t.estado,

    t.cliente_nombre AS clienteNombre,

    s.nombre AS servicio,
    s.precio AS precio,

    e.nombre AS estilista

  FROM turnos t

  JOIN servicios s
    ON s.id = t.servicio_id

  JOIN estilistas e
    ON e.id = t.estilista_id

  WHERE t.fecha = ?
  AND t.local_id = ?

  ORDER BY t.hora ASC
  `,
        [fecha, localId]
    );

    // MÉTRICAS

    const totalTurnos = turnos.length;

    const completados = turnos.filter(
        t => t.estado === 'completado'
    ).length;

    const cancelados = turnos.filter(
        t => t.estado === 'cancelado'
    ).length;

    const pendientes = turnos.filter(
        t => t.estado === 'activo'
    ).length;

    const ingresosEstimados = turnos
        .filter(t => t.estado !== 'cancelado')
        .reduce(
            (acc, turno) =>
                acc + Number(turno.precio),
            0
        );

    // POR ESTILISTA

    const estilistasMap = new Map();

    for (const turno of turnos) {

        const nombre = turno.estilista;

        if (!estilistasMap.has(nombre)) {

            estilistasMap.set(nombre, {
                nombre,

                iniciales: nombre
                    .split(' ')
                    .map(p => p[0])
                    .join(''),

                cantidad: 0
            });
        }

        estilistasMap.get(nombre).cantidad++;
    }

    const porEstilista = Array.from(
        estilistasMap.values()
    );

    // TEMPORAL
    // después hacemos cálculo real

    const ocupacionPorcentaje =
        totalTurnos === 0
            ? 0
            : Math.min(
                Math.round((totalTurnos / 20) * 100),
                100
            );

    const horasMap = new Map();

    for (const turno of turnos) {

        const hora = turno.hora.slice(0, 5);

        if (!horasMap.has(hora)) {

            horasMap.set(hora, {
                hora,
                reservados: 0,
                disponibles: 0
            });
        }

        horasMap.get(hora).reservados++;
    }

    const turnosPorHora = Array.from(
        horasMap.values()
    ).sort((a, b) =>
        a.hora.localeCompare(b.hora)
    );

    return {
        fecha,
        totalTurnos,
        completados,
        cancelados,
        pendientes,
        ingresosEstimados,
        ocupacionPorcentaje,
        turnosPorHora,
        huecos: [],
        porEstilista,
        turnos
    };
};

export interface ClienteHistorial
  extends RowDataPacket {

  cliente_nombre: string;

  cliente_telefono: string;

  visitas: number;

  ultima_visita: string;

  ultimo_servicio: string;
}

export const getHistorialClientesService =
  async (
    localId: number
  ) => {

    const [clientes] =
      await pool.query<ClienteHistorial[]>(
        `
        SELECT

          t.cliente_nombre,

          t.cliente_telefono,

          COUNT(*) AS visitas,

          MAX(t.fecha) AS ultima_visita,

          (
            SELECT s.nombre
            FROM turnos t2

            JOIN servicios s
              ON s.id = t2.servicio_id

            WHERE
              t2.cliente_telefono =
                t.cliente_telefono

            ORDER BY t2.fecha DESC

            LIMIT 1
          ) AS ultimo_servicio

        FROM turnos t

        WHERE t.local_id = ?

        GROUP BY
          t.cliente_telefono,
          t.cliente_nombre

        ORDER BY visitas DESC
        LIMIT 5
        `,
        [localId]
      );

    return clientes;
  };

  export interface ReporteMensual
  extends RowDataPacket {

  ingresos: number;

  turnos: number;

  cancelaciones: number;

  servicioTop: string;

  estilistaTop: string;
}

export const getReporteMensualService =
  async (
    localId: number
  ) => {

    const [rows] =
      await pool.query<any[]>(
        `
        SELECT

          COUNT(*) AS turnos,

          SUM(
            CASE
              WHEN t.estado != 'cancelado'
              THEN s.precio
              ELSE 0
            END
          ) AS ingresos,

          SUM(
            CASE
              WHEN t.estado = 'cancelado'
              THEN 1
              ELSE 0
            END
          ) AS cancelaciones

        FROM turnos t

        JOIN servicios s
          ON s.id = t.servicio_id

        WHERE
          t.local_id = ?
          AND MONTH(t.fecha) = MONTH(CURDATE())
          AND YEAR(t.fecha) = YEAR(CURDATE())
        `,
        [localId]
      );

    const [servicioTopRows] =
      await pool.query<any[]>(
        `
        SELECT
          s.nombre,
          COUNT(*) AS cantidad

        FROM turnos t

        JOIN servicios s
          ON s.id = t.servicio_id

        WHERE
          t.local_id = ?
          AND MONTH(t.fecha) = MONTH(CURDATE())
          AND YEAR(t.fecha) = YEAR(CURDATE())

        GROUP BY s.id

        ORDER BY cantidad DESC

        LIMIT 1
        `,
        [localId]
      );

    const [estilistaTopRows] =
      await pool.query<any[]>(
        `
        SELECT
          e.nombre,
          COUNT(*) AS cantidad

        FROM turnos t

        JOIN estilistas e
          ON e.id = t.estilista_id

        WHERE
          t.local_id = ?
          AND MONTH(t.fecha) = MONTH(CURDATE())
          AND YEAR(t.fecha) = YEAR(CURDATE())

        GROUP BY e.id

        ORDER BY cantidad DESC

        LIMIT 1
        `,
        [localId]
      );

    const resumen = rows[0];

    return {

      ingresos:
        Number(resumen.ingresos || 0),

      turnos:
        Number(resumen.turnos || 0),

      cancelaciones:
        Number(resumen.cancelaciones || 0),

      servicioTop:
        servicioTopRows[0]?.nombre || '-',

      estilistaTop:
        estilistaTopRows[0]?.nombre || '-'
    };
  };
