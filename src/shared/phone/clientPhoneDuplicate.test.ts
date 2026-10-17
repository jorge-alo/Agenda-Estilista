import assert from "node:assert/strict";
import { test } from "node:test";
import { clientPhoneDuplicateKey } from "./clientPhoneDuplicate";

function duplicate(key: string) {
  return { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000",
    sqlMessage: `Duplicate entry '<redacted>' for key 'clientes.${key}'` };
}

test("distingue la UNIQUE canónica y la legacy por nombre exacto del índice", () => {
  assert.equal(clientPhoneDuplicateKey(duplicate("uq_clientes_telefono_normalizado_local")), "canonical");
  assert.equal(clientPhoneDuplicateKey(duplicate("unique_cliente_local")), "legacy");
});

test("no confunde un horario duplicado con cliente ni interpreta errores incompletos", () => {
  assert.equal(clientPhoneDuplicateKey(duplicate("uq_turno_estilista_fecha_hora_activo")), null);
  assert.equal(clientPhoneDuplicateKey({ ...duplicate("uq_clientes_telefono_normalizado_local"), errno: 999 }), null);
  assert.equal(clientPhoneDuplicateKey({ ...duplicate("uq_clientes_telefono_normalizado_local"), sqlMessage: "otro formato" }), null);
  assert.equal(clientPhoneDuplicateKey({ ...duplicate("uq_clientes_telefono_normalizado_local"), code: "ER_LOCK_DEADLOCK" }), null);
});
