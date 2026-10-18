import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, test, type TestContext } from "node:test";
import express from "express";
import type { PoolConnection, QueryResult, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { sanitizedErrorMiddleware } from "../../../middlewares/sanitizedError.middleware";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { evolutionClient } from "../../notifications/infrastructure/evolution.client";
import { generateOpaqueSecret, hashOpaqueSecret, isCanonicalOpaqueSecret } from "./opaqueSecret";
import { petSessionPublicRouter } from "./session.routes";

const prefix = `pet11c2-${randomUUID()}`;
const fixtureLocals: number[] = [];
let server: Server;
let port: number;
const senderCalls: Array<{ path: string; number: string; message: string }> = [];
let senderBehavior: (call: typeof senderCalls[number]) => Promise<void> = async () => {};
const logs: unknown[][] = [];

// mysql2 errors can embed SQL and hashes. Do not expose them to the test reporter.
async function q<T extends QueryResult = RowDataPacket[]>(sql: string, values: unknown[] = []): Promise<T> {
  try { const [result] = await pool.query<T>(sql, values); return result; }
  catch { throw new Error("PET11C2_FIXTURE_DB_OPERATION_FAILED"); }
}
interface Fixture {
  localId: number; clienteId: number; mascotaId: number | null;
  slug: string; phone: string; canonical: string | null;
}
async function fixture(options: {
  kind?: string; active?: number; canonicalNull?: boolean; pet?: boolean;
  petActive?: number; online?: number; linked?: boolean; phone?: string; display?: string;
} = {}): Promise<Fixture> {
  const slug = `${prefix}-${fixtureLocals.length}-${randomUUID().slice(0, 8)}`;
  const local = await q<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, business_type, activo) VALUES (?, ?, ?, ?)",
    [prefix, slug, options.kind ?? "PET_GROOMING", options.active ?? 1]);
  fixtureLocals.push(local.insertId);
  const phone = options.phone ?? "1123452000";
  const canonical = options.canonicalNull ? null : normalizeClientPhone(phone);
  const client = await q<ResultSetHeader>(
    "INSERT INTO clientes (nombre, local_id, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)",
    [prefix, local.insertId, options.display ?? phone, canonical]);
  let mascotaId: number | null = null;
  if (options.pet !== false) {
    const pet = await q<ResultSetHeader>(
      "INSERT INTO mascotas (local_id, nombre, activo, reserva_online_habilitada) VALUES (?, ?, ?, ?)",
      [local.insertId, prefix, options.petActive ?? 1, options.online ?? 1]);
    mascotaId = pet.insertId;
    if (options.linked !== false) await q(
      "INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
      [local.insertId, mascotaId, client.insertId]);
  }
  return { localId: local.insertId, clienteId: client.insertId, mascotaId, slug, phone, canonical };
}
interface ApiResult { status: number; data: unknown; noStore: boolean }
async function request(slug: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  const response = await fetch(`http://127.0.0.1:${port}/api/pet/public/${encodeURIComponent(slug)}/session/request`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, data: await response.json(), noStore: response.headers.get("cache-control") === "no-store" };
}
function accepted(result: ApiResult): void {
  assert.equal(result.status, 202);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.noStore, true);
}
interface ChallengeRow extends RowDataPacket {
  id: number; token_hash: Buffer; purpose: string; consumed_at: Date | null; revoked_at: Date | null; ttl: number;
}
async function challenges(f: Fixture): Promise<ChallengeRow[]> {
  return q<ChallengeRow[]>(
    `SELECT id, token_hash, purpose, consumed_at, revoked_at,
       TIMESTAMPDIFF(MICROSECOND, created_at, expires_at) AS ttl
     FROM pet_access_tokens WHERE local_id = ? AND cliente_id = ? ORDER BY id`, [f.localId, f.clienteId]);
}
function active(rows: ChallengeRow[]): ChallengeRow[] {
  return rows.filter(row => row.consumed_at === null && row.revoked_at === null);
}
function sentSecret(index = 0): string {
  const match = senderCalls[index]?.message.match(/https?:\/\/[^\s]+/);
  assert.ok(match, "el mensaje contiene enlace");
  const url = new URL(match[0]);
  const secret = new URLSearchParams(url.hash.slice(1)).get("token");
  assert.ok(isCanonicalOpaqueSecret(secret));
  return secret;
}
async function seed(f: Fixture, ageSeconds: number, state: "active" | "consumed" | "revoked" = "active"): Promise<number> {
  const row = await q<ResultSetHeader>(
    `INSERT INTO pet_access_tokens
       (local_id, cliente_id, purpose, token_hash, created_at, expires_at, consumed_at, revoked_at)
     SELECT ?, ?, 'PET_PUBLIC_LOGIN', ?, t.created, DATE_ADD(t.created, INTERVAL 15 MINUTE),
       CASE WHEN ? = 'consumed' THEN DATE_ADD(t.created, INTERVAL 1 SECOND) ELSE NULL END,
       CASE WHEN ? = 'revoked' THEN DATE_ADD(t.created, INTERVAL 1 SECOND) ELSE NULL END
     FROM (SELECT DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND) AS created) t`,
    [f.localId, f.clienteId, hashOpaqueSecret(generateOpaqueSecret()), state, state, ageSeconds]);
  return row.insertId;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function watchdog<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PET11C2_WATCHDOG")), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/pet/public", petSessionPublicRouter);
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
  senderCalls.length = 0;
  logs.length = 0;
  senderBehavior = async () => {};
  for (const method of ["log", "info", "warn", "error"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
  t.mock.method(evolutionClient, "post", async (path: string, data?: unknown) => {
    const payload = data as { number: string; textMessage: { text: string } };
    const call = { path, number: payload.number, message: payload.textMessage.text };
    senderCalls.push(call);
    await senderBehavior(call);
    return { data: {} } as never;
  });
});
afterEach(async () => {
  for (const localId of fixtureLocals.splice(0)) {
    await q("DELETE FROM locales WHERE id = ?", [localId]);
  }
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

test("PET access request: elegible sin servicios persiste solo hash BINARY(32), TTL UTC y envia link", async () => {
  const f = await fixture({ display: "display no es destino" });
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 1);
  assert.equal(active(rows).length, 1);
  assert.ok(Buffer.isBuffer(rows[0].token_hash));
  assert.equal(rows[0].token_hash.length, 32);
  assert.ok(rows[0].token_hash.equals(hashOpaqueSecret(sentSecret())));
  assert.equal(Number(rows[0].ttl), 900_000_000);
  assert.equal(rows[0].purpose, "PET_PUBLIC_LOGIN");
  assert.ok(senderCalls[0].number === f.canonical?.slice(1));
  assert.equal(senderCalls[0].path, `/message/sendText/${f.localId}`);
  const [counts] = await q<(RowDataPacket & { services: number; sessions: number })[]>(
    `SELECT (SELECT COUNT(*) FROM mascota_servicios WHERE local_id = ?) AS services,
            (SELECT COUNT(*) FROM pet_client_sessions WHERE local_id = ?) AS sessions`, [f.localId, f.localId]);
  assert.equal(Number(counts.services), 0);
  assert.equal(Number(counts.sessions), 0);
});

test("PET access request: formato equivalente identifica mismo cliente y comparte cooldown", async () => {
  const f = await fixture();
  accepted(await request(f.slug, { telefono: "+54 11 2345 2000" }));
  accepted(await request(f.slug, { telefono: f.phone }));
  assert.equal((await challenges(f)).length, 1);
  assert.equal(senderCalls.length, 1);
});

for (const [label, options, phone] of [
  ["invalido", {}, "123456"],
  ["inexistente", {}, "1123452001"],
  ["canonical NULL con display igual", { canonicalNull: true }, "1123452000"],
  ["sin mascota", { pet: false }, "1123452000"],
  ["sin vinculo M:N", { linked: false }, "1123452000"],
  ["mascota inactiva", { petActive: 0 }, "1123452000"],
  ["online false", { online: 0 }, "1123452000"],
] as const) {
  test(`PET access request: anti-enumeracion para ${label}`, async () => {
    const f = await fixture(options);
    accepted(await request(f.slug, { telefono: phone }));
    assert.equal((await challenges(f)).length, 0);
    assert.equal(senderCalls.length, 0);
    assert.equal(logs.length, 0);
  });
}

test("PET access request: BEAUTY/inactivo/inexistente mantienen 404 PET antes de validar telefono", async () => {
  const beauty = await fixture({ kind: "BEAUTY" });
  const inactive = await fixture({ active: 0 });
  for (const slug of [beauty.slug, inactive.slug, `${prefix}-missing`]) {
    const result = await request(slug, {});
    assert.equal(result.status, 404);
    assert.deepEqual(result.data, { error: "PET_LOCAL_NOT_FOUND" });
  }
  assert.equal(senderCalls.length, 0);
});

test("PET access request: body exacto rechaza extras, tipos, vacio y longitud excesiva", async () => {
  const f = await fixture();
  const invalid = [{}, { telefono: 123 }, { telefono: null }, { telefono: "" }, { telefono: "   " },
    { telefono: "1".repeat(51) }, { telefono: f.phone, localId: f.localId },
    { telefono: f.phone, clienteId: f.clienteId }, []];
  for (const body of invalid) {
    const result = await request(f.slug, body);
    assert.equal(result.status, 400);
    assert.deepEqual(result.data, { error: "PET_SESSION_REQUEST_INVALID_BODY" });
  }
  assert.equal((await challenges(f)).length, 0);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: segundo request inmediato no revoca ni emite", async () => {
  const f = await fixture();
  accepted(await request(f.slug, { telefono: f.phone }));
  const [first] = await challenges(f);
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].revoked_at, null);
  assert.equal(senderCalls.length, 1);
});

