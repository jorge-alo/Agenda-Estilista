import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../../../config/db";
import { normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import petRouter from "../pet.routes";

const prefix = `pet10c1-${randomUUID()}`;
let nextPhone = 2000;
function phone() { return `112345${nextPhone++}`; }
const secret = "PET10C1_FICTICIO_TEST";
const locales: number[] = [];
let port: number;
let server: Server;

function token(localId = locales[0], rol = "admin") {
  return jwt.sign({ userId: 1, localId, rol }, secret);
}
async function request(method: string, path: string, body?: unknown, auth?: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}
const convertir = (id: number | string) => `/api/pet/admin/solicitudes/${id}/convertir`;
async function solicitud(localId = locales[0], estado = "NUEVA", telefono = phone()): Promise<number> {
  const [result]: any = await pool.query(
    `INSERT INTO solicitudes_pet (local_id, responsable_nombre, responsable_telefono, responsable_telefono_secundario,
     mascota_nombre, mascota_raza, mascota_fecha_nacimiento, mascota_tamano, mascota_sexo, motivo_contacto, estado)
     VALUES (?, 'Nombre declarado', ?, 'tel-alternativo', 'Perro declarado', 'Raza declarada', '2020-05-10', 'chico', 'hembra', 'Baño', ?)`,
    [localId, telefono, estado]
  );
  return result.insertId;
}
async function crearCliente(localId: number, telefono: string, nombre = "Nombre existente"): Promise<number> {
  const [result]: any = await pool.query("INSERT INTO clientes (local_id, nombre, telefono, telefono_normalizado) VALUES (?, ?, ?, ?)", [localId, nombre, telefono, normalizeClientPhone(telefono)]);
  return result.insertId;
}
async function estado(id: number) {
  const [rows]: any = await pool.query("SELECT * FROM solicitudes_pet WHERE id = ?", [id]);
  return rows[0];
}
async function cantidades(localId: number) {
  const [[row]]: any = await pool.query(
    `SELECT (SELECT COUNT(*) FROM clientes WHERE local_id = ?) AS clientes,
      (SELECT COUNT(*) FROM mascotas WHERE local_id = ?) AS mascotas,
      (SELECT COUNT(*) FROM mascota_clientes WHERE local_id = ?) AS vinculos`,
    [localId, localId, localId]
  );
  return row;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pet/admin", petRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  for (const kind of ["PET_GROOMING", "PET_GROOMING", "BEAUTY"]) {
    const [result]: any = await pool.query("INSERT INTO locales (nombre, slug, business_type) VALUES (?, ?, ?)", [prefix, `${prefix}-${locales.length}`, kind]);
    locales.push(result.insertId);
  }
});
beforeEach(t => {
  if (!("mock" in t)) throw new Error("Mock unavailable");
  t.mock.property(process, "env", { ...process.env, JWT_SECRET: secret });
});
after(async () => {
  try {
    for (const id of locales) {
      // FKs RESTRICT: las solicitudes se limpian antes de sus clientes/mascotas.
      await pool.query("DELETE FROM solicitudes_pet WHERE local_id = ?", [id]);
      await pool.query("DELETE FROM locales WHERE id = ?", [id]);
    }
    const [[rows]]: any = await pool.query("SELECT COUNT(*) AS total FROM locales WHERE nombre = ?", [prefix]);
    assert.equal(rows.total, 0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await pool.end();
  }
});

test("seguridad: auth, rol, vertical, tenant e ID estricto", async () => {
  const id = await solicitud();
  assert.equal((await request("POST", convertir(id), {})).status, 401);
  assert.equal((await request("POST", convertir(id), {}, token(locales[0], "empleado"))).status, 403);
  assert.equal((await request("POST", convertir(id), {}, token(locales[2]))).status, 403);
  assert.equal((await request("POST", convertir(id), {}, token(locales[1]))).status, 404);
  assert.equal((await request("POST", convertir(2147483647), {}, token())).status, 404);
  assert.equal((await request("POST", convertir("1abc"), {}, token())).status, 400);
  assert.deepEqual(await cantidades(locales[0]), { clientes: 0, mascotas: 0, vinculos: 0 });
});

test("NUEVA: body vacío usa snapshot, crea ficha sin habilitar y conserva historia", async () => {
  const id = await solicitud();
  const antes = await estado(id);
  const result = await request("POST", convertir(id), {}, token());
  assert.equal(result.status, 201);
  const data = result.data as { solicitudId: number; estado: string; cliente: { id: number; reutilizado: boolean }; mascota: { id: number } };
  assert.deepEqual(Object.keys(data).sort(), ["cliente", "estado", "mascota", "solicitudId"]);
  assert.equal(data.solicitudId, id);
  assert.equal(data.estado, "CONVERTIDA");
  assert.equal(data.cliente.reutilizado, false);
  assert.deepEqual(await cantidades(locales[0]), { clientes: 1, mascotas: 1, vinculos: 1 });
  const [clients]: any = await pool.query("SELECT nombre, telefono FROM clientes WHERE id = ? AND local_id = ?", [data.cliente.id, locales[0]]);
  assert.deepEqual(clients[0], { nombre: antes.responsable_nombre, telefono: antes.responsable_telefono });
  const [pets]: any = await pool.query("SELECT nombre, raza, DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha, tamano, sexo, tipo_pelo, observaciones, activo, alta_exigencia, reserva_online_habilitada FROM mascotas WHERE id = ? AND local_id = ?", [data.mascota.id, locales[0]]);
  assert.deepEqual(pets[0], { nombre: antes.mascota_nombre, raza: antes.mascota_raza, fecha: "2020-05-10", tamano: "chico", sexo: "hembra", tipo_pelo: null, observaciones: null, activo: 1, alta_exigencia: 0, reserva_online_habilitada: 0 });
  const [links]: any = await pool.query("SELECT * FROM mascota_clientes WHERE mascota_id = ? AND local_id = ?", [data.mascota.id, locales[0]]);
  assert.equal(links.length, 1);
  assert.equal(links[0].cliente_id, data.cliente.id);
  for (const table of ["mascota_servicios", "mascota_extras"]) {
    const [[row]]: any = await pool.query(`SELECT COUNT(*) AS total FROM ${table} WHERE mascota_id = ? AND local_id = ?`, [data.mascota.id, locales[0]]);
    assert.equal(row.total, 0);
  }
  const convertido = await estado(id);
  assert.equal(convertido.estado, "CONVERTIDA");
  assert.equal(convertido.cliente_id, data.cliente.id);
  assert.equal(convertido.mascota_id, data.mascota.id);
  assert.ok(convertido.converted_at);
  for (const key of ["responsable_nombre", "responsable_telefono", "responsable_telefono_secundario", "mascota_nombre", "mascota_raza", "mascota_fecha_nacimiento", "mascota_tamano", "mascota_sexo", "motivo_contacto", "created_at"]) {
    assert.deepEqual(convertido[key], antes[key], key);
  }
  const segundo = await request("POST", convertir(id), {}, token());
  assert.deepEqual(segundo, { status: 409, data: { error: "PET_SOLICITUD_NOT_CONVERTIBLE" } });
  assert.deepEqual(await cantidades(locales[0]), { clientes: 1, mascotas: 1, vinculos: 1 });
});

test("CONTACTADA: overrides parciales y null solo en opcionales de mascota", async () => {
  const id = await solicitud(locales[0], "CONTACTADA");
  const result = await request("POST", convertir(id), {
    responsable: { nombre: "  Corregido  ", telefono: " 011 15 2345-6790 " },
    mascota: { nombre: " Nuevo nombre ", raza: null, fechaNacimiento: null, tamano: null, sexo: null, tipoPelo: " Rizado ", observaciones: " Revisar el pelo " },
  }, token());
  assert.equal(result.status, 201);
  const data = result.data as { cliente: { id: number }; mascota: { id: number } };
  const [[client]]: any = await pool.query("SELECT nombre, telefono FROM clientes WHERE id = ?", [data.cliente.id]);
  assert.deepEqual(client, { nombre: "Corregido", telefono: "011 15 2345-6790" });
  const [[pet]]: any = await pool.query("SELECT nombre, raza, fecha_nacimiento, tamano, sexo, tipo_pelo, observaciones FROM mascotas WHERE id = ?", [data.mascota.id]);
  assert.deepEqual(pet, { nombre: "Nuevo nombre", raza: null, fecha_nacimiento: null, tamano: null, sexo: null, tipo_pelo: "Rizado", observaciones: "Revisar el pelo" });
  const historic = await estado(id);
  assert.equal(historic.responsable_nombre, "Nombre declarado");
  assert.equal(historic.mascota_raza, "Raza declarada");
  assert.equal(historic.responsable_telefono_secundario, "tel-alternativo");
});

test("cliente existente del mismo tenant se reutiliza sin cambiar nombre; otro tenant no", async () => {
  const originalPhone = phone();
  const existing = await crearCliente(locales[0], originalPhone);
  const alternate = `+54 11 2345 ${originalPhone.slice(-4)}`;
  const id = await solicitud(locales[0], "NUEVA", alternate);
  const reused = await request("POST", convertir(id), { responsable: { nombre: "No cambiar" } }, token());
  assert.equal(reused.status, 201);
  assert.deepEqual(reused.data.cliente, { id: existing, reutilizado: true });
  const [[old]]: any = await pool.query("SELECT nombre, telefono, telefono_normalizado FROM clientes WHERE id = ?", [existing]);
  assert.deepEqual(old, { nombre: "Nombre existente", telefono: originalPhone, telefono_normalizado: normalizeClientPhone(originalPhone) });
  const idOtro = await solicitud(locales[1], "NUEVA", alternate);
  const fresh = await request("POST", convertir(idOtro), {}, token(locales[1]));
  assert.equal(fresh.status, 201);
  assert.deepEqual(fresh.data.cliente, { id: (fresh.data.cliente as { id: number }).id, reutilizado: false });
  assert.notEqual((fresh.data.cliente as { id: number }).id, existing);
});

test("teléfono inválido en solicitud convertida responde 400 sin cliente ni mascota", async () => {
  const id = await solicitud(locales[0], "NUEVA", "123456");
  const before = await cantidades(locales[0]);
  assert.deepEqual(await request("POST", convertir(id), {}, token()), { status: 400, data: { error: "CLIENT_PHONE_INVALID" } });
  assert.deepEqual(await cantidades(locales[0]), before);
  const row = await estado(id);
  assert.equal(row.estado, "NUEVA");
  assert.equal(row.cliente_id, null);
  assert.equal(row.mascota_id, null);
});

test("cliente legacy válido con canonical NULL no se recupera por igualdad display", async () => {
  const legacyPhone = phone();
  const [legacy]: any = await pool.query("INSERT INTO clientes (nombre, telefono, local_id) VALUES ('Legacy', ?, ?)", [legacyPhone, locales[0]]);
  const id = await solicitud(locales[0], "NUEVA", legacyPhone);
  const before = await cantidades(locales[0]);
  assert.deepEqual(await request("POST", convertir(id), {}, token()), { status: 409, data: { error: "CLIENT_PHONE_CONFLICT" } });
  assert.deepEqual(await cantidades(locales[0]), before);
  assert.equal((await estado(id)).estado, "NUEVA");
  const [[existing]]: any = await pool.query("SELECT telefono_normalizado FROM clientes WHERE id=? AND local_id=?", [legacy.insertId, locales[0]]);
  assert.equal(existing.telefono_normalizado, null);
});

test("DESCARTADA y CONVERTIDA son terminales", async () => {
  const id = await solicitud(locales[0], "DESCARTADA");
  const beforeCount = await cantidades(locales[0]);
  assert.deepEqual(await request("POST", convertir(id), {}, token()), { status: 409, data: { error: "PET_SOLICITUD_NOT_CONVERTIBLE" } });
  assert.deepEqual(await cantidades(locales[0]), beforeCount);
});

test("validación estricta de overrides: no crea entidades y no cambia estado", async () => {
  const id = await solicitud();
  const beforeCount = await cantidades(locales[0]);
  const invalid = [
    { localId: locales[1] }, { clienteId: 2 }, { estado: "CONVERTIDA" }, { mascotaExistenteId: 1 },
    { responsable: { nombre: null } }, { responsable: { telefono: null } }, { mascota: { nombre: null } },
    { responsable: { nombre: "  " } }, { responsable: { telefono: "  " } },
    { mascota: { fechaNacimiento: "2023-02-30" } }, { mascota: { tamano: "x".repeat(21) } },
    { mascota: { sexo: "x".repeat(21) } }, { mascota: { tipoPelo: "x".repeat(51) } },
    { mascota: { activo: false } }, { mascota: { altaExigencia: true } }, { mascota: { reservaOnlineHabilitada: true } },
    { responsable: { clienteId: 1 } }, { mascota: { mascotaId: 1 } }, { mascota: { observaciones: "x".repeat(5001) } },
  ];
  for (const [index, body] of invalid.entries()) {
    const r = await request("POST", convertir(id), body, token());
    assert.equal(r.status, 400, `caso ${index}`);
  }
  assert.deepEqual(await cantidades(locales[0]), beforeCount);
  assert.equal((await estado(id)).estado, "NUEVA");
});

test("colisión UNIQUE legacy: relee al cliente ganador sin sobrescribirlo", async t => {
  const currentPhone = phone();
  const existing = await crearCliente(locales[0], currentPhone);
  const id = await solicitud(locales[0], "NUEVA", currentPhone);
  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const conn = await originalGetConnection();
    const originalQuery = conn.query.bind(conn);
    t.mock.method(conn, "query", async (...args: Parameters<typeof conn.query>) => {
      if (String(args[0]) === "SELECT id FROM clientes WHERE telefono_normalizado = ? AND local_id = ?") return [[], []];
      return originalQuery(...args);
    });
    return conn;
  });
  const result = await request("POST", convertir(id), {}, token());
  t.mock.restoreAll();
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.cliente, { id: existing, reutilizado: true });
  const [[n]]: any = await pool.query("SELECT COUNT(*) AS total FROM clientes WHERE local_id = ? AND telefono_normalizado = ?", [locales[0], normalizeClientPhone(currentPhone)]);
  assert.equal(n.total, 1);
});

