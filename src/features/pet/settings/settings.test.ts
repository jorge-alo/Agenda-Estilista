import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { before, beforeEach, after, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import router from "../pet.routes";
import type { PetSettings } from "./settings.types";

const secret = "PET06_HIGH_DEMAND_FICTICIO_SOLO_TEST";
const locales: number[] = [];
const base = "/api/pet/admin/settings";
const minGap = { highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null };
const maxPerDay = { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 1 };
let server: Server;
let port: number;

async function http(method: string, body?: unknown, localId: number | null = locales[0], path = base, rol = "admin") {
  const token = localId === null ? undefined : jwt.sign({ userId: 1, rol, localId }, secret, { expiresIn: "1m" });
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function json(result: { body: string }): PetSettings {
  return JSON.parse(result.body) as PetSettings;
}

before(async () => {
  for (const business of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    const [result] = await pool.query<ResultSetHeader>("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)", ["Fixture PET06 settings", randomUUID(), business]);
    locales.push(result.insertId);
  }
  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  for (const id of locales) await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [id]);
});

after(async () => {
  const errors: unknown[] = [];
  try { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  catch (error) { errors.push(error); }
  try {
    for (const id of locales) {
      try {
        await pool.query("DELETE FROM locales WHERE id = ?", [id]);
        const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id FROM pet_settings WHERE local_id = ?", [id]);
        assert.equal(rows.length, 0);
      } catch (error) { errors.push(error); }
    }
  } finally { await pool.end(); }
  assert.equal(errors.length, 0, "Fixtures settings deben limpiarse");
});

for (const [label, tenant, status] of [["sin auth", null, 401], ["BEAUTY", 2, 403]] as const) {
  test(`${label} bloqueado en GET y PUT settings`, async () => {
    const target = tenant === null ? null : locales[tenant];
    assert.equal((await http("GET", undefined, target)).status, status);
    assert.equal((await http("PUT", minGap, target)).status, status);
  });
}

for (const rol of ["estilista", "superadmin"]) {
  test(`M.4B PET ${rol}: GET/PUT settings devuelven 403 sin reemplazar configuración`, async () => {
    const inicial = await http("PUT", minGap);
    assert.equal(inicial.status, 200);
    for (const [method, body] of [["GET", undefined], ["PUT", maxPerDay]] as const) {
      const result = await http(method, body, locales[0], base, rol);
      assert.equal(result.status, 403, `${method} ${base}`);
      assert.deepEqual(JSON.parse(result.body), { error: "Acceso denegado" });
    }
    const result = await http("GET");
    assert.equal(result.status, 200);
    assert.deepEqual(json(result), json(inicial));
  });
}

test("GET sin fila devuelve configured=false y nulls (no 404)", async () => {
  const result = await http("GET");
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { configured: false, highDemandRule: null, highDemandGapMinutes: null, highDemandMaxPerDay: null });
});

test("PUT crea MIN_GAP y GET lo refleja", async () => {
  const put = await http("PUT", minGap);
  assert.equal(put.status, 200);
  assert.deepEqual(json(put), { configured: true, highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null });
  assert.deepEqual(json(await http("GET")), json(put));
});

test("PUT crea MAX_PER_DAY y GET lo refleja", async () => {
  const put = await http("PUT", maxPerDay);
  assert.equal(put.status, 200);
  assert.deepEqual(json(put), { configured: true, highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 1 });
  assert.deepEqual(json(await http("GET")), json(put));
});

test("PUT reemplaza MIN_GAP por MAX_PER_DAY sobre la misma fila", async () => {
  await http("PUT", minGap);
  const put = await http("PUT", maxPerDay);
  assert.deepEqual(json(put), { configured: true, highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 1 });
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day FROM pet_settings WHERE local_id = ?", [locales[0]]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].high_demand_rule, "MAX_PER_DAY");
  assert.equal(rows[0].high_demand_gap_minutes, null);
});

test("PUT reemplaza MAX_PER_DAY por MIN_GAP sobre la misma fila", async () => {
  await http("PUT", maxPerDay);
  const put = await http("PUT", minGap);
  assert.deepEqual(json(put), { configured: true, highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null });
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day FROM pet_settings WHERE local_id = ?", [locales[0]]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].high_demand_rule, "MIN_GAP");
  assert.equal(rows[0].high_demand_max_per_day, null);
});

test("repetir el mismo PUT es idempotente y deja una sola fila", async () => {
  const first = json(await http("PUT", maxPerDay));
  const second = json(await http("PUT", maxPerDay));
  assert.deepEqual(second, first);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id FROM pet_settings WHERE local_id = ?", [locales[0]]);
  assert.equal(rows.length, 1);
});

test("dos tenants mantienen configuraciones independientes", async () => {
  await http("PUT", minGap, locales[0]);
  await http("PUT", maxPerDay, locales[1]);
  assert.deepEqual(json(await http("GET", undefined, locales[0])), { configured: true, highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null });
  assert.deepEqual(json(await http("GET", undefined, locales[1])), { configured: true, highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 1 });
  const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id FROM pet_settings WHERE local_id IN (?, ?) ORDER BY local_id", [locales[0], locales[1]]);
  assert.equal(rows.length, 2);
});

test("el tenant sale del JWT: query con local_id ajeno no lo altera", async () => {
  await http("PUT", minGap, locales[1]);
  const result = await http("GET", undefined, locales[1], `${base}?local_id=${locales[0]}`);
  assert.equal(result.status, 200);
  assert.deepEqual(json(result), { configured: true, highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null });
  assert.equal(json(await http("GET", undefined, locales[0])).configured, false);
});

const invalidos: Array<[string, unknown]> = [
  ["regla desconocida", { highDemandRule: "OTRA", highDemandGapMinutes: 300, highDemandMaxPerDay: null }],
  ["regla no string", { highDemandRule: 1, highDemandGapMinutes: 300, highDemandMaxPerDay: null }],
  ["gap 0", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 0, highDemandMaxPerDay: null }],
  ["gap negativo", { highDemandRule: "MIN_GAP", highDemandGapMinutes: -1, highDemandMaxPerDay: null }],
  ["gap decimal", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 1.5, highDemandMaxPerDay: null }],
  ["gap string", { highDemandRule: "MIN_GAP", highDemandGapMinutes: "300", highDemandMaxPerDay: null }],
  ["gap boolean", { highDemandRule: "MIN_GAP", highDemandGapMinutes: true, highDemandMaxPerDay: null }],
  ["gap objeto", { highDemandRule: "MIN_GAP", highDemandGapMinutes: {}, highDemandMaxPerDay: null }],
  ["gap array", { highDemandRule: "MIN_GAP", highDemandGapMinutes: [1], highDemandMaxPerDay: null }],
  ["gap fuera de rango INT", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 2147483648, highDemandMaxPerDay: null }],
  ["max 0", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 0 }],
  ["max 2", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 2 }],
  ["max negativo", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: -2 }],
  ["max decimal", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: 2.5 }],
  ["max string", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: "2" }],
  ["max boolean", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: false }],
  ["ambos parametros cargados (MIN_GAP)", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: 2 }],
  ["ambos parametros cargados (MAX_PER_DAY)", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: 30, highDemandMaxPerDay: 2 }],
  ["ambos null (MIN_GAP)", { highDemandRule: "MIN_GAP", highDemandGapMinutes: null, highDemandMaxPerDay: null }],
  ["ambos null (MAX_PER_DAY)", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: null, highDemandMaxPerDay: null }],
  ["combinacion incorrecta: MIN_GAP sin gap", { highDemandRule: "MIN_GAP", highDemandGapMinutes: null, highDemandMaxPerDay: 2 }],
  ["combinacion incorrecta: MAX_PER_DAY sin max", { highDemandRule: "MAX_PER_DAY", highDemandGapMinutes: 30, highDemandMaxPerDay: null }],
  ["campo faltante", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 300 }],
  ["campo extra", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null, extra: 1 }],
  ["local_id en body", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null, local_id: 1 }],
  ["localId en body", { highDemandRule: "MIN_GAP", highDemandGapMinutes: 300, highDemandMaxPerDay: null, localId: 1 }],
];

