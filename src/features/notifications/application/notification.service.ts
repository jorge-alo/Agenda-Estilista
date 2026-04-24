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