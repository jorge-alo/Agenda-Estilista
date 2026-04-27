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
💇 Servicio: ${servicio}

📲 Contactar al local:
https://wa.me/${localTelefono}

(Este es un mensaje automático, no responder aquí)
`;
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

Si no podés asistir, avisanos:
https://wa.me/${localTelefono}

_(Mensaje automático, no respondas aquí)_`;
};