import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import Module from "node:module";
import { after, before, beforeEach, test, describe } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { clientPhoneDuplicateKey } from "../../../shared/phone/clientPhoneDuplicate";

const JWT_TEST_SECRET = "SECRETO_JWT_FICTICIO_PET02_SOLO_TESTS";
const fixtureSuffix = randomUUID();

let petLocalId: number;
let otherPetLocalId: number;
let beautyLocalId: number;

let petRouter: any;
let server: Server;
let port: number;

const originalDbModule = require.cache[require.resolve("../../../config/db")];

function petAdminToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ userId: 1, rol: "admin", localId: petLocalId, ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

function otherPetAdminToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ userId: 2, rol: "admin", localId: otherPetLocalId, ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

function beautyAdminToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ userId: 3, rol: "admin", localId: beautyLocalId, ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

function superAdminToken(payload: Record<string, unknown> = {}): string {
  return jwt.sign({ userId: 4, rol: "superadmin", ...payload }, JWT_TEST_SECRET, { expiresIn: "1m" });
}

async function httpRequest(
  method: string,
  path: string,
  token?: string,
  body?: unknown
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

const routesPath = require.resolve("../pet.routes");
const controllerPath = require.resolve("./mascotas.controller");
const servicePath = require.resolve("./mascotas.service");

before(async () => {
  delete require.cache[routesPath];
  delete require.cache[controllerPath];
  delete require.cache[servicePath];

  const { default: router } = require("../pet.routes") as typeof import("../pet.routes");
  petRouter = router;

  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", petRouter);
  const serverInstance = app.listen(0, "127.0.0.1");
  await once(serverInstance, "listening");
  const address = serverInstance.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  server = serverInstance;

  // Crear 3 locales de prueba reales en MySQL Docker
  const [petResult]: any = await pool.query(
    `INSERT INTO locales (nombre, slug, telefono, business_type, suscripcion_estado, suscripcion_vencimiento)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 30 DAY))`,
    ["PET Test Local", `pet-test-${fixtureSuffix}`, "1111111111", "PET_GROOMING", "activo"]
  );
  petLocalId = petResult.insertId;

  const [otherPetResult]: any = await pool.query(
    `INSERT INTO locales (nombre, slug, telefono, business_type, suscripcion_estado, suscripcion_vencimiento)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 30 DAY))`,
    ["Other PET Test Local", `other-pet-test-${fixtureSuffix}`, "3333333333", "PET_GROOMING", "activo"]
  );
  otherPetLocalId = otherPetResult.insertId;

  const [beautyResult]: any = await pool.query(
    `INSERT INTO locales (nombre, slug, telefono, business_type, suscripcion_estado, suscripcion_vencimiento)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 30 DAY))`,
    ["Beauty Test Local", `beauty-test-${fixtureSuffix}`, "2222222222", "BEAUTY", "activo"]
  );
  beautyLocalId = beautyResult.insertId;

  assert.ok(petLocalId > 0, "PET test local debe crearse");
  assert.ok(otherPetLocalId > 0, "Other PET test local debe crearse");
  assert.ok(beautyLocalId > 0, "BEAUTY test local debe crearse");
  assert.notEqual(petLocalId, otherPetLocalId, "Locales PET deben tener IDs distintos");
  assert.notEqual(petLocalId, beautyLocalId, "Locales deben tener IDs distintos");
});

beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", { JWT_SECRET: JWT_TEST_SECRET });
});

after(async () => {
  const errors: unknown[] = [];
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      // CASCADE limpia mascotas y relaciones; intentar todos los fixtures.
      for (const localId of [petLocalId, otherPetLocalId, beautyLocalId]) {
        if (localId) {
          try {
            await pool.query("DELETE FROM locales WHERE id = ?", [localId]);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } finally {
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      } finally {
        if (originalDbModule) {
          require.cache[require.resolve("../../../config/db")] = originalDbModule;
        } else {
          delete require.cache[require.resolve("../../../config/db")];
        }
        delete require.cache[routesPath];
        delete require.cache[controllerPath];
        delete require.cache[servicePath];
      }
    }
  }
  if (errors.length > 0) {
    throw Object.assign(new Error("Falló el teardown PET"), { errors });
  }
});