for (const [label, body] of invalidos) {
  test(`PUT inválido 400: ${label}`, async () => {
    const result = await http("PUT", body);
    assert.equal(result.status, 400, result.body);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id FROM pet_settings WHERE local_id = ?", [locales[0]]);
    assert.equal(rows.length, 0, "Un PUT inválido no debe persistir nada");
  });
}

test("PUT con payload no objeto: 400", async () => {
  for (const body of [null, [], "x", 5, true]) {
    assert.equal((await http("PUT", body)).status, 400);
  }
  const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id FROM pet_settings WHERE local_id = ?", [locales[0]]);
  assert.equal(rows.length, 0);
});

test("MySQL CHECK, FK y CASCADE en pet_settings", async () => {
  await assert.rejects(
    pool.query("INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes) VALUES (?, 'OTRA', 300)", [locales[0]]),
    { code: "ER_CHECK_CONSTRAINT_VIOLATED" }
  );
  await assert.rejects(
    pool.query("INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day) VALUES (?, 'MIN_GAP', 300, 2)", [locales[0]]),
    { code: "ER_CHECK_CONSTRAINT_VIOLATED" }
  );
  await assert.rejects(
    pool.query("INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes) VALUES (2147483647, 'MIN_GAP', 300)"),
    { code: "ER_NO_REFERENCED_ROW_2" }
  );
  const [tmp] = await pool.query<ResultSetHeader>("INSERT INTO locales (nombre, slug, business_type) VALUES ('tmp settings', ?, 'PET_GROOMING')", [randomUUID()]);
  const tmpId = tmp.insertId;
  await pool.query("INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes) VALUES (?, 'MIN_GAP', 300)", [tmpId]);
  await assert.rejects(
    pool.query("INSERT INTO pet_settings (local_id, high_demand_rule, high_demand_gap_minutes) VALUES (?, 'MIN_GAP', 300)", [tmpId]),
    { code: "ER_DUP_ENTRY" }
  );
  await pool.query("DELETE FROM locales WHERE id = ?", [tmpId]);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT local_id FROM pet_settings WHERE local_id = ?", [tmpId]);
  assert.equal(rows.length, 0);
});
