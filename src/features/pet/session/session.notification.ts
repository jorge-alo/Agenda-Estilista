import { sendWhatsApp } from "../../notifications/infrastructure/whatsapp.provider";
import { buildPetMagicLink, evolutionNumberFromE164 } from "./session.link";

export interface PetAccessDelivery {
  localId: number;
  canonical: string;
  slug: string;
  secret: string;
  frontendBase: string;
}

async function deliverAccessLink(delivery: PetAccessDelivery): Promise<void> {
  // Called only after COMMIT. The secret/link/message remain ephemeral in memory.
  const link = buildPetMagicLink(delivery.frontendBase, delivery.slug, delivery.secret);
  const message = [
    "Acceso a tu agenda de mascotas",
    "",
    link,
    "",
    "Este enlace vence en 15 minutos y se puede usar una sola vez.",
    "Si no lo solicitaste, podés ignorar este mensaje.",
  ].join("\n");
  await sendWhatsApp(evolutionNumberFromE164(delivery.canonical), message, String(delivery.localId));
}

export function startPetAccessDelivery(delivery: PetAccessDelivery): void {
  // The provider already logs allowlisted transport metadata (SEG-012). Do not log
  // the original rejection again, and never leave an unhandled sender promise.
  void deliverAccessLink(delivery).catch(() => {});
}
