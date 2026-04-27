// src/features/notifications/application/sendWhatsAppNotification.ts
import { sendWhatsApp } from "../infrastructure/whatsapp.provider";
import {
  buildTurnoConfirmadoMessage,
  buildTurnoRecordatorioMessage,
} from "./notification.service";
import { TurnoNotificationData } from "../domain/notification.types";

export const sendTurnoConfirmado = async (
  data: TurnoNotificationData
): Promise<void> => {
  const message = buildTurnoConfirmadoMessage(data);
  await sendWhatsApp(data.clienteTelefono, message, data.localId);
};

export const sendTurnoRecordatorio = async (
  data: TurnoNotificationData
): Promise<void> => {
  const message = buildTurnoRecordatorioMessage(data);
  await sendWhatsApp(data.clienteTelefono, message, data.localId);
};