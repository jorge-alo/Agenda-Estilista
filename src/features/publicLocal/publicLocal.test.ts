import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import type { ResultSetHeader } from "mysql2/promise";
import { pool } from "../../config/db";
import publicLocalRouter from "./publicLocal.routes";

const prefix = `public-local-${randomUUID()}`;
const fixtureIds: number[] = [];
const fixtureSlugs = {
  beauty: `${prefix}-beauty`,
  pet: `${prefix}-pet`,
  inactive: `${prefix}-inactive`,
  invalidType: `${prefix}-invalid`,
};
let server: Server;
let port: number;

async function crearLocal(slug: string, businessType: string, activo = 1): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, business_type, activo, telefono) VALUES (?, ?, ?, ?, ?)",
    [`${prefix} ${businessType}`, slug, businessType, activo, "no exponer teléfono"],
  );
  fixtureIds.push(result.insertId);
  return result.insertId;
}

async function getContext(path: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

before(async () => {
  await crearLocal(fixtureSlugs.beauty, "BEAUTY");
  await crearLocal(fixtureSlugs.pet, "PET_GROOMING");
  await crearLocal(fixtureSlugs.inactive, "PET_GROOMING", 0);
  await crearLocal(fixtureSlugs.invalidType, "INVALID_FIXTURE_TYPE");

  const app = express();
  app.use("/api/public/local", publicLocalRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

after(async () => {
  const errors: unknown[] = [];
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { errors.push(error); }
  try {
    if (fixtureIds.length) await pool.query("DELETE FROM locales WHERE id IN (?)", [fixtureIds]);
  } catch (error) { errors.push(error); }
  try { await pool.end(); } catch (error) { errors.push(error); }
  assert.deepEqual(errors, [], "Fixtures de contexto público deben limpiarse");
});

test("local activo BEAUTY devuelve nombre y businessType", async () => {
  const result = await getContext(`/api/public/local/${fixtureSlugs.beauty}`);
  assert.deepEqual(result, {
    status: 200,
    data: { nombre: `${prefix} BEAUTY`, businessType: "BEAUTY" },
  });
});

test("local activo PET devuelve nombre y businessType", async () => {
  const result = await getContext(`/api/public/local/${fixtureSlugs.pet}`);
  assert.deepEqual(result, {
    status: 200,
    data: { nombre: `${prefix} PET_GROOMING`, businessType: "PET_GROOMING" },
  });
});

test("slug inexistente e inactivo comparten el mismo 404 genérico", async () => {
  const missing = await getContext(`/api/public/local/${prefix}-missing`);
  const inactive = await getContext(`/api/public/local/${fixtureSlugs.inactive}`);
  assert.deepEqual(missing, { status: 404, data: { code: "LOCAL_NOT_FOUND" } });
  assert.deepEqual(inactive, missing);
});

test("business_type inválido devuelve error interno estable sin fallback ni valor corrupto", async () => {
  const result = await getContext(`/api/public/local/${fixtureSlugs.invalidType}`);
  assert.deepEqual(result, { status: 500, data: { code: "LOCAL_BUSINESS_TYPE_INVALID" } });
  assert.equal(JSON.stringify(result.data).includes("INVALID_FIXTURE_TYPE"), false);
});

test("la respuesta solo contiene nombre y businessType; parámetros falsificados no alteran el origen", async () => {
  const result = await getContext(`/api/public/local/${fixtureSlugs.beauty}?localId=999&businessType=PET_GROOMING`);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data).sort(), ["businessType", "nombre"]);
  assert.deepEqual(result.data, { nombre: `${prefix} BEAUTY`, businessType: "BEAUTY" });
});

test("slug no resoluble o mayor que la columna se oculta como no encontrado", async () => {
  assert.deepEqual(await getContext("/api/public/local/%20"), { status: 404, data: { code: "LOCAL_NOT_FOUND" } });
  assert.deepEqual(await getContext(`/api/public/local/${"x".repeat(101)}`), { status: 404, data: { code: "LOCAL_NOT_FOUND" } });
});
