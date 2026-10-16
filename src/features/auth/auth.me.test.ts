import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import Module from "node:module";
import type { ResultSetHeader } from "mysql2/promise";
import { pool } from "../../config/db";

const secret = "AUTH_ME_BUSINESS_TYPE_FIXTURE_SECRET";
const emailServicePath = require.resolve("../../shared/services/email.service");
const originalEmailServiceModule = require.cache[emailServicePath];
let beautyLocalId = 0;
let petLocalId = 0;
let invalidTypeLocalId = 0;
let deletedLocalId = 0;
let port: number;
let server: Server;
let authRouter: typeof import("./auth.routes").AuthRouter;
const dotenvPath = require.resolve("dotenv");
const originalDotenvModule = require.cache[dotenvPath];

async function crearLocal(nombre: string, businessType: string): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)",
    [nombre, randomUUID(), businessType],
  );
  return result.insertId;
}

function token(localId: number | null, businessTypeClaim?: string): string {
  return jwt.sign({
    userId: 999,
    localId,
    rol: localId === null ? "superadmin" : "admin",
    nombreLocal: localId === null ? null : "Nombre del token",
    telefono: localId === null ? null : "teléfono del token",
    ...(businessTypeClaim ? { businessType: businessTypeClaim } : {}),
  }, secret, { expiresIn: "1m" });
}

async function getMe(jwtToken?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: "/api/auth/me",
      headers: jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {},
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) as Record<string, unknown> }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  beautyLocalId = await crearLocal("Auth me BEAUTY fixture", "BEAUTY");
  petLocalId = await crearLocal("Auth me PET fixture", "PET_GROOMING");
  invalidTypeLocalId = await crearLocal("Auth me invalid fixture", "INVALID_FIXTURE_TYPE");

  // auth.controller has a legacy dotenv.config() import side effect. Tests must not load .env.
  const dotenvStub = new Module(dotenvPath);
  dotenvStub.filename = dotenvPath;
  dotenvStub.loaded = true;
  dotenvStub.exports = { config: () => ({ parsed: {} }) };
  require.cache[dotenvPath] = dotenvStub;
  const emailServiceStub = new Module(emailServicePath);
  emailServiceStub.filename = emailServicePath;
  emailServiceStub.loaded = true;
  emailServiceStub.exports = {
    emailService: { enviarEmailRecuperacion: async () => ({ success: true }) },
  };
  require.cache[emailServicePath] = emailServiceStub;
  const authRoutesPath = require.resolve("./auth.routes");
  delete require.cache[authRoutesPath];
  authRouter = (require("./auth.routes") as typeof import("./auth.routes")).AuthRouter;

  const app = express();
  app.use("/api/auth", authRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});

beforeEach(async t => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: secret });
  await pool.query("UPDATE locales SET business_type = 'BEAUTY' WHERE id = ?", [beautyLocalId]);
  await pool.query("UPDATE locales SET business_type = 'PET_GROOMING' WHERE id = ?", [petLocalId]);
  await pool.query("UPDATE locales SET business_type = 'INVALID_FIXTURE_TYPE' WHERE id = ?", [invalidTypeLocalId]);
});

after(async () => {
  const errors: unknown[] = [];
  try {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { errors.push(error); }
  try {
    await pool.query("DELETE FROM locales WHERE id IN (?, ?, ?, ?)", [beautyLocalId, petLocalId, invalidTypeLocalId, deletedLocalId]);
  } catch (error) { errors.push(error); }
  try { await pool.end(); } catch (error) { errors.push(error); }
  if (originalDotenvModule) require.cache[dotenvPath] = originalDotenvModule;
  else delete require.cache[dotenvPath];
  if (originalEmailServiceModule) require.cache[emailServicePath] = originalEmailServiceModule;
  else delete require.cache[emailServicePath];
  assert.deepEqual(errors, [], "Fixtures de /api/auth/me deben limpiarse");
});

test("sin autenticación responde 401", async () => {
  assert.equal((await getMe()).status, 401);
});

test("/auth/me conserva campos existentes y agrega businessType BEAUTY", async () => {
  const result = await getMe(token(beautyLocalId));
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    status: "Ok",
    nombreLocal: "Nombre del token",
    telefono: "teléfono del token",
    localId: beautyLocalId,
    businessType: "BEAUTY",
  });
});

test("/auth/me devuelve businessType PET_GROOMING desde la fila del local", async () => {
  const result = await getMe(token(petLocalId));
  assert.equal(result.status, 200);
  assert.equal(result.data.businessType, "PET_GROOMING");
  assert.equal(result.data.localId, petLocalId);
});

test("sin local responde businessType null sin consultar ni inventar un tipo", async () => {
  const result = await getMe(token(null));
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    status: "Ok",
    nombreLocal: null,
    telefono: null,
    localId: null,
    businessType: null,
  });
});

test("local inexistente devuelve error explícito sin default BEAUTY", async () => {
  const missingLocalId = await crearLocal("Auth me deleted fixture", "BEAUTY");
  deletedLocalId = missingLocalId;
  await pool.query("DELETE FROM locales WHERE id = ?", [missingLocalId]);
  const result = await getMe(token(missingLocalId));
  assert.equal(result.status, 404);
  assert.equal(result.data.code, "LOCAL_NOT_FOUND");
  assert.equal("businessType" in result.data, false);
});

test("business_type inválido responde error de integridad sin divulgar ni convertir el valor", async () => {
  const result = await getMe(token(invalidTypeLocalId));
  assert.equal(result.status, 500);
  assert.equal(result.data.code, "LOCAL_BUSINESS_TYPE_INVALID");
  assert.equal(JSON.stringify(result.data).includes("INVALID_FIXTURE_TYPE"), false);
  assert.equal("businessType" in result.data, false);
});

test("un claim businessType no reemplaza la fuente DB", async () => {
  const result = await getMe(token(beautyLocalId, "PET_GROOMING"));
  assert.equal(result.status, 200);
  assert.equal(result.data.businessType, "BEAUTY");
});

test("el mismo JWT recibe el businessType actual tras cambiarlo en la fila del local", async () => {
  const sameToken = token(beautyLocalId);
  const first = await getMe(sameToken);
  assert.equal(first.data.businessType, "BEAUTY");
  await pool.query("UPDATE locales SET business_type = 'PET_GROOMING' WHERE id = ?", [beautyLocalId]);
  const second = await getMe(sameToken);
  assert.equal(second.status, 200);
  assert.equal(second.data.businessType, "PET_GROOMING");
  assert.equal(second.data.localId, beautyLocalId);
});
