import { twilioClient } from "./twilio.client";

const FROM = process.env.TWILIO_WHATSAPP_NUMBER!;

export const sendWhatsApp = async (to: string, body: string) => {
    try {
        console.log("ACCOUNT SID:", process.env.TWILIO_ACCOUNT_SID);
        console.log("FROM:", process.env.TWILIO_WHATSAPP_NUMBER);
        console.log("TO:", to);
        const message = await twilioClient.messages.create({
            from: FROM,
            to: `whatsapp:${to}`,
            body,
        });
        console.log("SID:", message.sid);
        console.log("STATUS:", message.status);
    } catch (error) {
        console.error("Error enviando WhatsApp:", error);
        throw error;
    }
};