for (const [step, queryPrefix] of [
  ["después del cliente", "INSERT INTO mascotas"],
  ["después de la mascota", "INSERT INTO mascota_clientes"],
  ["después del vínculo", "UPDATE solicitudes_pet"],
] as const) {
  test(`rollback total por fallo ${step}`, async t => {
    const id = await solicitud();
    const beforeCount = await cantidades(locales[0]);
    const originalGetConnection = pool.getConnection.bind(pool);
    t.mock.method(pool, "getConnection", async () => {
      const conn = await originalGetConnection();
      const originalQuery = conn.query.bind(conn);
      t.mock.method(conn, "query", async (...args: Parameters<typeof conn.query>) => {
        if (String(args[0]).trimStart().startsWith(queryPrefix)) throw new Error("Fallo inducido PET-10C.1");
        return originalQuery(...args);
      });
      return conn;
    });
    const result = await request("POST", convertir(id), {}, token());
    t.mock.restoreAll();
    assert.equal(result.status, 500);
    assert.deepEqual(await cantidades(locales[0]), beforeCount);
    const row = await estado(id);
    assert.equal(row.estado, "NUEVA");
    assert.equal(row.cliente_id, null);
    assert.equal(row.mascota_id, null);
    assert.equal(row.converted_at, null);
  });
}

