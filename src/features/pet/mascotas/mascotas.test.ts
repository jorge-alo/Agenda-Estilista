import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import Module from "node:module";
import { after, before, beforeEach, test, describe } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../../config/db";

const JWT_TEST_SECRET = "SECRETO_JWT_FICTICIO_PET02_SOLO_TESTS";

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
  body?: Record<string, unknown>
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
    if (body) req.end(JSON.stringify(body));
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
    ["PET Test Local", "pet-test", "1111111111", "PET_GROOMING", "activo"]
  );
  petLocalId = petResult.insertId;

  const [otherPetResult]: any = await pool.query(
    `INSERT INTO locales (nombre, slug, telefono, business_type, suscripcion_estado, suscripcion_vencimiento)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 30 DAY))`,
    ["Other PET Test Local", "other-pet-test", "3333333333", "PET_GROOMING", "activo"]
  );
  otherPetLocalId = otherPetResult.insertId;

  const [beautyResult]: any = await pool.query(
    `INSERT INTO locales (nombre, slug, telefono, business_type, suscripcion_estado, suscripcion_vencimiento)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 30 DAY))`,
    ["Beauty Test Local", "beauty-test", "2222222222", "BEAUTY", "activo"]
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
      telefono: "1199999999",
    });
    const result = await httpRequest("POST", "/api/pet/admin/responsables", petAdminToken(), {
      nombre: "Nombre Distinto",
      telefono: "1199999999",
    });
    assert.equal(result.statusCode, 200);
    const responsable = JSON.parse(result.body);
    assert.equal(responsable.nombre, "María González");
    assert.equal(responsable.isNew, false);
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
