import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as rawHttpRequest, type Server } from "node:http";
import { after, afterEach, before, beforeEach, test, type TestContext } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { PoolConnection, QueryResult, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { sanitizedErrorMiddleware } from "../../../middlewares/sanitizedError.middleware";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { evolutionClient } from "../../notifications/infrastructure/evolution.client";
import { generateOpaqueSecret, hashOpaqueSecret, isCanonicalOpaqueSecret } from "./opaqueSecret";
import { parsePetSessionBearer, petPublicSessionMiddleware } from "./petPublicSession.middleware";
import { consumePetAccess } from "./session.service";
import { petSessionPublicRouter } from "./session.routes";
import { PetSessionRequestError, validateConsumeToken } from "./session.types";

const prefix = `pet11c3-${randomUUID()}`;
const ownedLocals: number[] = [];
let nextFixture = 0;
let server: Server;
let port: number;
const logs: unknown[][] = [];
const messages: string[] = [];

// Never send mysql2 errors (which can embed SQL/hashes) to the test reporter.
async function q<T extends QueryResult = RowDataPacket[]>(sql: string, values: unknown[] = []): Promise<T> {
  try { return (await pool.query<T>(sql, values))[0]; }
  catch { throw new Error("PET11C3_FIXTURE_DB_OPERATION_FAILED"); }
}
interface Fixture { localId: number; clienteId: number; mascotaId: number; slug: string }
async function fixture(options: { kind?: string; active?: number; canonicalNull?: boolean } = {}): Promise<Fixture> {
  const slug = `${prefix}-${nextFixture++}`;
  const local = await q<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, activo, business_type) VALUES (?, ?, ?, ?)",
    [prefix, slug, options.active ?? 1, options.kind ?? "PET_GROOMING"]);
  ownedLocals.push(local.insertId);
  const client = await q<ResultSetHeader>(
    "INSERT INTO clientes (nombre, local_id, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
    [prefix, local.insertId, "1123452000", options.canonicalNull ? null : normalizeClientPhone("1123452000")]);
  const pet = await q<ResultSetHeader>(
    "INSERT INTO mascotas (nombre, local_id, activo, reserva_online_habilitada) VALUES (?, ?, 1, 1)",
    [prefix, local.insertId]);
  await q("INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
    [local.insertId, pet.insertId, client.insertId]);
  return { localId: local.insertId, clienteId: client.insertId, mascotaId: pet.insertId, slug };
}
interface Credential { id: number; secret: string }
async function seedChallenge(f: Fixture, options: {
  expiresIn?: number; state?: "active" | "consumed" | "revoked"; age?: number;
} = {}): Promise<Credential> {
  const secret = generateOpaqueSecret();
  const state = options.state ?? "active";
  const row = await q<ResultSetHeader>(
    `INSERT INTO pet_access_tokens
       (local_id, cliente_id, purpose, token_hash, created_at, expires_at, consumed_at, revoked_at)
     SELECT ?, ?, 'PET_PUBLIC_LOGIN', ?, t.created, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
       CASE WHEN ? = 'consumed' THEN DATE_ADD(t.created, INTERVAL 1 SECOND) ELSE NULL END,
       CASE WHEN ? = 'revoked' THEN DATE_ADD(t.created, INTERVAL 1 SECOND) ELSE NULL END
     FROM (SELECT DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND) AS created) t`,
    [f.localId, f.clienteId, hashOpaqueSecret(secret), options.expiresIn ?? 900, state, state, options.age ?? 3600]);
  return { id: row.insertId, secret };
}
async function seedSession(f: Fixture, options: { expiresIn?: number; revoked?: boolean } = {}): Promise<Credential> {
  const secret = generateOpaqueSecret();
  const row = await q<ResultSetHeader>(
    `INSERT INTO pet_client_sessions (local_id, cliente_id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR),
       DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), CASE WHEN ? THEN UTC_TIMESTAMP(3) ELSE NULL END)`,
    [f.localId, f.clienteId, hashOpaqueSecret(secret), options.expiresIn ?? 43200, options.revoked ?? false]);
  return { id: row.insertId, secret };
}
interface ApiResult { status: number; data: unknown; noStore: boolean }
async function call(path: string, options: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
  let data: unknown;
  try { data = JSON.parse(await response.text()); } catch { throw new Error("PET11C3_RESPONSE_NOT_JSON"); }
  return { status: response.status, data, noStore: response.headers.get("cache-control") === "no-store" };
}
function consume(slug: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  return call(`/api/pet/public/${encodeURIComponent(slug)}/session/consume`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function authenticate(slug: string, authorization?: string): Promise<ApiResult> {
  return call(`/__pet_session_test/${encodeURIComponent(slug)}`, {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}
function objectData(result: ApiResult): Record<string, unknown> {
  assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
  return result.data as Record<string, unknown>;
}
function rejected(result: ApiResult, code = "PET_ACCESS_INVALID", status = 401): void {
  assert.equal(result.status, status);
  assert.equal(result.noStore, true);
  const data = objectData(result);
  assert.deepEqual(Object.keys(data), ["error"]);
  assert.ok(data.error === code);
}
function successful(result: ApiResult): { sessionToken: string; expiresAt: string } {
  assert.equal(result.status, 201);
  assert.equal(result.noStore, true);
  const data = objectData(result);
  assert.deepEqual(Object.keys(data).sort(), ["expiresAt", "sessionToken"]);
  assert.ok(isCanonicalOpaqueSecret(data.sessionToken));
  assert.ok(typeof data.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.expiresAt));
  return { sessionToken: data.sessionToken, expiresAt: data.expiresAt as string };
}
async function counts(f: Fixture): Promise<{ sessions: number; consumed: number }> {
  const [row] = await q<(RowDataPacket & { sessions: number; consumed: number })[]>(
    `SELECT (SELECT COUNT(*) FROM pet_client_sessions WHERE local_id = ? AND cliente_id = ?) AS sessions,
            (SELECT COUNT(*) FROM pet_access_tokens WHERE local_id = ? AND cliente_id = ? AND consumed_at IS NOT NULL) AS consumed`,
    [f.localId, f.clienteId, f.localId, f.clienteId]);
  return { sessions: Number(row.sessions), consumed: Number(row.consumed) };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
async function watchdog<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PET11C3_WATCHDOG")), 15000);
    })]);
  } finally { clearTimeout(timer); }
}
function instrument(t: TestContext, change: (connection: PoolConnection) => void): void {
  const get = pool.getConnection.bind(pool);
  const seen = new WeakSet<object>();
  t.mock.method(pool, "getConnection", async () => {
    const connection = await get();
    if (!seen.has(connection)) { seen.add(connection); change(connection); }
    return connection;
  });
}
async function waitForLock(blocker: number, requester: number, table: string): Promise<void> {
  await watchdog((async () => {
    for (;;) {
      const [row] = await q<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
         JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
         JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
         JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
         WHERE b.PROCESSLIST_ID = ? AND r.PROCESSLIST_ID = ? AND l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = ?`,
        [blocker, requester, table]);
      if (Number(row.total)) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  })());
}

before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/pet/public", petSessionPublicRouter);
  // Test-only harness: no session/me or other production endpoint is introduced.
  app.get("/__pet_session_test/:slug", petPublicSessionMiddleware, (req, res) => {
    res.json({ context: req.petSession, adminUserSet: Object.prototype.hasOwnProperty.call(req, "user") });
  });
  app.use(sanitizedErrorMiddleware);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});
beforeEach(t => {
  if (!("mock" in t)) throw new Error("Test mocks unavailable");
  t.mock.property(process, "env", { ...process.env, FRONTEND_URL: "https://pet-frontend.test", NODE_ENV: "test" });
  logs.length = 0;
  messages.length = 0;
  for (const method of ["log", "warn", "error", "info"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
  t.mock.method(evolutionClient, "post", async (_path: string, payload?: unknown) => {
    messages.push((payload as { textMessage: { text: string } }).textMessage.text);
    return { data: {} } as never;
  });
});
afterEach(async t => {
  if ("mock" in t) t.mock.restoreAll();
  for (const localId of ownedLocals.splice(0)) await q("DELETE FROM locales WHERE id = ? AND nombre = ?", [localId, prefix]);
});
after(async () => {
  try {
    const [row] = await q<(RowDataPacket & { total: number })[]>("SELECT COUNT(*) AS total FROM locales WHERE nombre = ?", [prefix]);
    assert.equal(Number(row.total), 0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await pool.end();
  }
});

test("PET consume: body exacto y formato canonico antes de obtener conexion DB", async t => {
  let connections = 0;
  t.mock.method(pool, "getConnection", async () => { connections++; throw new Error("DB_MUST_NOT_BE_USED"); });
  const canonical = generateOpaqueSecret();
  const alias = Buffer.alloc(32).toString("base64url").slice(0, -1) + "B";
  const invalid: unknown[] = [undefined, null, [], "text", {}, { token: 123 }, { token: "" },
    { token: "SECRET_BODY_SENTINEL" }, { token: ` ${canonical}` }, { token: `${canonical}=` },
    { token: alias }, { token: canonical, localId: 1 }, { token: canonical, extra: true }];
  for (const body of invalid) {
    assert.throws(() => validateConsumeToken(body), PetSessionRequestError);
    await assert.rejects(consumePetAccess("any-slug", body), error =>
      error instanceof PetSessionRequestError && error.status === 401 && error.code === "PET_ACCESS_INVALID");
  }
  assert.equal(connections, 0);
  assert.equal(logs.length, 0);
});

test("PET consume: valido crea secreto independiente, hash binario y expiresAt exacto de DB con TTL 12h", async () => {
  const f = await fixture();
  const challenge = await seedChallenge(f);
  const result = successful(await consume(f.slug, { token: challenge.secret }));
  assert.ok(result.sessionToken !== challenge.secret);
  const [row] = await q<(RowDataPacket & { token_hash: Buffer; ttl: number; sameExpiry: number })[]>(
    `SELECT token_hash, TIMESTAMPDIFF(MICROSECOND, created_at, expires_at) AS ttl,
       expires_at = STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%fZ') AS sameExpiry
     FROM pet_client_sessions WHERE local_id = ? AND cliente_id = ?`, [result.expiresAt, f.localId, f.clienteId]);
  assert.ok(Buffer.isBuffer(row.token_hash) && row.token_hash.length === 32);
  assert.ok(row.token_hash.equals(hashOpaqueSecret(result.sessionToken)));
  assert.ok(!row.token_hash.equals(hashOpaqueSecret(challenge.secret)));
  assert.equal(Number(row.ttl), 43_200_000_000);
  assert.equal(row.sameExpiry, 1);
  assert.deepEqual(await counts(f), { sessions: 1, consumed: 1 });
  assert.equal(logs.length, 0);
});

test("PET consume: request C.2 -> enlace simulado -> consumo real, sin llamadas Evolution reales", async () => {
  const f = await fixture();
  const requested = await call(`/api/pet/public/${f.slug}/session/request`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefono: "1123452000" }),
  });
  assert.equal(requested.status, 202);
  assert.equal(messages.length, 1);
  const match = messages[0].match(/https?:\/\/[^\s]+/);
  assert.ok(match);
  const challengeSecret = new URLSearchParams(new URL(match[0]).hash.slice(1)).get("token");
  assert.ok(isCanonicalOpaqueSecret(challengeSecret));
  successful(await consume(f.slug, { token: challengeSecret }));
  assert.deepEqual(await counts(f), { sessions: 1, consumed: 1 });
  assert.equal(logs.length, 0);
});

test("PET consume: HTTP rechaza token/body invalido con 401 comun y no-store", async () => {
  const f = await fixture();
  for (const body of [{}, [], { token: "SECRET_BODY_SENTINEL" }, { token: 123 },
    { token: generateOpaqueSecret(), extra: true }]) rejected(await consume(f.slug, body));
  assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
  assert.equal(logs.length, 0);
});

for (const state of ["random", "expired", "consumed", "revoked"] as const) {
  test(`PET consume: ${state} produce el mismo 401 sin nueva sesion`, async () => {
    const f = await fixture();
    const challenge = await seedChallenge(f, {
      ...(state === "expired" ? { expiresIn: -60 } : {}),
      ...(state === "consumed" || state === "revoked" ? { state } : {}),
    });
    rejected(await consume(f.slug, { token: state === "random" ? generateOpaqueSecret() : challenge.secret }));
    assert.deepEqual(await counts(f), { sessions: 0, consumed: state === "consumed" ? 1 : 0 });
  });
}

test("PET consume: local inexistente/inactivo/BEAUTY conserva 404 con token formalmente valido", async () => {
  const inactive = await fixture({ active: 0 });
  const beauty = await fixture({ kind: "BEAUTY" });
  for (const slug of [inactive.slug, beauty.slug, `${prefix}-missing`]) {
    rejected(await consume(slug, { token: generateOpaqueSecret() }), "PET_LOCAL_NOT_FOUND", 404);
  }
});

test("PET consume: challenge A no se consume bajo slug B aunque el canonical sea igual", async () => {
  const a = await fixture();
  const b = await fixture();
  const challenge = await seedChallenge(a);
  rejected(await consume(b.slug, { token: challenge.secret }));
  assert.deepEqual(await counts(a), { sessions: 0, consumed: 0 });
  assert.deepEqual(await counts(b), { sessions: 0, consumed: 0 });
  successful(await consume(a.slug, { token: challenge.secret }));
});

test("PET consume: cliente canonical NULL no puede crear sesion ni usa display", async () => {
  const f = await fixture({ canonicalNull: true });
  const challenge = await seedChallenge(f);
  rejected(await consume(f.slug, { token: challenge.secret }));
  assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
});

test("PET consume: canonical actual distinto pero no NULL conserva binding al cliente", async () => {
  const f = await fixture();
  const challenge = await seedChallenge(f);
  await q("UPDATE clientes SET telefono_normalizado = ? WHERE id = ? AND local_id = ?",
    [normalizeClientPhone("1123452001"), f.clienteId, f.localId]);
  successful(await consume(f.slug, { token: challenge.secret }));
});

for (const change of ["inactive", "offline", "unlink", "deletePet"] as const) {
  test(`PET consume: vuelve a validar elegibilidad actual (${change}) sin exigir servicios`, async () => {
    const f = await fixture();
    const challenge = await seedChallenge(f);
    if (change === "inactive") await q("UPDATE mascotas SET activo = 0 WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
    if (change === "offline") await q("UPDATE mascotas SET reserva_online_habilitada = 0 WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
    if (change === "unlink") await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?", [f.mascotaId, f.clienteId, f.localId]);
    if (change === "deletePet") await q("DELETE FROM mascotas WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
    rejected(await consume(f.slug, { token: challenge.secret }));
    assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
  });
}

test("PET consume: purpose incorrecto en lookup simulado se rechaza sin alterar CHECK ni fila", async t => {
  const f = await fixture();
  const challenge = await seedChallenge(f);
  instrument(t, connection => {
    const query = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      return query(...args).then(result => {
        if (String(args[0]).includes("SELECT id, cliente_id, purpose, consumed_at")) {
          return [(result[0] as RowDataPacket[]).map(row => ({ ...row, purpose: "PET_OTHER" })), result[1]];
        }
        return result;
      });
    }) as typeof connection.query);
  });
  rejected(await consume(f.slug, { token: challenge.secret }));
  assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
  const [row] = await q<(RowDataPacket & { purpose: string })[]>(
    "SELECT purpose FROM pet_access_tokens WHERE id = ? AND local_id = ?", [challenge.id, f.localId]);
  assert.equal(row.purpose, "PET_PUBLIC_LOGIN");
});

for (const failure of ["zeroUpdate", "update", "insert", "commit"] as const) {
  test(`PET consume: fallo ${failure} revierte consumo/sesion y no devuelve secreto`, async t => {
    const f = await fixture();
    const challenge = await seedChallenge(f);
    let attemptedUpdate = false;
    instrument(t, connection => {
      const query = connection.query.bind(connection);
      t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
        const sql = String(args[0]);
        if (sql.includes("UPDATE pet_access_tokens SET consumed_at")) {
          attemptedUpdate = true;
          if (failure === "update") throw new Error("SECRET_UPDATE_SENTINEL");
        }
        if (failure === "insert" && sql.includes("INSERT INTO pet_client_sessions")) throw new Error("SECRET_INSERT_SENTINEL");
        return query(...args).then(result => {
          if (sql.includes("UPDATE pet_access_tokens SET consumed_at")) {
            attemptedUpdate = true;
            if (failure === "zeroUpdate") return [{ ...result[0], affectedRows: 0 }, result[1]];
          }
          return result;
        });
      }) as typeof connection.query);
      if (failure === "commit") t.mock.method(connection, "commit", async () => { throw new Error("SECRET_COMMIT_SENTINEL"); });
    });
    const result = await consume(f.slug, { token: challenge.secret });
    if (failure === "zeroUpdate") rejected(result);
    else {
      assert.equal(result.status, 500);
      const data = objectData(result);
      assert.deepEqual(Object.keys(data), ["code"]);
      assert.ok(data.code === "INTERNAL_SERVER_ERROR");
      assert.equal(result.noStore, true);
    }
    assert.equal(attemptedUpdate, true);
    assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
    const rendered = JSON.stringify(logs);
    assert.ok(!rendered.includes(challenge.secret));
    assert.ok(!rendered.includes("SECRET_INSERT_SENTINEL") && !rendered.includes("SECRET_COMMIT_SENTINEL") &&
      !rendered.includes("SECRET_UPDATE_SENTINEL"));
  });
}

test("PET consume: no devuelve sessionToken mientras COMMIT no finalizo", { timeout: 30000 }, async t => {
  const f = await fixture();
  const challenge = await seedChallenge(f);
  const reachedCommit = deferred();
  const release = deferred();
  let replied = false;
  instrument(t, connection => {
    const commit = connection.commit.bind(connection);
    t.mock.method(connection, "commit", async () => { reachedCommit.resolve(); await release.promise; await commit(); });
  });
  const pending = consume(f.slug, { token: challenge.secret });
  void pending.then(() => { replied = true; }, () => { replied = true; });
  try {
    await watchdog(reachedCommit.promise);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(replied, false);
    assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 }, "otra conexion no ve escrituras sin commit");
  } finally { release.resolve(); await Promise.allSettled([pending]); }
  successful(await pending);
  assert.deepEqual(await counts(f), { sessions: 1, consumed: 1 });
});

for (const lockPoint of ["challenge", "client"] as const) {
test(`PET consume: expiracion esperando ${lockPoint} se revalida tras lock y en UPDATE condicionado`, { timeout: 30000 }, async t => {
  const f = await fixture();
  const challenge = await seedChallenge(f, { expiresIn: 3 });
  const holder = await pool.getConnection();
  const attempted = deferred<number>();
  let pending: Promise<ApiResult> | undefined;
  try {
    await holder.beginTransaction();
    if (lockPoint === "challenge") {
      await holder.query("SELECT id FROM pet_access_tokens WHERE id = ? AND local_id = ? FOR UPDATE", [challenge.id, f.localId]);
    } else {
      await holder.query("SELECT id FROM clientes WHERE id = ? AND local_id = ? FOR UPDATE", [f.clienteId, f.localId]);
    }
    const [valid] = await q<(RowDataPacket & { unexpired: number })[]>(
      "SELECT expires_at > UTC_TIMESTAMP(3) AS unexpired FROM pet_access_tokens WHERE id = ? AND local_id = ?", [challenge.id, f.localId]);
    assert.equal(valid.unexpired, 1, "el challenge sigue vigente antes de iniciar la espera");
    instrument(t, connection => {
      const query = connection.query.bind(connection);
      t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
        const expected = lockPoint === "challenge" ? "SELECT id, cliente_id, purpose, consumed_at" :
          "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE";
        if (String(args[0]).includes(expected)) attempted.resolve(connection.threadId);
        return query(...args);
      }) as typeof connection.query);
    });
    pending = consume(f.slug, { token: challenge.secret });
    await waitForLock(holder.threadId, await watchdog(attempted.promise), lockPoint === "challenge" ? "pet_access_tokens" : "clientes");
    await watchdog((async () => {
      for (;;) {
        const [row] = await q<(RowDataPacket & { expired: number })[]>(
          "SELECT expires_at <= UTC_TIMESTAMP(3) AS expired FROM pet_access_tokens WHERE id = ? AND local_id = ?", [challenge.id, f.localId]);
        if (row.expired === 1) return;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    })());
  } finally {
    try { await holder.rollback(); } finally { holder.release(); }
    if (pending) await Promise.allSettled([pending]);
  }
  assert.ok(pending);
  rejected(await pending);
  assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
});
}

for (const change of ["canonicalNull", "onlineFalse"] as const) {
  test(`PET consume: revalidacion actual bajo locks rechaza ${change} tras lectura anterior`, async t => {
    const f = await fixture();
    const challenge = await seedChallenge(f);
    let changed = false;
    instrument(t, connection => {
      const query = connection.query.bind(connection);
      t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
        return query(...args).then(async result => {
          const point = change === "canonicalNull" ? "SELECT expires_at > UTC_TIMESTAMP(3) AS unexpired" : "SELECT m.id FROM mascota_clientes";
          if (!changed && String(args[0]).includes(point)) {
            changed = true;
            if (change === "canonicalNull") await q("UPDATE clientes SET telefono_normalizado = NULL WHERE id = ? AND local_id = ?", [f.clienteId, f.localId]);
            else await q("UPDATE mascotas SET reserva_online_habilitada = 0 WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
          }
          return result;
        });
      }) as typeof connection.query);
    });
    rejected(await consume(f.slug, { token: challenge.secret }));
    assert.equal(changed, true);
    assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
  });
}

for (const rollbackFirst of [false, true]) {
  test(`PET consume: doble consumo InnoDB ${rollbackFirst ? "con rollback A" : "con commit A"} crea exactamente una sesion`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const challenge = await seedChallenge(f);
    const locked = deferred();
    const release = deferred();
    const secondAttempt = deferred<number>();
    let firstThread = 0;
    let secondAcquired = false;
    instrument(t, connection => {
      const query = connection.query.bind(connection);
      t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
        const sql = String(args[0]);
        if (sql.includes("FROM locales WHERE slug = ? FOR UPDATE")) {
          if (!firstThread) firstThread = connection.threadId;
          else if (connection.threadId !== firstThread) {
            secondAttempt.resolve(connection.threadId);
            return query(...args).then(result => { secondAcquired = true; return result; });
          }
        }
        if (connection.threadId === firstThread && sql.includes("UPDATE pet_access_tokens SET consumed_at")) {
          return query(...args).then(async result => { locked.resolve(); await release.promise; return result; });
        }
        if (rollbackFirst && connection.threadId === firstThread && sql.includes("INSERT INTO pet_client_sessions")) {
          throw new Error("FORCED_ROLLBACK_FIRST_CONSUMER");
        }
        return query(...args);
      }) as typeof connection.query);
    });
    const a = consume(f.slug, { token: challenge.secret });
    let b: Promise<ApiResult> | undefined;
    try {
      await watchdog(locked.promise);
      b = consume(f.slug, { token: challenge.secret });
      await waitForLock(firstThread, await watchdog(secondAttempt.promise), "locales");
      assert.equal(secondAcquired, false);
    } finally {
      release.resolve();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
    assert.ok(b);
    if (rollbackFirst) { assert.equal((await a).status, 500); successful(await b); }
    else { successful(await a); rejected(await b); }
    assert.equal(secondAcquired, true);
    assert.deepEqual(await counts(f), { sessions: 1, consumed: 1 });
  });
}

test("PET consume: tenants distintos con canonical igual confirman independientemente bajo locks", { timeout: 30000 }, async t => {
  const aFixture = await fixture();
  const bFixture = await fixture();
  const aChallenge = await seedChallenge(aFixture);
  const bChallenge = await seedChallenge(bFixture);
  const locked = deferred();
  const release = deferred();
  let firstThread = 0;
  instrument(t, connection => {
    const query = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      if (!firstThread) firstThread = connection.threadId;
      if (connection.threadId === firstThread && String(args[0]).includes("UPDATE pet_access_tokens SET consumed_at")) {
        return query(...args).then(async result => { locked.resolve(); await release.promise; return result; });
      }
      return query(...args);
    }) as typeof connection.query);
  });
  const a = consume(aFixture.slug, { token: aChallenge.secret });
  let b: Promise<ApiResult> | undefined;
  try {
    await watchdog(locked.promise);
    b = consume(bFixture.slug, { token: bChallenge.secret });
    successful(await watchdog(b));
    assert.deepEqual(await counts(aFixture), { sessions: 0, consumed: 0 });
    assert.deepEqual(await counts(bFixture), { sessions: 1, consumed: 1 });
  } finally { release.resolve(); await Promise.allSettled([a, ...(b ? [b] : [])]); }
  successful(await a);
  assert.deepEqual(await counts(aFixture), { sessions: 1, consumed: 1 });
});

for (const first of ["consume", "request"] as const) {
  test(`PET consume/C.2: ${first} primero serializa el otro flujo sin inversion de locks`, { timeout: 30000 }, async t => {
    const f = await fixture();
    const challenge = await seedChallenge(f);
    const locked = deferred();
    const release = deferred();
    const secondAttempt = deferred<number>();
    let firstThread = 0;
    instrument(t, connection => {
      const query = connection.query.bind(connection);
      t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
        const sql = String(args[0]);
        if (sql.includes("FROM locales WHERE slug = ? FOR UPDATE")) {
          if (!firstThread) firstThread = connection.threadId;
          else if (connection.threadId !== firstThread) secondAttempt.resolve(connection.threadId);
        }
        const pauseAt = first === "consume" ? "UPDATE pet_access_tokens SET consumed_at" : "UPDATE pet_access_tokens SET revoked_at";
        if (connection.threadId === firstThread && sql.includes(pauseAt)) {
          return query(...args).then(async result => { locked.resolve(); await release.promise; return result; });
        }
        return query(...args);
      }) as typeof connection.query);
    });
    const issue = () => call(`/api/pet/public/${f.slug}/session/request`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ telefono: "1123452000" }),
    });
    const a = first === "consume" ? consume(f.slug, { token: challenge.secret }) : issue();
    let b: Promise<ApiResult> | undefined;
    try {
      await watchdog(locked.promise);
      b = first === "consume" ? issue() : consume(f.slug, { token: challenge.secret });
      await waitForLock(firstThread, await watchdog(secondAttempt.promise), "locales");
    } finally { release.resolve(); await Promise.allSettled([a, ...(b ? [b] : [])]); }
    assert.ok(b);
    if (first === "consume") { successful(await a); assert.equal((await b).status, 202); }
    else { assert.equal((await a).status, 202); rejected(await b); }
    const [active] = await q<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM pet_access_tokens WHERE local_id = ? AND cliente_id = ?
       AND purpose = 'PET_PUBLIC_LOGIN' AND consumed_at IS NULL AND revoked_at IS NULL`, [f.localId, f.clienteId]);
    assert.equal(Number(active.total), 1);
    assert.deepEqual(await counts(f), first === "consume" ? { sessions: 1, consumed: 1 } : { sessions: 0, consumed: 0 });
    assert.equal(messages.length, 1);
  });
}

test("PET consume: limitador independiente 30/15m IP+slug y 429 sin datos de token", async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) rejected(await consume(f.slug, { token: "invalid" }));
  const limited = await consume(f.slug, { token: generateOpaqueSecret() });
  assert.equal(limited.status, 429);
  assert.equal(limited.noStore, true);
  assert.ok(objectData(limited).error === "Demasiadas solicitudes. Intentá nuevamente más tarde.");
  const other = await fixture();
  rejected(await consume(other.slug, { token: "invalid" }));
  assert.deepEqual(await counts(f), { sessions: 0, consumed: 0 });
});