describe("PET-02B Vertical - Protección PET_GROOMING", () => {
  test("PET_GROOMING local puede acceder a rutas PET", async () => {
    const result = await httpRequest("GET", "/api/pet/admin/mascotas", petAdminToken());
    assert.equal(result.statusCode, 200);
  });

  test("BEAUTY local recibe 403 en rutas PET", async () => {
    const result = await httpRequest("GET", "/api/pet/admin/mascotas", beautyAdminToken());
    assert.equal(result.statusCode, 403);
    assert.ok(JSON.parse(result.body).error.includes("PET_GROOMING"));
  });

  test("Sin autenticación devuelve 401", async () => {
    const result = await httpRequest("GET", "/api/pet/admin/mascotas");
    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: "No autorizado" });
  });
});

describe("PET-02B Mascotas - CRUD", () => {
  test("Crear mascota mínima con nombre", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Firulais" });
    assert.equal(result.statusCode, 201);
    const mascota = JSON.parse(result.body);
    assert.equal(mascota.nombre, "Firulais");
    assert.equal(mascota.alta_exigencia, 0);
    assert.equal(mascota.reserva_online_habilitada, 0);
    assert.equal(mascota.activo, 1);
    assert.ok(mascota.id > 0);
    assert.equal(mascota.local_id, petLocalId);
  });

  test("Crear mascota con todos los campos", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), {
      nombre: "Rex",
      raza: "Labrador",
      fecha_nacimiento: "2020-05-15",
      sexo: "Macho",
      tamano: "Grande",
      tipo_pelo: "Corto",
      observaciones: "Muy bueno",
    });
    assert.equal(result.statusCode, 201);
    const mascota = JSON.parse(result.body);
    assert.equal(mascota.raza, "Labrador");
    assert.equal(mascota.fecha_nacimiento, "2020-05-15");
    assert.equal(mascota.sexo, "Macho");
    assert.equal(mascota.tamano, "Grande");
    assert.equal(mascota.tipo_pelo, "Corto");
    assert.equal(mascota.observaciones, "Muy bueno");
  });

  test("Rechazar nombre vacío", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "   " });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.body).error.includes("nombre"));
  });

  test("Rechazar nombre ausente", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), {});
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.body).error.includes("nombre"));
  });

  test("No aceptar local_id del body", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), {
      nombre: "Test",
      local_id: 12345,
    });
    assert.equal(result.statusCode, 201);
    const mascota = JSON.parse(result.body);
    assert.equal(mascota.local_id, petLocalId);
  });

  test("No aceptar alta_exigencia del body", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), {
      nombre: "Test",
      alta_exigencia: true,
    });
    assert.equal(result.statusCode, 201);
    const mascota = JSON.parse(result.body);
    assert.equal(mascota.alta_exigencia, 0);
  });

  test("No aceptar reserva_online_habilitada del body", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), {
      nombre: "Test",
      reserva_online_habilitada: true,
    });
    assert.equal(result.statusCode, 201);
    const mascota = JSON.parse(result.body);
    assert.equal(mascota.reserva_online_habilitada, 0);
  });

  test("Listar mascotas del tenant", async () => {
    await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Lista 1" });
    await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Lista 2" });
    const result = await httpRequest("GET", "/api/pet/admin/mascotas", petAdminToken());
    assert.equal(result.statusCode, 200);
    const mascotas = JSON.parse(result.body);
    assert.ok(Array.isArray(mascotas));
    assert.ok(mascotas.length >= 2);
    mascotas.forEach((m: any) => assert.equal(m.local_id, petLocalId));
  });

  test("Detalle de mascota propia", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Detalle Test" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken());
    assert.equal(result.statusCode, 200);
    const detalle = JSON.parse(result.body);
    assert.equal(detalle.id, mascota.id);
    assert.equal(detalle.nombre, "Detalle Test");
    assert.ok(Array.isArray(detalle.responsables));
  });

  test("Mascota de otro local no accesible", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", otherPetAdminToken(), { nombre: "Otro Local" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken());
    assert.equal(result.statusCode, 404);
    assert.deepEqual(JSON.parse(result.body), { error: "Mascota no encontrada" });
  });

  test("Editar datos básicos de mascota", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Original" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), {
      nombre: "Editado",
      raza: "Poodle",
      activo: false,
    });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.nombre, "Editado");
    assert.equal(editada.raza, "Poodle");
    assert.equal(editada.activo, 0);
  });

  test("No permitir cambiar local_id", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Test" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), {
      local_id: 99999,
    });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.local_id, petLocalId);
  });

  test("No permitir cambiar alta_exigencia", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Test" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), {
      alta_exigencia: true,
    });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.alta_exigencia, 0);
  });

  test("No permitir cambiar reserva_online_habilitada", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Test" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), {
      reserva_online_habilitada: true,
    });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.reserva_online_habilitada, 0);
  });

  test("Baja lógica con activo=false", async () => {
    const createResult = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Inactivar" });
    const mascota = JSON.parse(createResult.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { activo: false });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.activo, 0);
  });

  test("Editar mascota inexistente devuelve 404", async () => {
    const result = await httpRequest("PATCH", "/api/pet/admin/mascotas/999999", petAdminToken(), { nombre: "Test" });
    assert.equal(result.statusCode, 404);
  });
});

