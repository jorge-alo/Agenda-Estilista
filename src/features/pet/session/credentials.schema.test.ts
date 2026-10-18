import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, QueryResult, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { generateOpaqueSecret, hashOpaqueSecret } from "./opaqueSecret";

// Run through pagos.test.setup.ts: guarded Docker pool, without loading .env.
const tables = ["pet_access_tokens", "pet_client_sessions"] as const;
type CredentialTable = typeof tables[number];
const createdAt = "2030-01-01 12:00:00.123";
const expiresAt = "2030-01-01 12:15:00.123";
const earlier = "2030-01-01 11:59:59.999";
const terminalAt = "2030-01-01 12:01:00.123";

// mysql2 errors can contain SQL/binary hashes. Never hand raw DB errors to the test reporter.
class SchemaQueryError extends Error {
  constructor(readonly code: string) { super(`PET credential schema: ${code}`); }
}
function safeError(error: unknown): SchemaQueryError {
  if (error instanceof SchemaQueryError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  const allowed = ["ER_DUP_ENTRY", "ER_NO_REFERENCED_ROW_2", "ER_CHECK_CONSTRAINT_VIOLATED"];
  return new SchemaQueryError(typeof code === "string" && allowed.includes(code) ? code : "DB_TEST_FAILURE");
}
async function query<T extends QueryResult>(connection: PoolConnection, sql: string, values: unknown[] = []): Promise<T> {
  try {
    const [result] = await connection.query<T>(sql, values);
    return result;
  } catch (error) { throw safeError(error); }
}

interface Fixture {
  connection: PoolConnection;
  localA: number;
  localB: number;
  clienteA: number;
  clienteB: number;
}
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const ids: number[] = [];
    const clients: number[] = [];
    for (let i = 0; i < 2; i++) {
      const label = `pet11c1-${randomUUID()}`;
      const local = await query<ResultSetHeader>(connection,
        "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, 'PET_GROOMING')", [label, label]);
      ids.push(local.insertId);
      const phone = `112345200${i}`;
      const client = await query<ResultSetHeader>(connection,
        "INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
        [local.insertId, label, phone, normalizeClientPhone(phone)]);
      clients.push(client.insertId);
    }
    await run({ connection, localA: ids[0], localB: ids[1], clienteA: clients[0], clienteB: clients[1] });
  } finally {
    try { await connection.rollback(); } finally { connection.release(); }
  }
}

