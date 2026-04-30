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

  return {

    fecha,

    totalTurnos,

    completados,

    cancelados,

    pendientes,

    ingresosEstimados,

    ocupacionPorcentaje,

    turnosPorHora: [],

    huecos: [],

    porEstilista,

    turnos
  };
};