test("PET access request: cooldown cuenta la ultima emision aunque este consumida", async () => {
  const f = await fixture();
  const previous = await seed(f, 45, "consumed");
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, previous);
  assert.ok(rows[0].consumed_at !== null);
  assert.equal(rows[0].revoked_at, null);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: tras cooldown revoca activos y conserva consumidos/revocados", async () => {
  const f = await fixture();
  const previous = await seed(f, 180);
  const consumed = await seed(f, 1800, "consumed");
  const revoked = await seed(f, 3600, "revoked");
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 4);
  assert.ok(rows.find(row => row.id === previous)?.revoked_at !== null);
  assert.equal(rows.find(row => row.id === consumed)?.revoked_at, null);
  assert.ok(rows.find(row => row.id === consumed)?.consumed_at !== null);
  assert.ok(rows.find(row => row.id === revoked)?.revoked_at !== null);
  assert.equal(active(rows).length, 1);
  assert.ok(active(rows)[0].token_hash.equals(hashOpaqueSecret(sentSecret())));
});

test("PET access request: cuota 3/15m incluye consumidos/revocados sin revocar el activo", async () => {
  const f = await fixture();
  await seed(f, 180, "consumed");
  await seed(f, 360, "revoked");
  const previous = await seed(f, 540);
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 3);
  assert.equal(active(rows).length, 1);
  assert.equal(active(rows)[0].id, previous);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: cuota 10/24h incluye historicos y conserva activo aunque este expirado", async () => {
  const f = await fixture();
  const previous = await seed(f, 1800);
  for (let i = 2; i <= 10; i++) await seed(f, i * 1800, i % 2 ? "consumed" : "revoked");
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 10);
  assert.equal(active(rows).length, 1);
  assert.equal(active(rows)[0].id, previous);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: permite tercera emision / decima diaria sin contar fuera de 24h", async () => {
  const f = await fixture();
  await seed(f, 180, "consumed");
  await seed(f, 360, "revoked");
  for (let i = 1; i <= 7; i++) await seed(f, i * 1800, "revoked");
  await seed(f, 25 * 3600, "revoked");
  accepted(await request(f.slug, { telefono: f.phone }));
  assert.equal((await challenges(f)).length, 11);
  assert.equal(active(await challenges(f)).length, 1);
  assert.equal(senderCalls.length, 1);
});