test("PET consume: limitador IPv6 comparte /56 y distingue otro prefijo", async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) rejected(await consume(f.slug, { token: "invalid" }, { "X-Forwarded-For": "2001:db8:1:ab00::1" }));
  assert.equal((await consume(f.slug, { token: "invalid" }, { "X-Forwarded-For": "2001:db8:1:ab00::2" })).status, 429);
  rejected(await consume(f.slug, { token: "invalid" }, { "X-Forwarded-For": "2001:db8:2:ab00::1" }));
});

test("PET Bearer parser: estricto, duplicados case-insensitive, sin trim ni JWT", () => {
  const secret = generateOpaqueSecret();
  const valid = `Bearer ${secret}`;
  assert.ok(parsePetSessionBearer({ headers: { authorization: valid }, rawHeaders: ["aUtHoRiZaTiOn", valid] }) === secret);
  const invalid: unknown[] = [undefined, "", "Bearer", "Bearer ", `Basic ${secret}`, `bearer ${secret}`,
    ` Bearer ${secret}`, `${valid} `, `${valid}\n`, `Bearer  ${secret}`, `Bearer\t${secret}`,
    `${valid}, ${valid}`, `Bearer ${secret}=`, `Bearer ${Buffer.alloc(32).toString("base64url").slice(0, -1)}B`,
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.firma"];
  for (const authorization of invalid) {
    assert.equal(parsePetSessionBearer({ headers: { authorization: authorization as string },
      rawHeaders: authorization === undefined ? [] : ["Authorization", String(authorization)] }), null);
  }
  assert.equal(parsePetSessionBearer({ headers: { authorization: valid }, rawHeaders: ["Authorization", valid, "AUTHORIZATION", valid] }), null);
});

test("PET Bearer: sesion valida expone solo req.petSession y no usa req.user ni sliding", async () => {
  const f = await fixture();
  const challenge = await seedChallenge(f);
  const issued = successful(await consume(f.slug, { token: challenge.secret }));
  const [stored] = await q<(RowDataPacket & { id: number })[]>(
    "SELECT id FROM pet_client_sessions WHERE local_id = ? AND cliente_id = ?", [f.localId, f.clienteId]);
  for (let i = 0; i < 2; i++) {
    const result = await authenticate(f.slug, `Bearer ${issued.sessionToken}`);
    assert.equal(result.status, 200);
    assert.equal(result.noStore, true);
    const data = objectData(result);
    assert.equal(data.adminUserSet, false);
    assert.ok(JSON.stringify(data.context) === JSON.stringify({ sessionId: stored.id, localId: f.localId, clienteId: f.clienteId }));
  }
  const [unchanged] = await q<(RowDataPacket & { same: number })[]>(
    "SELECT expires_at = STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%fZ') AS same FROM pet_client_sessions WHERE id = ? AND local_id = ?",
    [issued.expiresAt, stored.id, f.localId]);
  assert.equal(unchanged.same, 1);
  assert.equal(logs.length, 0);
});

test("PET Bearer: headers faltantes/malformados/JWT no consultan DB y devuelven 401 comun", async t => {
  const f = await fixture();
  let queries = 0;
  const query = pool.query.bind(pool);
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => { queries++; return query(...args); }) as typeof pool.query);
  const adminJwt = jwt.sign({ userId: 1, localId: f.localId, rol: "admin" }, "PET11C3_FAKE_JWT_TEST_KEY");
  for (const value of [undefined, "Basic SECRET_AUTH_SENTINEL", `Bearer ${adminJwt}`, "Bearer ",
    `Bearer  ${generateOpaqueSecret()}`, "Bearer SECRET_AUTH_SENTINEL"]) {
    rejected(await authenticate(f.slug, value), "PET_SESSION_INVALID");
  }
  assert.equal(queries, 0);
  assert.equal(logs.length, 0);
});