interface CredentialValues {
  localId?: number;
  clienteId?: number;
  hash?: Buffer;
  purpose?: string;
  expires?: string;
  consumed?: string | null;
  revoked?: string | null;
}
async function insert(fixture: Fixture, table: CredentialTable, values: CredentialValues = {}): Promise<number> {
  const { connection, localA, clienteA } = fixture;
  const common = [values.localId ?? localA, values.clienteId ?? clienteA,
    values.hash ?? hashOpaqueSecret(generateOpaqueSecret()), values.expires ?? expiresAt];
  const result = table === "pet_access_tokens"
    ? await query<ResultSetHeader>(connection,
      `INSERT INTO pet_access_tokens
       (local_id, cliente_id, token_hash, expires_at, purpose, consumed_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [...common, values.purpose ?? "PET_PUBLIC_LOGIN", values.consumed ?? null, values.revoked ?? null, createdAt])
    : await query<ResultSetHeader>(connection,
      `INSERT INTO pet_client_sessions
       (local_id, cliente_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [...common, values.revoked ?? null, createdAt]);
  return result.insertId;
}
async function count(fixture: Fixture, table: CredentialTable, localId: number, clienteId: number): Promise<number> {
  // table is an internal literal union, never input from a request.
  const [row] = await query<(RowDataPacket & { total: number })[]>(fixture.connection,
    `SELECT COUNT(*) AS total FROM ${table} WHERE local_id = ? AND cliente_id = ?`, [localId, clienteId]);
  return Number(row.total);
}
const hasCode = (code: string) => (error: unknown) => error instanceof SchemaQueryError && error.code === code;

after(async () => { await pool.end(); });

test("PET credentials SQL: FK compuesta rechaza cliente A con local B en ambas tablas", async () => {
  await withFixture(async fixture => {
    for (const table of tables) {
      await assert.rejects(insert(fixture, table, { localId: fixture.localB }), hasCode("ER_NO_REFERENCED_ROW_2"));
      assert.equal(await count(fixture, table, fixture.localA, fixture.clienteA), 0);
    }
  });
});

test("PET credentials SQL: UNIQUE de hash rechaza duplicado incluso en otro tenant", async () => {
  await withFixture(async fixture => {
    for (const table of tables) {
      const hash = hashOpaqueSecret(generateOpaqueSecret());
      await insert(fixture, table, { hash });
      await assert.rejects(insert(fixture, table, { hash }), hasCode("ER_DUP_ENTRY"));
      await assert.rejects(insert(fixture, table, { hash, localId: fixture.localB, clienteId: fixture.clienteB }), hasCode("ER_DUP_ENTRY"));
      assert.equal(await count(fixture, table, fixture.localA, fixture.clienteA), 1);
      assert.equal(await count(fixture, table, fixture.localB, fixture.clienteB), 0);
    }
  });
});

test("PET credentials SQL: CASCADE cliente elimina ambas credenciales y conserva otro tenant", async () => {
  await withFixture(async fixture => {
    for (const table of tables) {
      await insert(fixture, table);
      await insert(fixture, table, { localId: fixture.localB, clienteId: fixture.clienteB });
    }
    await query<ResultSetHeader>(fixture.connection,
      "DELETE FROM clientes WHERE id = ? AND local_id = ?", [fixture.clienteA, fixture.localA]);
    for (const table of tables) {
      assert.equal(await count(fixture, table, fixture.localA, fixture.clienteA), 0);
      assert.equal(await count(fixture, table, fixture.localB, fixture.clienteB), 1);
    }
  });
});

test("PET credentials SQL: CASCADE local -> cliente -> credenciales sin FK directa adicional", async () => {
  await withFixture(async fixture => {
    for (const table of tables) await insert(fixture, table);
    await query<ResultSetHeader>(fixture.connection, "DELETE FROM locales WHERE id = ?", [fixture.localA]);
    for (const table of tables) assert.equal(await count(fixture, table, fixture.localA, fixture.clienteA), 0);
    const [client] = await query<(RowDataPacket & { total: number })[]>(fixture.connection,
      "SELECT COUNT(*) AS total FROM clientes WHERE id = ? AND local_id = ?", [fixture.clienteB, fixture.localB]);
    assert.equal(Number(client.total), 1);
  });
});

test("PET credentials SQL: CHECK purpose rechaza otros propositos y diferencias de mayusculas", async () => {
  await withFixture(async fixture => {
    for (const purpose of ["PET_OTHER", "pet_public_login"]) {
      await assert.rejects(insert(fixture, "pet_access_tokens", { purpose }), hasCode("ER_CHECK_CONSTRAINT_VIOLATED"));
    }
  });
});

for (const table of tables) {
  test(`PET credentials SQL: ${table} exige expires_at posterior a created_at`, async () => {
    await withFixture(async fixture => {
      for (const expires of [createdAt, earlier]) {
        await assert.rejects(insert(fixture, table, { expires }), hasCode("ER_CHECK_CONSTRAINT_VIOLATED"));
      }
    });
  });

  test(`PET credentials SQL: ${table} rechaza revoked_at anterior a created_at`, async () => {
    await withFixture(async fixture => {
      await assert.rejects(insert(fixture, table, { revoked: earlier }), hasCode("ER_CHECK_CONSTRAINT_VIOLATED"));
    });
  });

  test(`PET credentials SQL: ${table} conserva BINARY(32) y precision de milisegundos`, async () => {
    await withFixture(async fixture => {
      const hash = hashOpaqueSecret(generateOpaqueSecret());
      const id = await insert(fixture, table, { hash });
      const [row] = await query<(RowDataPacket & { token_hash: Buffer; created: string })[]>(fixture.connection,
        `SELECT token_hash, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created
         FROM ${table} WHERE id = ? AND local_id = ?`, [id, fixture.localA]);
      assert.ok(Buffer.isBuffer(row.token_hash));
      assert.equal(row.token_hash.length, 32);
      assert.ok(row.token_hash.equals(hash));
      assert.equal(row.created, `${createdAt}000`);
    });
  });
}

test("PET credentials SQL: CHECK consumed_at rechaza consumo anterior a created_at", async () => {
  await withFixture(async fixture => {
    await assert.rejects(insert(fixture, "pet_access_tokens", { consumed: earlier }), hasCode("ER_CHECK_CONSTRAINT_VIOLATED"));
  });
});

test("PET credentials SQL: challenge no puede estar consumido y revocado simultaneamente", async () => {
  await withFixture(async fixture => {
    await assert.rejects(insert(fixture, "pet_access_tokens", { consumed: terminalAt, revoked: terminalAt }), hasCode("ER_CHECK_CONSTRAINT_VIOLATED"));
  });
});

test("PET credentials SQL: estados validos y limites temporales inclusivos de consumo/revocacion", async () => {
  await withFixture(async fixture => {
    await insert(fixture, "pet_access_tokens");
    await insert(fixture, "pet_access_tokens", { consumed: createdAt });
    await insert(fixture, "pet_access_tokens", { revoked: createdAt });
    await insert(fixture, "pet_client_sessions");
    await insert(fixture, "pet_client_sessions", { revoked: createdAt });
    assert.equal(await count(fixture, "pet_access_tokens", fixture.localA, fixture.clienteA), 3);
    assert.equal(await count(fixture, "pet_client_sessions", fixture.localA, fixture.clienteA), 2);
  });
});
