import { TurnoNotificationData } from "../domain/notification.types";

export const buildTurnoConfirmadoMessage = (
  data: TurnoNotificationData
): string => {
  const {
    clienteNombre,
    fecha,
    hora,
    servicio,
    localNombre,
    localTelefono,
  } = data;

  return `
✅ Turno confirmado

Hola ${clienteNombre} 👋

Tu turno en *${localNombre}* fue confirmado:

📅 Fecha: ${fecha}
⏰ Hora: ${hora}
💇 Servicio: ${servicio}`;
};

export const buildTurnoRecordatorioMessage = (
  data: TurnoNotificationData
): string => {
  const { clienteNombre, fecha, hora, servicio, localNombre, localTelefono } =
    data;

  return `🔔 Recordatorio de turno

Hola ${clienteNombre} 👋

Te recordamos que mañana tenés turno en *${localNombre}*:

📅 Fecha: ${fecha}
⏰ Hora: ${hora}
💇 Servicio: ${servicio}

Si no podés asistir, avisanos
`;
};