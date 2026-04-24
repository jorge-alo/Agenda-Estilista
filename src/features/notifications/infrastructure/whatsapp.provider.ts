import { twilioClient } from "./twilio.client";

const FROM = process.env.TWILIO_WHATSAPP_NUMBER!;

export const sendWhatsApp = async (to: string, body: string) => {
  try {
    await twilioClient.messages.create({
      from: FROM,
      to: `whatsapp:${to}`,
      body,
    });
  } catch (error) {
    console.error("Error enviando WhatsApp:", error);
    throw error;
  }
};