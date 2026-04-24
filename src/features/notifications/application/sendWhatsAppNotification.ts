import { sendWhatsApp } from "../infrastructure/whatsapp.provider";
import { buildTurnoConfirmadoMessage } from "./notification.service";
import { TurnoNotificationData } from "../domain/notification.types";

export const sendTurnoConfirmado = async (
  data: TurnoNotificationData
) => {
  const message = buildTurnoConfirmadoMessage(data);

  await sendWhatsApp(data.clienteTelefono, message);
};