test("locks funcionales: local antes de primera lectura bloqueante de solicitud", async t => {
  const id = await solicitud();
  const queries: string[] = [];
  const originalGetConnection = pool.getConnection.bind(pool);
  t.mock.method(pool, "getConnection", async () => {
    const conn = await originalGetConnection();
    const originalQuery = conn.query.bind(conn);
    t.mock.method(conn, "query", async (...args: Parameters<typeof conn.query>) => {
      queries.push(String(args[0]));
      return originalQuery(...args);
    });
    return conn;
  });
  assert.equal((await request("POST", convertir(id), {}, token())).status, 201);
  t.mock.restoreAll();
  const lockLocal = queries.findIndex(query => query.includes("FROM locales WHERE id = ? FOR UPDATE"));
  const lockSolicitud = queries.findIndex(query => query.includes("FROM solicitudes_pet WHERE id = ? AND local_id = ? FOR UPDATE"));
  const selectCliente = queries.findIndex(query => query.includes("FROM clientes WHERE telefono_normalizado = ? AND local_id = ?"));
  assert.ok(lockLocal >= 0 && lockLocal < lockSolicitud && lockSolicitud < selectCliente);
  assert.equal(queries.filter(query => query.includes("FROM solicitudes_pet")).length, 1);
});

test("CHECK y FKs: estados, referencias tenant-safe y RESTRICT", async () => {
  const id = await solicitud();
  const ownClient = await crearCliente(locales[0], phone());
  const otherClient = await crearCliente(locales[1], phone());
  const [pet]: any = await pool.query("INSERT INTO mascotas (local_id, nombre) VALUES (?, 'Perro FK')", [locales[0]]);
  const [otherPet]: any = await pool.query("INSERT INTO mascotas (local_id, nombre) VALUES (?, 'Perro ajeno FK')", [locales[1]]);
  assert.ok(pet.insertId && otherPet.insertId);
  await assert.rejects(pool.query("UPDATE solicitudes_pet SET estado = 'CONVERTIDA' WHERE id = ?", [id]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(pool.query("UPDATE solicitudes_pet SET estado = 'CONVERTIDA', cliente_id = ?, mascota_id = ? WHERE id = ?", [ownClient, pet.insertId, id]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(pool.query("UPDATE solicitudes_pet SET estado = 'NUEVA', cliente_id = ? WHERE id = ?", [ownClient, id]), { code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await assert.rejects(pool.query("UPDATE solicitudes_pet SET estado = 'CONVERTIDA', cliente_id = ?, mascota_id = ?, converted_at = NOW() WHERE id = ?", [otherClient, pet.insertId, id]), { code: "ER_NO_REFERENCED_ROW_2" });
  await assert.rejects(pool.query("UPDATE solicitudes_pet SET estado = 'CONVERTIDA', cliente_id = ?, mascota_id = ?, converted_at = NOW() WHERE id = ?", [ownClient, otherPet.insertId, id]), { code: "ER_NO_REFERENCED_ROW_2" });
  const [result]: any = await pool.query("UPDATE solicitudes_pet SET estado = 'CONVERTIDA', cliente_id = ?, mascota_id = ?, converted_at = NOW() WHERE id = ?", [ownClient, pet.insertId, id]);
  assert.equal(result.affectedRows, 1);
  await assert.rejects(pool.query("DELETE FROM clientes WHERE id = ? AND local_id = ?", [ownClient, locales[0]]), { code: "ER_ROW_IS_REFERENCED_2" });
  await assert.rejects(pool.query("DELETE FROM mascotas WHERE id = ? AND local_id = ?", [pet.insertId, locales[0]]), { code: "ER_ROW_IS_REFERENCED_2" });
});
