import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { isCanonicalOpaqueSecret } from "./opaqueSecret";

export function validatePetFrontendUrl(value: string | undefined, environment: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    const development = ["development", "test"].includes(environment ?? "development");
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && development)) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    // Configuration values may themselves contain sensitive data. Never include them.
    throw new Error("PET_FRONTEND_CONFIGURATION_INVALID");
  }
}

export function evolutionNumberFromE164(canonical: string): string {
  if (!/^\+[1-9]\d{1,14}$/.test(canonical) || normalizeClientPhone(canonical) !== canonical) {
    throw new Error("PET_EVOLUTION_DESTINATION_INVALID");
  }
  return canonical.slice(1);
}

export function buildPetMagicLink(frontendBase: string, slug: string, secret: string): string {
  if (!isCanonicalOpaqueSecret(secret)) throw new Error("PET_CHALLENGE_INVALID");
  return `${frontendBase}/${encodeURIComponent(slug)}/acceso#token=${secret}`;
}