describe("PET-06B Mascotas - alta_exigencia vía PATCH", () => {
  test("POST con altaExigencia no lo habilita: nace en false", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Nueva Alta", altaExigencia: true });
    assert.equal(result.statusCode, 201);
    const mascota = JSON.parse(result.body);
    assert.equal(mascota.alta_exigencia, 0);
  });

  test("PATCH false -> true actualiza y persiste en el detalle", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Toggle On" });
    const mascota = JSON.parse(create.body);
    assert.equal(mascota.alta_exigencia, 0);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: true });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).alta_exigencia, 1);
    const detalle = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken())).body);
    assert.equal(detalle.alta_exigencia, 1);
  });

  test("PATCH true -> false actualiza y persiste en el detalle", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Toggle Off" });
    const mascota = JSON.parse(create.body);
    assert.equal((await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: true })).statusCode, 200);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: false });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).alta_exigencia, 0);
    const detalle = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken())).body);
    assert.equal(detalle.alta_exigencia, 0);
  });

  test("PATCH combina nombre y altaExigencia sin regresión", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Original" });
    const mascota = JSON.parse(create.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { nombre: "Rocky", altaExigencia: true });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.nombre, "Rocky");
    assert.equal(editada.alta_exigencia, 1);
  });

  test("PATCH altaExigencia=true es válido sin fila pet_settings", async () => {
    await pool.query("DELETE FROM pet_settings WHERE local_id = ?", [petLocalId]);
    const [previo]: any = await pool.query("SELECT local_id FROM pet_settings WHERE local_id = ?", [petLocalId]);
    assert.equal(previo.length, 0);
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Sin Settings" });
    const mascota = JSON.parse(create.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: true });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).alta_exigencia, 1);
    const [posterior]: any = await pool.query("SELECT local_id FROM pet_settings WHERE local_id = ?", [petLocalId]);
    assert.equal(posterior.length, 0);
  });

  for (const [label, value] of [["1", 1], ["0", 0], ["string true", "true"], ["string false", "false"], ["null", null], ["array", []], ["object", {}]] as const) {
    test(`PATCH altaExigencia inválido (${label}): 400 sin cambios`, async () => {
      const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: `Inv ${label}` });
      const mascota = JSON.parse(create.body);
      const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: value });
      assert.equal(result.statusCode, 400, result.body);
      const detalle = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken())).body);
      assert.equal(detalle.alta_exigencia, 0);
    });
  }

  test("PATCH altaExigencia de mascota de otro tenant: 404", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", otherPetAdminToken(), { nombre: "Ajena" });
    const mascota = JSON.parse(create.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: true });
    assert.equal(result.statusCode, 404);
    const detalle = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, otherPetAdminToken())).body);
    assert.equal(detalle.alta_exigencia, 0);
  });

  test("Protegidos (local_id, reserva_online_habilitada, alta_exigencia snake) siguen ignorados junto a altaExigencia", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Protegidos" });
    const mascota = JSON.parse(create.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), {
      altaExigencia: true,
      local_id: 99999,
      reserva_online_habilitada: true,
      alta_exigencia: true,
    });
    assert.equal(result.statusCode, 200);
    const editada = JSON.parse(result.body);
    assert.equal(editada.alta_exigencia, 1);
    assert.equal(editada.reserva_online_habilitada, 0);
    assert.equal(editada.local_id, petLocalId);
  });
});

