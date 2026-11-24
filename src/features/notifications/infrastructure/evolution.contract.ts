/** Explicit opt-in: production keeps the 1.8.2 contract until configured for v2. */
function evolutionVersion(): "v1" | "v2" {
  const version = process.env.EVOLUTION_API_VERSION;
  if (version === undefined || version === "v1") return "v1";
  if (version === "v2") return "v2";
  throw new Error("EVOLUTION_API_VERSION_INVALID");
}

export function buildEvolutionTextPayload(number: string, text: string) {
  return evolutionVersion() === "v2"
    ? { number, text }
    : { number, textMessage: { text } };
}

export function buildEvolutionInstancePayload(instanceName: string) {
  return evolutionVersion() === "v2"
    ? { instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }
    : { instanceName, qrcode: true };
}