test("PET access request: ineligible no revoca challenge anterior", async () => {
  const f = await fixture({ online: 0 });
  const previous = await seed(f, 180);
  accepted(await request(f.slug, { telefono: f.phone }));
  const rows = await challenges(f);
  assert.equal(rows.length, 1);
  assert.equal(active(rows)[0].id, previous);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: tenants con canonical igual tienen challenge/cuota independientes", async () => {
  const a = await fixture();
  const b = await fixture();
  const oldB = await seed(b, 180);
  accepted(await request(a.slug, { telefono: a.phone }));
  assert.equal(active(await challenges(b))[0].id, oldB);
  accepted(await request(b.slug, { telefono: b.phone }));
  assert.equal(active(await challenges(a)).length, 1);
  assert.equal(active(await challenges(b)).length, 1);
  assert.ok((await challenges(b)).find(row => row.id === oldB)?.revoked_at !== null);
  assert.equal(senderCalls.length, 2);
});

test("PET access request: cliente/mascota de otro local no conceden elegibilidad", async () => {
  const a = await fixture();
  const b = await fixture({ pet: false });
  accepted(await request(b.slug, { telefono: a.phone }));
  assert.equal((await challenges(a)).length, 0);
  assert.equal((await challenges(b)).length, 0);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: FRONTEND_URL invalida produce 500 uniforme sin emitir ni revocar", { timeout: 15000 }, async () => {
  const f = await fixture();
  const previous = await seed(f, 180);
  process.env.FRONTEND_URL = "https://user:SECRET_CONFIG_SENTINEL@frontend.test";
  for (const telefono of [f.phone, "1123452001", "invalid"]) {
    const result = await request(f.slug, { telefono });
    assert.equal(result.status, 500);
    assert.deepEqual(result.data, { code: "INTERNAL_SERVER_ERROR" });
  }
  const rows = await challenges(f);
  assert.equal(rows.length, 1);
  assert.equal(active(rows)[0].id, previous);
  assert.equal(senderCalls.length, 0);
  assert.ok(!JSON.stringify(logs).includes("SECRET_CONFIG_SENTINEL"));
});

