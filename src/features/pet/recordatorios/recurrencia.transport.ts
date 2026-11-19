import { getPetWhatsAppConnectionState, sendPetWhatsAppWithReceipt } from "../../notifications/infrastructure/whatsapp.provider";
import type { EvolutionRecurrenciaPet } from "./recurrencia.processing";

/** Direct reuse: no HTTP calls at construction/import, no second parsing or send implementation. */
export function createPetRecurrenceTransport(): EvolutionRecurrenciaPet {
  return { kind:"pet_receipt", connection:getPetWhatsAppConnectionState, send:sendPetWhatsAppWithReceipt };
}