test("PET Bearer: duplicados reales en rawHeaders con distinto casing se rechazan antes de DB", async t => {
  const f = await fixture();
  const session = await seedSession(f);
  let queries = 0;
  const query = pool.query.bind(pool);
  t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => { queries++; return query(...args); }) as typeof pool.query);
  const result = await new Promise<ApiResult>((resolve, reject) => {
    const req = rawHttpRequest({ host: "127.0.0.1", port, path: `/__pet_session_test/${f.slug}`,
      headers: ["Host", "127.0.0.1", "Authorization", `Bearer ${session.secret}`,
        "aUtHoRiZaTiOn", `Bearer ${session.secret}`, "Connection", "close"] }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(body), noStore: res.headers["cache-control"] === "no-store" }); }
        catch { reject(new Error("PET11C3_RESPONSE_NOT_JSON")); }
      });
    });
    req.on("error", reject);
    req.end();
  });
  rejected(result, "PET_SESSION_INVALID");
  assert.equal(queries, 0);
  assert.equal(logs.length, 0);
});

for (const state of ["random", "expired", "revoked", "inactive", "beauty", "missingLocal", "deletedClient"] as const) {
  test(`PET Bearer: ${state} devuelve el mismo 401`, async () => {
    const f = await fixture();
    const session = await seedSession(f, { expiresIn: state === "expired" ? -60 : 43200, revoked: state === "revoked" });
    if (state === "inactive") await q("UPDATE locales SET activo = 0 WHERE id = ?", [f.localId]);
    if (state === "beauty") await q("UPDATE locales SET business_type = 'BEAUTY' WHERE id = ?", [f.localId]);
    if (state === "deletedClient") await q("DELETE FROM clientes WHERE id = ? AND local_id = ?", [f.clienteId, f.localId]);
    rejected(await authenticate(state === "missingLocal" ? `${prefix}-missing` : f.slug,
      `Bearer ${state === "random" ? generateOpaqueSecret() : session.secret}`), "PET_SESSION_INVALID");
    assert.equal(logs.length, 0);
  });
}

