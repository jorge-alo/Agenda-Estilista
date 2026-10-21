import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as publicService from "./public.service";
import { reservar } from "./public.controller";

const SQL_SENTINEL = "PUBLIC_SQL_SECRET_SENTINEL_M6D";
const STACK_SENTINEL = "PUBLIC_STACK_SECRET_SENTINEL_M6D";

async function invokeReserve(): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  };
  await reservar({ body: {
    slug: "public-fixture", fecha: "2099-01-01", hora: "10:00", estilista_id: 1,
    servicio_id: 2, cliente_nombre: "fixture", cliente_telefono: "1123456789",
  } } as never, res as never);
  return { status, body };
}

test("unexpected public booking error is generic and excludes SQL/stack", async (t: TestContext) => {
  const detail = new Error(`${SQL_SENTINEL}\nSELECT * FROM turnos\n${STACK_SENTINEL}`);
  t.mock.method(publicService, "createTurnoPublico", async () => { throw detail; });

  const response = await invokeReserve();
  const json = JSON.stringify(response.body);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Error al reservar turno" });
  assert.ok(!json.includes(SQL_SENTINEL));
  assert.ok(!json.includes(STACK_SENTINEL));
  assert.ok(!json.includes("SELECT"));
});

test("known safe public domain error retains its contractual status and message", async (t: TestContext) => {
  t.mock.method(publicService, "createTurnoPublico", async () => { throw new Error("Ese horario ya está ocupado"); });

  const response = await invokeReserve();
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Ese horario ya está ocupado" });
});
