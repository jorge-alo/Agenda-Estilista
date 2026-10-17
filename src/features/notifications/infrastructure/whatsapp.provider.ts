// src/features/notifications/infrastructure/whatsapp.provider.ts
import { evolutionClient } from "./evolution.client";
import { logEvolutionFailure } from "./evolution.logging";

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
  } catch (error: unknown) {
    logEvolutionFailure("sendText", localId, error);
    throw error;
  }
};
