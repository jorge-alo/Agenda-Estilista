// src/features/notifications/infrastructure/whatsapp.provider.ts
import { evolutionClient } from "./evolution.client";

export const sendWhatsApp = async (
  to: string,
  body: string,
  localId: string
): Promise<void> => {
  try {
    await evolutionClient.post(`/message/sendText/${localId}`, {
      number: to,
      textMessage: {
        text: body,
      },
    });
    console.log(`✅ WhatsApp enviado a ${to} desde instancia ${localId}`);
  } catch (error: any) {
    console.error(
      `❌ Error enviando WhatsApp a ${to}:`,
      error.response?.data || error.message
    );
    throw error;
  }
};