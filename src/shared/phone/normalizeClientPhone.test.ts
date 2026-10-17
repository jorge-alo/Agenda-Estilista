import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidClientPhoneError, normalizeClientPhone } from "./normalizeClientPhone";

test("AR: formato nacional móvil válido canonicaliza el prefijo doméstico", () => {
  assert.equal(normalizeClientPhone("011 15 2345-6789"), "+5491123456789");
});

test("AR: espacios, paréntesis y guiones equivalentes producen el mismo E.164", () => {
  const canonical = normalizeClientPhone("(011) 15-2345-6789");
  assert.equal(canonical, normalizeClientPhone("011 15 2345 6789"));
  assert.equal(canonical, normalizeClientPhone("+54 9 11 2345-6789"));
  assert.equal(canonical, normalizeClientPhone("+5491123456789"));
});

test("AR: fijo nacional y representación internacional fija coinciden sin convertirse a móvil", () => {
  const canonical = normalizeClientPhone("011 2345-6789");
  assert.equal(canonical, "+541123456789");
  assert.equal(canonical, normalizeClientPhone("+54 11 2345 6789"));
});

test("country calling code explícito admite internacional válido y conserva ese país", () => {
  assert.equal(normalizeClientPhone("+1 (213) 373-4253"), "+12133734253");
});

test("rechaza vacío, texto, extracción parcial, demasiado corto, imposible y calling code inválido", () => {
  const invalid = [
    "",
    "   ",
    "abc",
    "llamame al +54 9 11 2345 6789",
    "123",
    "+54 11 1234-567",
    "+999123456789",
  ];

  for (const input of invalid) {
    assert.throws(() => normalizeClientPhone(input), InvalidClientPhoneError, `input de prueba ${JSON.stringify(input)}`);
  }
});

test("el resultado público del helper es solo una cadena E.164", () => {
  const result = normalizeClientPhone("+54 9 11 2345-6789");
  assert.equal(typeof result, "string");
  assert.equal(result, "+5491123456789");
});