describe("PET-02B Responsables - Crear/Buscar", () => {
  test("Crear responsable nuevo", async () => {
    const result = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "María González",
      telefono: "1123456789",
    });
    assert.equal(result.statusCode, 201);
    const responsable = JSON.parse(result.body);
    assert.equal(responsable.nombre, "María González");
    assert.equal(responsable.telefono, "1123456789");
    assert.equal(responsable.local_id, petLocalId);
    assert.equal(responsable.isNew, true);
  });

  test("Mismo teléfono + mismo local reutiliza existente", async () => {
    await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "María González",
      telefono: "1123456790",
    });
    const result = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "Nombre Distinto",
      telefono: "+54 11 2345 6790",
    });
    assert.equal(result.statusCode, 200);
    const responsable = JSON.parse(result.body);
    assert.equal(responsable.nombre, "María González");
    assert.equal(responsable.telefono, "1123456790");
    assert.equal(responsable.isNew, false);
    const [[stored]]: any = await pool.query("SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ?", [responsable.id, petLocalId]);
    assert.equal(stored.telefono_normalizado, normalizeClientPhone("1123456790"));
  });

  test("Mismo teléfono en otro local es persona distinta", async () => {
    await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "María A",
      telefono: "1188888888",
    });
    const result = await httpRequest("POST", "/api/pet/admin/responsables", otherPetAdminToken(), {
      nombre: "María B",
      telefono: "1188888888",
    });
    assert.equal(result.statusCode, 201);
    const responsable = JSON.parse(result.body);
    assert.equal(responsable.nombre, "María B");
    assert.equal(responsable.isNew, true);
  });

  test("No sobrescribe nombre del existente silenciosamente", async () => {
    await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "Original",
      telefono: "1177777777",
    });
    const result = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "Nuevo Nombre",
      telefono: "1177777777",
    });
    assert.equal(result.statusCode, 200);
    const responsable = JSON.parse(result.body);
    assert.equal(responsable.nombre, "Original");
  });

  test("teléfono inválido devuelve 400 y no crea cliente", async () => {
    const [[before]]: any = await pool.query("SELECT COUNT(*) AS total FROM clientes WHERE local_id = ?", [petLocalId]);
    const response = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), { nombre: "Inválido", telefono: "123456" });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "CLIENT_PHONE_INVALID" });
    const [[after]]: any = await pool.query("SELECT COUNT(*) AS total FROM clientes WHERE local_id = ?", [petLocalId]);
    assert.equal(after.total, before.total);
  });

  test("legacy NULL no se vincula por igualdad textual si falta identidad canónica", async () => {
    const legacyPhone = "1123454321";
    const [legacy]: any = await pool.query("INSERT INTO clientes (nombre, telefono, local_id) VALUES ('Legacy', ?, ?)", [legacyPhone, petLocalId]);
    const result = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), { nombre: "No reutilizar", telefono: legacyPhone });
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: "CLIENT_PHONE_CONFLICT" });
    const [rows]: any = await pool.query("SELECT nombre, telefono_normalizado FROM clientes WHERE id = ? AND local_id = ?", [legacy.insertId, petLocalId]);
    assert.deepEqual(rows[0], { nombre: "Legacy", telefono_normalizado: null });
  });

  test("dos responsables concurrentes equivalentes: una identidad y un cliente", { timeout: 30000 }, async t => {
    const original = pool.query.bind(pool);
    const phone = "1123454310";
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(pool, "query", ((...args: Parameters<typeof pool.query>) => {
      if (String(args[0]).includes("FROM clientes WHERE telefono_normalizado = ? AND local_id = ?") &&
          Array.isArray(args[1]) && args[1][0] === normalizeClientPhone(phone) && reads < 2) {
        return original(...args).then(async result => { reads++; if (reads === 2) release(); await barrier; return result; });
      }
      return original(...args);
    }) as typeof pool.query);
    const responses = await Promise.all([
      httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), { nombre: "Primero", telefono: phone }),
      httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), { nombre: "Segundo", telefono: "+54 11 2345 4310" }),
    ]);
    t.mock.restoreAll();
    assert.equal(reads, 2);
    assert.deepEqual(responses.map(result => result.statusCode).sort(), [200, 201]);
    assert.equal(JSON.parse(responses[0].body).id, JSON.parse(responses[1].body).id);
    const [[count]]: any = await pool.query("SELECT COUNT(*) AS total FROM clientes WHERE telefono_normalizado = ? AND local_id = ?", [normalizeClientPhone(phone), petLocalId]);
    assert.equal(count.total, 1);
  });

  test("MySQL informa nombres distintos para UNIQUE canónica y legacy", async () => {
    const display = "1123454301";
    const canonical = normalizeClientPhone(display);
    await pool.query("INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES ('A', ?, ?, ?)", [display, canonical, petLocalId]);
    await assert.rejects(
      pool.query("INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES ('B', ?, ?, ?)", ["+54 11 2345 4301", canonical, petLocalId]),
      error => clientPhoneDuplicateKey(error) === "canonical",
    );
    await assert.rejects(
      pool.query("INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id) VALUES ('B', ?, NULL, ?)", [display, petLocalId]),
      error => clientPhoneDuplicateKey(error) === "legacy",
    );
  });
});