test("PET Bearer: mismo canonical en tenants A/B no mezcla sesiones ni contexto", async () => {
  const a = await fixture();
  const b = await fixture();
  const aSession = await seedSession(a);
  const bSession = await seedSession(b);
  rejected(await authenticate(b.slug, `Bearer ${aSession.secret}`), "PET_SESSION_INVALID");
  rejected(await authenticate(a.slug, `Bearer ${bSession.secret}`), "PET_SESSION_INVALID");
  assert.equal((await authenticate(a.slug, `Bearer ${aSession.secret}`)).status, 200);
  assert.equal((await authenticate(b.slug, `Bearer ${bSession.secret}`)).status, 200);
});

test("PET Bearer: fallo interno no imprime Authorization/error/body ni response secrets", async t => {
  const f = await fixture();
  const session = await seedSession(f);
  const failure = Object.assign(new Error(`SECRET_AUTH_SENTINEL ${session.secret}`), {
    body: { token: "SECRET_BODY_SENTINEL" }, response: { sessionToken: "SECRET_RESPONSE_SENTINEL" },
    config: { headers: { Authorization: `Bearer ${session.secret}` } },
  });
  t.mock.method(pool, "query", async () => { throw failure; });
  const result = await authenticate(f.slug, `Bearer ${session.secret}`);
  assert.equal(result.status, 500);
  assert.deepEqual(Object.keys(objectData(result)), ["code"]);
  assert.ok(objectData(result).code === "INTERNAL_SERVER_ERROR");
  const rendered = JSON.stringify(logs);
  for (const value of [session.secret, "SECRET_AUTH_SENTINEL", "SECRET_BODY_SENTINEL", "SECRET_RESPONSE_SENTINEL"]) {
    assert.ok(!rendered.includes(value));
  }
});