test("PET access request: magic link usa solo FRONTEND_URL y E.164 internacional preservado", async () => {
  const f = await fixture({ phone: "+12133734253", display: "display distinto" });
  accepted(await request(f.slug, { telefono: f.phone }, { Host: "untrusted.test", Origin: "https://untrusted.test" }));
  const link = senderCalls[0].message.match(/https?:\/\/[^\s]+/);
  assert.ok(link);
  const url = new URL(link[0]);
  assert.equal(url.origin, "https://pet-frontend.test");
  assert.equal(url.pathname, `/${f.slug}/acceso`);
  assert.equal(url.search, "");
  assert.ok(!senderCalls[0].message.includes("untrusted.test"));
  assert.ok(senderCalls[0].number === f.phone.slice(1));
});

test("PET access request: sender empieza despues del COMMIT visible desde otra conexion", async () => {
  const f = await fixture();
  const visible = deferred<boolean>();
  senderBehavior = async () => {
    const rows = await challenges(f);
    visible.resolve(rows.length === 1 && active(rows).length === 1);
  };
  accepted(await request(f.slug, { telefono: f.phone }));
  assert.equal(await watchdog(visible.promise), true);
});

test("PET access request: no espera Evolution y captura rechazo sin filtrar secretos ni rollback", async () => {
  const f = await fixture();
  const pending = deferred<void>();
  const started = deferred();
  senderBehavior = async () => { started.resolve(); await pending.promise; throw Object.assign(
    new Error(`SECRET_ERROR_SENTINEL ${senderCalls[0].message}`), {
      code: "ERR_BAD_RESPONSE", response: { status: 502, data: { token: "SECRET_RESPONSE_SENTINEL" } },
      config: { headers: { Authorization: "SECRET_AUTH_SENTINEL" } },
    });
  };
  try {
    accepted(await watchdog(request(f.slug, { telefono: f.phone })));
    await watchdog(started.promise);
    assert.equal((await challenges(f)).length, 1);
  } finally { pending.resolve(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await challenges(f)).length, 1);
  const rendered = JSON.stringify(logs);
  for (const value of [f.phone, f.canonical!, sentSecret(), senderCalls[0].message,
    "SECRET_ERROR_SENTINEL", "SECRET_RESPONSE_SENTINEL", "SECRET_AUTH_SENTINEL"]) {
    assert.ok(!rendered.includes(value));
  }
  assert.deepEqual(logs, [["Evolution request failed", {
    provider: "evolution", operation: "sendText", instance: String(f.localId), status: 502, code: "ERR_BAD_RESPONSE",
  }]]);
});

