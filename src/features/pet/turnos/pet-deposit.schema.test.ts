import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";

// Run with pagos.test.setup.ts: only the verified Docker MySQL is writable.
async function withLocal(run: (connection: PoolConnection, localId: number) => Promise<void>): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [local] = await connection.query<ResultSetHeader>(
      "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')",
      ["Fixture pet deposit", `pet-deposit-${randomUUID()}`],
    );
    await run(connection, local.insertId);
  } finally {
    try { await connection.rollback(); } finally { connection.release(); }
  }
}

async function deposit(connection: PoolConnection, localId: number) {
  const [rows] = await connection.query<(RowDataPacket & {
    pet_deposit_enabled: number; pet_deposit_amount: string | null;
  })[]>("SELECT pet_deposit_enabled, pet_deposit_amount FROM locales WHERE id = ?", [localId]);
  assert.equal(rows.length, 1);
  return rows[0];
}

async function rejectsCheck(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) =>
    error !== null && typeof error === "object" && "code" in error &&
    error.code === "ER_CHECK_CONSTRAINT_VIOLATED");
}

after(async () => { await pool.end(); });

test("depósito PET: columnas, defaults, nulabilidad y CHECKs ENFORCED", async () => {
  const [columns] = await pool.query<(RowDataPacket & {
    TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string;
    IS_NULLABLE: string; COLUMN_DEFAULT: string | null;
  })[]>(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
          FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
            AND ((TABLE_NAME = 'locales' AND COLUMN_NAME IN ('pet_deposit_enabled', 'pet_deposit_amount'))
              OR (TABLE_NAME = 'turnos' AND COLUMN_NAME = 'pet_deposit_expires_at'))`);
  const byName = Object.fromEntries(columns.map(({ COLUMN_NAME, ...column }) => [COLUMN_NAME, column]));
  assert.deepEqual(Object.keys(byName).sort(), ["pet_deposit_amount", "pet_deposit_enabled", "pet_deposit_expires_at"]);
  assert.deepEqual([byName.pet_deposit_enabled.TABLE_NAME, byName.pet_deposit_enabled.COLUMN_TYPE,
    byName.pet_deposit_enabled.IS_NULLABLE, byName.pet_deposit_enabled.COLUMN_DEFAULT],
  ["locales", "tinyint(1)", "NO", "0"]);
  assert.deepEqual([byName.pet_deposit_amount.TABLE_NAME, byName.pet_deposit_amount.COLUMN_TYPE,
    byName.pet_deposit_amount.IS_NULLABLE, byName.pet_deposit_amount.COLUMN_DEFAULT],
  ["locales", "decimal(10,2)", "YES", null]);
  assert.deepEqual([byName.pet_deposit_expires_at.TABLE_NAME, byName.pet_deposit_expires_at.COLUMN_TYPE,
    byName.pet_deposit_expires_at.IS_NULLABLE, byName.pet_deposit_expires_at.COLUMN_DEFAULT],
  ["turnos", "datetime(3)", "YES", null]);

  const [checks] = await pool.query<(RowDataPacket & { CONSTRAINT_NAME: string; ENFORCED: string })[]>(
    `SELECT CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'locales' AND CONSTRAINT_TYPE = 'CHECK'
       AND CONSTRAINT_NAME IN ('chk_locales_pet_deposit_enabled', 'chk_locales_pet_deposit_amount', 'chk_locales_pet_deposit_required')`,
  );
  assert.deepEqual(checks.map(row => row.CONSTRAINT_NAME).sort(),
    ["chk_locales_pet_deposit_amount", "chk_locales_pet_deposit_enabled", "chk_locales_pet_deposit_required"]);
  assert.ok(checks.every(row => row.ENFORCED === "YES"));
});

test("depósito PET: default desactivado, monto NULL y positivo conservado al desactivar", async () => {
  await withLocal(async (connection, localId) => {
    const initial = await deposit(connection, localId);
    assert.equal(initial.pet_deposit_enabled, 0);
    assert.equal(initial.pet_deposit_amount, null);
    await connection.query("UPDATE locales SET pet_deposit_amount = ? WHERE id = ?", ["1500.25", localId]);
    assert.equal((await deposit(connection, localId)).pet_deposit_amount, "1500.25");
    await connection.query("UPDATE locales SET pet_deposit_enabled = 1 WHERE id = ?", [localId]);
    assert.equal((await deposit(connection, localId)).pet_deposit_enabled, 1);
    await connection.query("UPDATE locales SET pet_deposit_enabled = 0 WHERE id = ?", [localId]);
    assert.equal((await deposit(connection, localId)).pet_deposit_amount, "1500.25");
    await connection.query("UPDATE locales SET pet_deposit_amount = NULL WHERE id = ?", [localId]);
    assert.equal((await deposit(connection, localId)).pet_deposit_amount, null);
  });
});

test("depósito PET: 0/negativo rechazados, importe obligatorio si activo y booleano estricto", async () => {
  await withLocal(async (connection, localId) => {
    for (const amount of ["0.00", "-0.01"]) {
      await rejectsCheck(() => connection.query(
        "UPDATE locales SET pet_deposit_amount = ? WHERE id = ?", [amount, localId]));
      await rejectsCheck(() => connection.query(
        "UPDATE locales SET pet_deposit_enabled = 1, pet_deposit_amount = ? WHERE id = ?", [amount, localId]));
    }
    await rejectsCheck(() => connection.query(
      "UPDATE locales SET pet_deposit_enabled = 1 WHERE id = ?", [localId]));
    for (const enabled of [-1, 2]) {
      await rejectsCheck(() => connection.query(
        "UPDATE locales SET pet_deposit_enabled = ? WHERE id = ?", [enabled, localId]));
    }
    await assert.rejects(
      connection.query("UPDATE locales SET pet_deposit_enabled = NULL WHERE id = ?", [localId]),
      (error: unknown) => error !== null && typeof error === "object" && "code" in error &&
        error.code === "ER_BAD_NULL_ERROR",
    );
    assert.equal((await deposit(connection, localId)).pet_deposit_enabled, 0);
  });
});

test("depósito PET: límites representables positivos DECIMAL(10,2)", async () => {
  await withLocal(async (connection, localId) => {
    for (const amount of ["0.01", "99999999.99"]) {
      await connection.query("UPDATE locales SET pet_deposit_enabled = 1, pet_deposit_amount = ? WHERE id = ?", [amount, localId]);
      assert.equal((await deposit(connection, localId)).pet_deposit_amount, amount);
    }
  });
});

test("depósito PET: turno existente sin campo explícito mantiene NULL; DATETIME(3) conserva milisegundos", async () => {
  await withLocal(async (connection, localId) => {
    const [stylist] = await connection.query<ResultSetHeader>(
      "INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)", ["Fixture pet deposit", localId]);
    const [turno] = await connection.query<ResultSetHeader>(
      `INSERT INTO turnos (local_id, fecha, hora, hora_fin, estilista_id, cliente_nombre, cliente_telefono, estado)
       VALUES (?, '2099-10-23', '10:00:00', '10:30:00', ?, 'Fixture pet deposit', 'test', 'activo')`,
      [localId, stylist.insertId],
    );
    const [original] = await connection.query<(RowDataPacket & { pet_deposit_expires_at: string | null })[]>(
      "SELECT pet_deposit_expires_at FROM turnos WHERE id = ? AND local_id = ?", [turno.insertId, localId]);
    assert.equal(original[0].pet_deposit_expires_at, null);
    await connection.query("UPDATE turnos SET pet_deposit_expires_at = ? WHERE id = ? AND local_id = ?",
      ["2030-01-01 12:15:00.123", turno.insertId, localId]);
    const [updated] = await connection.query<(RowDataPacket & { deadline: string })[]>(
      `SELECT DATE_FORMAT(pet_deposit_expires_at, '%Y-%m-%d %H:%i:%s.%f') AS deadline
       FROM turnos WHERE id = ? AND local_id = ?`, [turno.insertId, localId]);
    assert.equal(updated[0].deadline, "2030-01-01 12:15:00.123000");
  });
});

test("depósito PET: índice de expiración en orden exacto y FKs preexistentes conservadas", async () => {
  const [indexes] = await pool.query<(RowDataPacket & { COLUMN_NAME: string; NON_UNIQUE: number })[]>(
    `SELECT COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turnos'
       AND INDEX_NAME = 'idx_turnos_pet_deposit_expiration' ORDER BY SEQ_IN_INDEX`,
  );
  assert.deepEqual(indexes.map(row => row.COLUMN_NAME), ["local_id", "estado", "pet_deposit_expires_at"]);
  assert.ok(indexes.every(row => row.NON_UNIQUE === 1));

  const [foreignKeys] = await pool.query<(RowDataPacket & { CONSTRAINT_NAME: string })[]>(
    `SELECT DISTINCT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'turnos' AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  for (const name of ["turnos_ibfk_2", "fk_turnos_mascota_local", "turnos_ibfk_3"]) {
    assert.ok(foreignKeys.some(key => key.CONSTRAINT_NAME === name), `FK original ${name} preservada`);
  }
});
