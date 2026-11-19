import { validatePetFrontendUrl } from "../session/session.link";

export function buildPetRecurrenceReminder(input: { mascotaNombre: string; slug: string; frontendUrl: string }): string {
  const base = validatePetFrontendUrl(input.frontendUrl, "production");
  if (!input.slug.trim() || !input.mascotaNombre.trim()) throw new Error("PET_RECURRENCE_MESSAGE_INVALID");
  const link = `${base}/${encodeURIComponent(input.slug)}`;
  return [
    `¡Buen día! ☀️🐾 Te escribimos porque ya pasó cerca de un mes desde la última visita de ${input.mascotaNombre}. En esta etapa suele ser ideal realizar el mantenimiento para conservar el manto sano, cómodo y evitar nudos o servicios más largos e incómodos para ellos.`,
    `Podés reservar su próximo turno directamente desde nuestra agenda online 📅👇\n${link}`,
    "Si necesitás ingresar, elegí “Ya soy cliente” y usá tu celular habitual.",
    "Si preferís no recibir estos recordatorios, avisame por acá.",
  ].join("\n\n");
}

/** Same acceptance contract as Evolution's PET receipt, without importing the HTTP adapter. */
export function reciboRecurrenciaSimulado(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("status" in response)
    || typeof response.status !== "number" || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
    || !("data" in response) || !response.data || typeof response.data !== "object"
    || !("key" in response.data) || !response.data.key || typeof response.data.key !== "object"
    || !("id" in response.data.key)) return null;
  const id = response.data.key.id;
  return typeof id === "string" && id.trim().length > 0 && id.length <= 255 ? id : null;
}