test("PET access request: fallo INSERT revierte revocacion y nunca llama al sender", async t => {
  const f = await fixture();
  const previous = await seed(f, 180);
  const get = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await get();
    const original = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      if (String(args[0]).includes("INSERT INTO pet_access_tokens")) throw new Error("SECRET_SQL_FAILURE_SENTINEL");
      return original(...args);
    }) as typeof connection.query);
    return connection;
  });
  const result = await request(f.slug, { telefono: f.phone });
  assert.equal(result.status, 500);
  assert.deepEqual(result.data, { code: "INTERNAL_SERVER_ERROR" });
  const rows = await challenges(f);
  assert.equal(rows.length, 1);
  assert.equal(active(rows)[0].id, previous);
  assert.equal(senderCalls.length, 0);
  assert.ok(!JSON.stringify(logs).includes("SECRET_SQL_FAILURE_SENTINEL"));
});

test("PET access request: limite IP+slug 10/15m devuelve 429 generico independiente del telefono", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) accepted(await request(f.slug, { telefono: "not a phone" }));
  const limited = await request(f.slug, { telefono: f.phone });
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.data, { error: "Demasiadas solicitudes. Intentá nuevamente más tarde." });
  const other = await fixture();
  accepted(await request(other.slug, { telefono: "not a phone" }));
  assert.equal(senderCalls.length, 0);
});

test("PET access request: IPv6 comparte prefijo /56, conserva independencia de otros prefijos", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) accepted(await request(f.slug, { telefono: "invalid" }, { "X-Forwarded-For": "2001:db8:1:ab00::1" }));
  assert.equal((await request(f.slug, { telefono: "invalid" }, { "X-Forwarded-For": "2001:db8:1:ab00::2" })).status, 429);
  accepted(await request(f.slug, { telefono: "invalid" }, { "X-Forwarded-For": "2001:db8:2:ab00::1" }));
});

function interceptConnection(t: TestContext, intercept: (
  connection: PoolConnection, sql: string, result: Awaited<ReturnType<PoolConnection["query"]>>,
) => Promise<void>) {
  const get = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await get();
    const original = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      return original(...args).then(async result => { await intercept(connection, String(args[0]), result); return result; });
    }) as typeof connection.query);
    return connection;
  });
}

test("PET access request: revalida canonical actual despues del lookup sin fallback display", async t => {
  const f = await fixture();
  let changed = false;
  interceptConnection(t, async (_connection, sql) => {
    if (!changed && sql.startsWith("SELECT id FROM clientes WHERE telefono_normalizado")) {
      changed = true;
      await q("UPDATE clientes SET telefono_normalizado = ? WHERE id = ? AND local_id = ?",
        [normalizeClientPhone("1123452001"), f.clienteId, f.localId]);
    }
  });
  accepted(await request(f.slug, { telefono: f.phone }));
  assert.equal(changed, true);
  assert.equal((await challenges(f)).length, 0);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: revalida flag actual aunque candidato viniera de snapshot anterior", async t => {
  const f = await fixture();
  let changed = false;
  interceptConnection(t, async (_connection, sql) => {
    if (!changed && sql.includes("SELECT m.id FROM mascota_clientes")) {
      changed = true;
      await q("UPDATE mascotas SET reserva_online_habilitada = 0 WHERE id = ? AND local_id = ?", [f.mascotaId, f.localId]);
    }
  });
  accepted(await request(f.slug, { telefono: f.phone }));
  assert.equal(changed, true);
  assert.equal((await challenges(f)).length, 0);
  assert.equal(senderCalls.length, 0);
});

test("PET access request: revalida vinculo M:N actual tras descubrir candidatos", async t => {
  const f = await fixture();
  let changed = false;
  interceptConnection(t, async (_connection, sql) => {
    if (!changed && sql.includes("SELECT m.id FROM mascota_clientes")) {
      changed = true;
      await q("DELETE FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ?",
        [f.mascotaId, f.clienteId, f.localId]);
    }
  });
  accepted(await request(f.slug, { telefono: f.phone }));
  assert.equal(changed, true);
  assert.equal((await challenges(f)).length, 0);
  assert.equal(senderCalls.length, 0);
});

