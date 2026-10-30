import assert from "node:assert/strict";
import { test } from "node:test";
import { fechaHoraSqlUtc, ventanaRecordatorioPet } from "./recordatorios.time";

test("ventana ART inclusiva a las 10:00 y exclusiva a las 12:00, incluso con milisegundos", () => {
  assert.equal(ventanaRecordatorioPet(new Date("2026-10-29T12:59:59.999Z")), null);
  assert.deepEqual(ventanaRecordatorioPet(new Date("2026-10-29T13:00:00.000Z")), {
    manana: "2026-10-30", corteUtc: new Date("2026-10-29T13:00:00.000Z"),
  });
  assert.equal(ventanaRecordatorioPet(new Date("2026-10-29T14:59:59.999Z"))?.manana, "2026-10-30");
  assert.equal(ventanaRecordatorioPet(new Date("2026-10-29T15:00:00.000Z")), null);
});

test("día local argentino: cambio de mes, año y día sin depender de TZ del host", () => {
  assert.equal(ventanaRecordatorioPet(new Date("2026-10-31T13:00:00Z"))?.manana, "2026-11-01");
  assert.equal(ventanaRecordatorioPet(new Date("2026-12-31T13:00:00Z"))?.manana, "2027-01-01");
  assert.equal(ventanaRecordatorioPet(new Date("2026-10-30T02:59:59Z")), null);
  assert.equal(fechaHoraSqlUtc(new Date("2026-10-29T12:59:59.999Z")), "2026-10-29 12:59:59.999");
});
