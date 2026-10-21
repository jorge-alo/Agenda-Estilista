import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as turnoService from "./turnos.service";
import { createAdmin } from "./turnos.controller";

const SQL_SENTINEL = "SQL_SECRET_SENTINEL_M6D";
const STACK_SENTINEL = "STACK_SECRET_SENTINEL_M6D";

async function invokeCreateAdmin(): Promise<{ status: number; body: unknown }> {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  };
  await createAdmin({ user: { localId: 82 }, body: {} } as never, res as never);
  return { status, body };
}

test("unexpected error from legacy admin turn handler is generic and excludes SQL/stack", async (t: TestContext) => {
  const detail = new Error(`${SQL_SENTINEL}\nSELECT * FROM usuarios\n${STACK_SENTINEL}`);
  t.mock.method(turnoService, "createTurno", async () => { throw detail; });

  const response = await invokeCreateAdmin();
  const json = JSON.stringify(response.body);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Error al crear turno" });
  assert.ok(!json.includes(SQL_SENTINEL));
  assert.ok(!json.includes(STACK_SENTINEL));
  assert.ok(!json.includes("SELECT"));
});

test("known safe BEAUTY domain error retains the legacy status and message", async (t: TestContext) => {
  t.mock.method(turnoService, "createTurno", async () => { throw new Error("Ese horario ya está ocupado"); });

  const response = await invokeCreateAdmin();
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Ese horario ya está ocupado" });
});