describe("PET-02B M:N Responsables", () => {
  let mascotaId: number;
  let clienteId: number;

  beforeEach(async () => {
    const m = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Mascota M:N" });
    mascotaId = JSON.parse(m.body).id;
    const c = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "Responsable M:N",
      telefono: "1155555555",
    });
    clienteId = JSON.parse(c.body).id;
  });

  test("Asociar responsable mismo tenant", async () => {
    const result = await httpRequest("POST", `/api/pet/admin/mascotas/${mascotaId}/responsables`, petAdminToken(), {
      clienteId,
    });
    assert.equal(result.statusCode, 201);
  });

  test("Evitar asociación duplicada", async () => {
    await httpRequest("POST", `/api/pet/admin/mascotas/${mascotaId}/responsables`, petAdminToken(), { clienteId });
    const result = await httpRequest("POST", `/api/pet/admin/mascotas/${mascotaId}/responsables`, petAdminToken(), {
      clienteId,
    });
    assert.equal(result.statusCode, 409);
    assert.ok(JSON.parse(result.body).error.includes("ya está asociado"));
  });

  test("Rechazar mascota de otro tenant", async () => {
    const m = await httpRequest("POST", "/api/pet/admin/mascotas", otherPetAdminToken(), { nombre: "Otra" });
    const otraMascotaId = JSON.parse(m.body).id;
    const result = await httpRequest("POST", `/api/pet/admin/mascotas/${otraMascotaId}/responsables`, petAdminToken(), {
      clienteId,
    });
    assert.equal(result.statusCode, 404);
  });

  test("Rechazar cliente de otro tenant", async () => {
    const c = await httpRequest("POST", "/api/pet/admin/responsables", otherPetAdminToken(), {
      nombre: "Otro Cliente",
      telefono: "1166666666",
    });
    const otroClienteId = JSON.parse(c.body).id;
    const result = await httpRequest("POST", `/api/pet/admin/mascotas/${mascotaId}/responsables`, petAdminToken(), {
      clienteId: otroClienteId,
    });
    assert.equal(result.statusCode, 404);
  });

  test("Desasociar correctamente", async () => {
    await httpRequest("POST", `/api/pet/admin/mascotas/${mascotaId}/responsables`, petAdminToken(), { clienteId });
    const result = await httpRequest("DELETE", `/api/pet/admin/mascotas/${mascotaId}/responsables/${clienteId}`, petAdminToken());
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).message, "Responsable desasociado correctamente");
  });

  test("No desasociar relación de otro tenant", async () => {
    const m = await httpRequest("POST", "/api/pet/admin/mascotas", otherPetAdminToken(), { nombre: "Otra" });
    const otraMascotaId = JSON.parse(m.body).id;
    const c = await httpRequest("POST", "/api/pet/admin/responsables", otherPetAdminToken(), {
      nombre: "Otro Cliente",
      telefono: "1166666666",
    });
    const otroClienteId = JSON.parse(c.body).id;
    await httpRequest("POST", `/api/pet/admin/mascotas/${otraMascotaId}/responsables`, otherPetAdminToken(), { clienteId: otroClienteId });
    const result = await httpRequest("DELETE", `/api/pet/admin/mascotas/${otraMascotaId}/responsables/${otroClienteId}`, petAdminToken());
    assert.equal(result.statusCode, 404);
  });

  test("Detalle de mascota incluye responsables", async () => {
    await httpRequest("POST", `/api/pet/admin/mascotas/${mascotaId}/responsables`, petAdminToken(), { clienteId });
    const result = await httpRequest("GET", `/api/pet/admin/mascotas/${mascotaId}`, petAdminToken());
    assert.equal(result.statusCode, 200);
    const detalle = JSON.parse(result.body);
    assert.ok(Array.isArray(detalle.responsables));
    assert.ok(detalle.responsables.some((r: any) => r.id === clienteId));
  });
});