for (const history of [false, true]) {
test(`PET access request: concurrencia InnoDB ${history ? "con historicos" : "sin challenges"} deja maximo un activo`, { timeout: 30000 }, async t => {
  const f = await fixture();
  if (history) {
    await seed(f, 180);
    await seed(f, 1800, "consumed");
    await seed(f, 3600, "revoked");
  }
  const locked = deferred();
  const release = deferred();
  const secondAttempt = deferred<number>();
  let firstThread = 0;
  let secondThread = 0;
  let secondAcquired = false;
  const get = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const connection = await get();
    const original = connection.query.bind(connection);
    t.mock.method(connection, "query", ((...args: Parameters<typeof connection.query>) => {
      const isLocal = String(args[0]).includes("FROM locales WHERE slug = ? FOR UPDATE");
      if (!isLocal) return original(...args);
      if (!firstThread) {
        firstThread = connection.threadId;
        return original(...args).then(async result => { locked.resolve(); await release.promise; return result; });
      }
      secondAttempt.resolve(connection.threadId);
      return original(...args).then(result => { secondAcquired = true; return result; });
    }) as typeof connection.query);
    return connection;
  });
  const a = request(f.slug, { telefono: f.phone });
  let b: Promise<ApiResult> | undefined;
  try {
    await watchdog(locked.promise);
    b = request(f.slug, { telefono: "+54 11 2345 2000" });
    secondThread = await watchdog(secondAttempt.promise);
    await watchdog((async () => {
      for (;;) {
        const [row] = await q<(RowDataPacket & { total: number })[]>(
          `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
           JOIN performance_schema.threads blocker ON blocker.THREAD_ID = w.BLOCKING_THREAD_ID
           JOIN performance_schema.threads requester ON requester.THREAD_ID = w.REQUESTING_THREAD_ID
           JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
           WHERE blocker.PROCESSLIST_ID = ? AND requester.PROCESSLIST_ID = ?
             AND requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = 'locales'`,
          [firstThread, secondThread]);
        if (Number(row.total)) return;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })());
    assert.equal(secondAcquired, false);
  } finally {
    release.resolve();
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
  accepted(await a);
  assert.ok(b);
  accepted(await b);
  assert.equal(secondAcquired, true);
  const rows = await challenges(f);
  assert.equal(rows.length, history ? 4 : 1);
  assert.equal(active(rows).length, 1, "activo = consumed_at IS NULL AND revoked_at IS NULL");
  assert.equal(senderCalls.length, 1);
  const [waits] = await q<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w
     JOIN performance_schema.threads requester ON requester.THREAD_ID = w.REQUESTING_THREAD_ID
     WHERE requester.PROCESSLIST_ID IN (?, ?)`, [firstThread, secondThread]);
  assert.equal(Number(waits.total), 0);
});
}

test("PET access request: tenants concurrentes con mismo canonical no esperan el lock del otro local", { timeout: 30000 }, async t => {
  const aFixture = await fixture();
  const bFixture = await fixture();
  const locked = deferred();
  const release = deferred();
  interceptConnection(t, async (_connection, sql, result) => {
    if (sql.includes("FROM locales WHERE slug = ? FOR UPDATE") &&
        (result[0] as RowDataPacket[])[0]?.id === aFixture.localId) {
      locked.resolve();
      await release.promise;
    }
  });
  const a = request(aFixture.slug, { telefono: aFixture.phone });
  let b: Promise<ApiResult> | undefined;
  try {
    await watchdog(locked.promise);
    b = request(bFixture.slug, { telefono: bFixture.phone });
    accepted(await watchdog(b));
    assert.equal((await challenges(bFixture)).length, 1);
    assert.equal((await challenges(aFixture)).length, 0);
  } finally {
    release.resolve();
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
  accepted(await a);
  assert.equal(active(await challenges(aFixture)).length, 1);
  assert.equal(active(await challenges(bFixture)).length, 1);
  assert.equal(senderCalls.length, 2);
});
