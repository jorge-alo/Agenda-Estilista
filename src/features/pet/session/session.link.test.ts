import assert from "node:assert/strict";
import { test } from "node:test";
import { generateOpaqueSecret } from "./opaqueSecret";
import { buildPetMagicLink, evolutionNumberFromE164, validatePetFrontendUrl } from "./session.link";
import { PetSessionRequestError, validateSessionPhone } from "./session.types";

test("PET access helpers: FRONTEND_URL HTTPS absoluta conserva base path y elimina slash final", () => {
  assert.equal(validatePetFrontendUrl("https://frontend.test/base/", "production"), "https://frontend.test/base");
  assert.equal(validatePetFrontendUrl("https://frontend.test", "production"), "https://frontend.test");
});

test("PET access helpers: HTTP solo en development/test, nunca production ni ambientes desconocidos", () => {
  for (const environment of [undefined, "development", "test"]) {
    assert.equal(validatePetFrontendUrl("http://localhost:5173/", environment), "http://localhost:5173");
  }
  for (const environment of ["production", "staging"]) {
    assert.throws(() => validatePetFrontendUrl("http://frontend.test", environment));
  }
});

test("PET access helpers: URL invalida/credenciales/query/fragment fallan sin exponer configuracion", () => {
  const invalid = [undefined, "", "/relative", "not-a-url", "ftp://frontend.test",
    "https://user:CONFIG_SENTINEL@frontend.test", "https://frontend.test/?secret=CONFIG_SENTINEL",
    "https://frontend.test/#CONFIG_SENTINEL"];
  for (const value of invalid) {
    assert.throws(() => validatePetFrontendUrl(value, "production"), { message: "PET_FRONTEND_CONFIGURATION_INVALID" });
  }
});

test("PET access helpers: Evolution quita solo '+' y conserva country code y fijo/movil", () => {
  for (const canonical of ["+5491123456789", "+541123456789", "+12133734253", "+442079460018", "+551155256325"]) {
    assert.ok(evolutionNumberFromE164(canonical) === canonical.slice(1));
  }
});

test("PET access helpers: transporte rechaza display, nacional y E.164 imposible sin autocorreccion", () => {
  for (const input of ["1123456789", "5491123456789", " +5491123456789", "+54 9 11 2345-6789", "+999123456789", ""]) {
    assert.throws(() => evolutionNumberFromE164(input));
  }
});

test("PET access helpers: magic link usa fragment, slug codificado y base configurada", () => {
  const secret = generateOpaqueSecret();
  const link = new URL(buildPetMagicLink("https://frontend.test/base", "salón/mascotas", secret));
  assert.equal(link.origin, "https://frontend.test");
  assert.equal(link.pathname, "/base/sal%C3%B3n%2Fmascotas/acceso");
  assert.equal(link.search, "");
  assert.ok(link.hash === `#token=${secret}`);
});

test("PET access helpers: no construye link con secreto no canonico", () => {
  assert.throws(() => buildPetMagicLink("https://frontend.test", "pet", "invalid"), { message: "PET_CHALLENGE_INVALID" });
});

test("PET access helpers: body exacto, telefono string no vacio y maximo 50 caracteres", () => {
  const invalid: unknown[] = [undefined, null, [], "text", {}, { telefono: 123 }, { telefono: null },
    { telefono: "" }, { telefono: "   " }, { telefono: "1".repeat(51) },
    { telefono: "1123456789", localId: 1 }, { telefono: "1123456789", clienteId: 1 }];
  for (const body of invalid) assert.throws(() => validateSessionPhone(body), PetSessionRequestError);
  assert.equal(validateSessionPhone({ telefono: " 1123456789 " }), " 1123456789 ");
  assert.equal(validateSessionPhone({ telefono: "1".repeat(50) }).length, 50);
  assert.equal(validateSessionPhone({ telefono: "not a phone" }), "not a phone", "la forma del body no decide identidad");
});