describe("PET-11B.1 habilitación administrativa de reserva online", () => {
  const path = (id: number | string) => `/api/pet/admin/mascotas/${id}/reserva-online`;

  test("solo admin de local PET autenticado puede usar la operación", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Seguridad online" });
    const id = JSON.parse(create.body).id as number;
    assert.equal((await httpRequest("PATCH", path(id), undefined, { reservaOnlineHabilitada: true })).statusCode, 401);
    assert.equal((await httpRequest("PATCH", path(id), petAdminToken({ rol: "empleado" }), { reservaOnlineHabilitada: true })).statusCode, 403);
    assert.equal((await httpRequest("PATCH", path(id), beautyAdminToken(), { reservaOnlineHabilitada: true })).statusCode, 403);
    assert.equal((await httpRequest("PATCH", path("1abc"), petAdminToken(), { reservaOnlineHabilitada: true })).statusCode, 400);
    assert.equal((await httpRequest("PATCH", path(2147483648), petAdminToken(), { reservaOnlineHabilitada: true })).statusCode, 400);
  });

  test("false → true → false actualiza solo el flag y persiste; no requiere servicios", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Toggle reserva", altaExigencia: true });
    const mascota = JSON.parse(create.body);
    assert.equal(mascota.reserva_online_habilitada, 0);

    const before = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { altaExigencia: true });
    assert.equal(before.statusCode, 200);

    const enable = await httpRequest("PATCH", path(mascota.id), petAdminToken(), { reservaOnlineHabilitada: true });
    assert.equal(enable.statusCode, 200);
    assert.deepEqual(JSON.parse(enable.body), { id: mascota.id, reservaOnlineHabilitada: true });

    const [details]: any = await pool.query(
      "SELECT nombre, activo, alta_exigencia, reserva_online_habilitada FROM mascotas WHERE id = ? AND local_id = ?",
      [mascota.id, petLocalId]
    );
    assert.deepEqual(details[0], { nombre: "Toggle reserva", activo: 1, alta_exigencia: 1, reserva_online_habilitada: 1 });

    for (const table of ["mascota_servicios", "mascota_extras"] as const) {
      const [rows]: any = await pool.query(`SELECT COUNT(*) AS total FROM ${table} WHERE mascota_id = ? AND local_id = ?`, [mascota.id, petLocalId]);
      assert.equal(rows[0].total, 0);
    }

    const disable = await httpRequest("PATCH", path(mascota.id), petAdminToken(), { reservaOnlineHabilitada: false });
    assert.equal(disable.statusCode, 200);
    assert.deepEqual(JSON.parse(disable.body), { id: mascota.id, reservaOnlineHabilitada: false });
    const detail = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken())).body);
    assert.equal(detail.reserva_online_habilitada, 0);
    assert.equal(detail.alta_exigencia, 1);
  });

  for (const [label, value] of [
    ["1", 1], ["0", 0], ["string true", "true"], ["string false", "false"],
    ["null", null], ["array", []], ["object", {}], ["campo extra", { reservaOnlineHabilitada: true, activo: true }],
    ["campo faltante", {}],
  ] as const) {
    test(`rechaza body inválido (${label}) sin modificar la mascota`, async () => {
      const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: `Invalido ${label}` });
      const mascota = JSON.parse(create.body);
      const result = await httpRequest("PATCH", path(mascota.id), petAdminToken(),
        label === "campo extra" ? value : { reservaOnlineHabilitada: value });
      assert.equal(result.statusCode, 400, result.body);
      const detail = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken())).body);
      assert.equal(detail.reserva_online_habilitada, 0);
      assert.equal(detail.activo, 1);
    });
  }

  test("no habilita mascota inactiva pero permite deshabilitarla", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "Inactiva online" });
    const mascota = JSON.parse(create.body);
    await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { activo: false });

    const enable = await httpRequest("PATCH", path(mascota.id), petAdminToken(), { reservaOnlineHabilitada: true });
    assert.equal(enable.statusCode, 409);
    assert.deepEqual(JSON.parse(enable.body), { error: "PET_MASCOTA_INACTIVE" });

    const disable = await httpRequest("PATCH", path(mascota.id), petAdminToken(), { reservaOnlineHabilitada: false });
    assert.equal(disable.statusCode, 200);
    assert.deepEqual(JSON.parse(disable.body), { id: mascota.id, reservaOnlineHabilitada: false });
    const detail = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken())).body);
    assert.equal(detail.activo, 0);
    assert.equal(detail.reserva_online_habilitada, 0);
  });

  test("mascota ajena o inexistente devuelve 404 sin alterar otro tenant", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", otherPetAdminToken(), { nombre: "Ajena reserva" });
    const id = JSON.parse(create.body).id as number;
    assert.equal((await httpRequest("PATCH", path(id), petAdminToken(), { reservaOnlineHabilitada: true })).statusCode, 404);
    assert.equal((await httpRequest("PATCH", path(2147483647), petAdminToken(), { reservaOnlineHabilitada: true })).statusCode, 404);
    const detail = JSON.parse((await httpRequest("GET", `/api/pet/admin/mascotas/${id}`, otherPetAdminToken())).body);
    assert.equal(detail.reserva_online_habilitada, 0);
  });

  test("el PATCH general conserva protegido reserva_online_habilitada", async () => {
    const create = await httpRequest("POST", "/api/pet/admin/mascotas", petAdminToken(), { nombre: "PATCH general" });
    const mascota = JSON.parse(create.body);
    const result = await httpRequest("PATCH", `/api/pet/admin/mascotas/${mascota.id}`, petAdminToken(), { reservaOnlineHabilitada: true });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).reserva_online_habilitada, 0);
  });
});
