// src/features/notifications/infrastructure/whatsapp.provider.ts
import { evolutionClient } from "./evolution.client";
import { logEvolutionFailure } from "./evolution.logging";

/** PET-only preflight. An unreadable state is never proof of an accepted send. */
export async function getPetWhatsAppConnectionState(localId: string): Promise<"open" | "closed" | "unavailable"> {
  try {
    const { data } = await evolutionClient.get(`/instance/connectionState/${localId}`);
    const state = data?.instance?.state;
    if (state === "open") return "open";
    if (state === "close" || state === "closed") return "closed";
    return "unavailable";
  } catch (error: unknown) {
    logEvolutionFailure("connectionState", localId, error);
    return "unavailable";
  }
}

/** Only a well-formed Evolution message key is treated as unambiguous acceptance. */
export async function sendPetWhatsAppWithReceipt(
  to: string, body: string, localId: string,
): Promise<string | null> {
  try {
    const response = await evolutionClient.post(`/message/sendText/${localId}`, {
      number: to, textMessage: { text: body },
    });
    const id: unknown = response.data?.key?.id;
    return response.status >= 200 && response.status < 300
      && typeof id === "string" && id.length > 0 && id.length <= 255
      ? id : null;
  } catch (error: unknown) {
    logEvolutionFailure("sendText", localId, error);
    throw error;
  }
}

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
