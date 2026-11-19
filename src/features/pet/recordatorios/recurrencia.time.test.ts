import assert from "node:assert/strict";
import { test } from "node:test";
import { contextoRecurrenciaPet, fechasRecurrenciaPet, sumarDiasCalendarioPet } from "./recurrencia.time";
import { argumentosSimulacionRecurrencia } from "../../../scripts/simular-pet-recurrencia";

test("D30 y D35 son días calendario, incluyendo febrero bisiesto y cambio de año", () => {
  assert.deepEqual(fechasRecurrenciaPet("2026-11-01"), { d0: "2026-11-01", d30: "2026-12-01", d35: "2026-12-06" });
  assert.equal(fechasRecurrenciaPet("2024-01-30").d30, "2024-02-29");
  assert.equal(fechasRecurrenciaPet("2023-01-30").d30, "2023-03-01");
  assert.equal(fechasRecurrenciaPet("2026-12-15").d30, "2027-01-14");
});

test("hoy es el día argentino, no el UTC del host: medianoche, mes y año", () => {
  assert.equal(contextoRecurrenciaPet(new Date("2027-01-01T02:59:59.999Z")).hoyArgentina, "2026-12-31");
  const next = contextoRecurrenciaPet(new Date("2027-01-01T03:00:00.000Z"));
  assert.equal(next.hoyArgentina, "2027-01-01");
  assert.equal(next.fechaServicioD30, "2026-12-02");
  assert.equal(next.horaArgentina, "00:00:00");
});

test("ventana D30 inclusiva 10:00 y exclusiva 12:00 ART", () => {
  for (const [instant, expected] of [
    ["2026-11-19T12:59:59.999Z", false], ["2026-11-19T13:00:00.000Z", true],
    ["2026-11-19T14:59:59.999Z", true], ["2026-11-19T15:00:00.000Z", false],
  ] as const) assert.equal(contextoRecurrenciaPet(new Date(instant)).enVentana, expected);
});

test("fechas imposibles, instantes inválidos y desbordes se rechazan", () => {
  for (const date of ["2026-02-29", "2026-13-01", "19/11/2026", "2026-1-01", ""]) {
    assert.throws(() => fechasRecurrenciaPet(date));
  }
  assert.throws(() => fechasRecurrenciaPet("9999-12-30"));
  assert.throws(() => sumarDiasCalendarioPet("2026-01-01", 1.5));
  assert.throws(() => contextoRecurrenciaPet(new Date("invalid")));
});

test("CLI exige tenant explícito y no ofrece reloj histórico, all-tenants ni bypass de consentimiento", () => {
  assert.deepEqual(argumentosSimulacionRecurrencia(["--local-id", "4", "--frontend-url", "https://example.test"]),
    { localId: 4, frontendUrl: "https://example.test" });
  for (const args of [[], ["--all"], ["--local-id", "0", "--frontend-url", "https://example.test"],
    ["--local-id", "4", "--now", "2026-11-19"],
    ["--local-id", "4", "--frontend-url", "https://example.test", "--assume-consent"],
    ["--local-id", "9007199254740992", "--frontend-url", "https://example.test"]]) {
    assert.throws(() => argumentosSimulacionRecurrencia(args));
  }
});
