import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import type { RowDataPacket } from "mysql2";
import type { Request, Response } from "express";
import { pool } from "../../config/db";
import { procesarPagoSuscripcion } from "./suscripcion.pagos";
import { suscripcionService } from "./suscripcion.service";
import { crearLinkSuscripcion } from "./suscripcion.controller";

const ESTADO_INICIAL = "pendiente_pago";
const GLOBAL_TOKEN = "TOKEN_GLOBAL_FICTICIO_SUSCRIPCION";
const LOCAL_TOKEN = "TOKEN_LOCAL_FICTICIO_COMPRADOR";
const erroresCreacion: unknown[][] = [];
let whatsappCalls = 0;

// Evitar cargar el proveedor real incluso en pruebas integradas del controller.
const notificationPath = require.resolve("../notifications/application/sendWhatsAppNotification");
const originalNotificationModule = require.cache[notificationPath];
const notificationStub = new Module(notificationPath);
notificationStub.filename = notificationPath;
notificationStub.loaded = true;
notificationStub.exports = {
  sendTurnoConfirmado: async () => {
    whatsappCalls++;
    throw new Error("WhatsApp no permitido en flujo de suscripciones");
  },
};
require.cache[notificationPath] = notificationStub;
const { webhook, webhookSuscripcion } = require("../pagos/pagos.controller") as typeof import("../pagos/pagos.controller");

let localId: number;
let contadorPagos = 1000;

const hoy = () => `date_format(curdate(), '%Y-%m-%d')`;

async function crearIntento(): Promise<string> {
  const ref = `suscripcion-${localId}-${randomUUID()}`;
  await pool.query(
    `INSERT INTO pagos_suscripcion (local_id, external_reference, monto, estado)
     VALUES (?, ?, 100, 'pendiente')`,
    [localId, ref]
  );
  return ref;
}

const nuevoPagoMp = () => String(++contadorPagos);

async function fijarSuscripcion(vencimientoSql: string | null, estado = ESTADO_INICIAL) {
  await pool.query(
    `UPDATE locales
     SET suscripcion_vencimiento = ${vencimientoSql ?? "NULL"},
         suscripcion_estado = ?
     WHERE id = ?`,
    [estado, localId]
  );
}

async function leerLocal() {
  const [rows]: any = await pool.query(
    `SELECT suscripcion_estado AS estado,
            DATE_FORMAT(suscripcion_vencimiento, '%Y-%m-%d') AS venc,
            DATEDIFF(suscripcion_vencimiento, CURDATE()) AS dias
     FROM locales WHERE id = ?`,
    [localId]
  );
  return rows[0];
}

before(async () => {
  // PROTECCIÓN: abortar si no es claramente la base local.
  const [info]: any = await pool.query(
    `SELECT DATABASE() AS db, @@hostname AS host`
  );
  const { db, host } = info[0];

  const [tcp]: any = await pool.query(`SELECT @@port AS port`);
  console.log(`🔒 Base conectada: ${db} (host del servidor: ${host}, puerto ${tcp[0].port})`);

  if (db !== "agenda_db") {
    throw new Error(`ABORTADO: la base es "${db}", se esperaba "agenda_db".`);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("ABORTADO: NODE_ENV=production.");
  }
  const urlsProhibidas = /railway|rlwy|proxy\.rlwy\.net/i;
  for (const [k, v] of Object.entries(process.env)) {
    if (/DB|DATABASE|MYSQL/i.test(k) && urlsProhibidas.test(String(v))) {
      throw new Error(`ABORTADO: la variable ${k} apunta a Railway.`);
    }
  }

  // Local de prueba propio: no toca datos reales.
  const [res]: any = await pool.query(
    `INSERT INTO locales (nombre, slug) VALUES ('__TEST_SUSCRIPCION__', ?)`,
    [`test-${randomUUID().slice(0, 8)}`]
  );
  localId = res.insertId;
});

beforeEach(async (t) => {
  assert.ok("mock" in t);
  t.mock.property(process, "env", {
    MP_ACCESS_TOKEN: GLOBAL_TOKEN, BACKEND_URL: "https://backend.test/",
    FRONTEND_URL: "https://frontend.test/",
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw { status: 400, message: "HTTP externo no permitido en esta prueba" };
  });
  erroresCreacion.length = 0;
  t.mock.method(console, "error", (...args: unknown[]) => { erroresCreacion.push(args); });
  await pool.query(`DELETE FROM pagos_suscripcion WHERE local_id = ?`, [localId]);
  await pool.query("UPDATE locales SET mp_access_token = ? WHERE id = ?", [LOCAL_TOKEN, localId]);
  await fijarSuscripcion(null);
});

after(async () => {
  if (localId) {
    await pool.query(`DELETE FROM pagos_suscripcion WHERE local_id = ?`, [localId]);
    await pool.query(`DELETE FROM locales WHERE id = ?`, [localId]);
  }
  await pool.end();
  if (originalNotificationModule) require.cache[notificationPath] = originalNotificationModule;
  else delete require.cache[notificationPath];
});

test("primera aprobación: activa y suma 30 días desde hoy", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({
    externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp(),
  });
  assert.equal(r, "renovada");
  const l = await leerLocal();
  assert.equal(l.estado, "activo");
  assert.equal(l.dias, 30);
});

test("notificación repetida del mismo pago: no extiende otra vez", async () => {
  const ref = await crearIntento();
  const mp = nuevoPagoMp();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp });
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp });
  assert.equal(r, "ya_aprobada");
  assert.equal((await leerLocal()).dias, 30);
});

test("segundo pago aprobado distinto: no extiende y se avisa", async () => {
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "segundo_pago_aprobado");
  assert.equal((await leerLocal()).dias, 30);
});

test("suscripción vigente: acumula 30 días desde el vencimiento", async () => {
  await fijarSuscripcion(`DATE_ADD(CURDATE(), INTERVAL 10 DAY)`, "activo");
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal((await leerLocal()).dias, 40);
});

test("suscripción vencida: cuenta 30 días desde hoy", async () => {
  await fijarSuscripcion(`DATE_SUB(CURDATE(), INTERVAL 15 DAY)`, "activo");
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal((await leerLocal()).dias, 30);
});

test("sin vencimiento (NULL): cuenta 30 días desde hoy", async () => {
  await fijarSuscripcion(null);
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal((await leerLocal()).dias, 30);
});

test("pago rechazado: no activa ni renueva", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "rejected", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "registrada_sin_renovar");
  const l = await leerLocal();
  assert.equal(l.estado, ESTADO_INICIAL);
  assert.equal(l.venc, null);
});

test("pago cancelado: no activa ni renueva", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "cancelled", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "registrada_sin_renovar");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("rechazado y luego aprobado en el mismo checkout: renueva una vez", async () => {
  const ref = await crearIntento();
  await procesarPagoSuscripcion({ externalReference: ref, status: "rejected", mpPaymentId: nuevoPagoMp() });
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "renovada");
  assert.equal((await leerLocal()).dias, 30);
});

test("estado no final (pending): no modifica nada", async () => {
  const ref = await crearIntento();
  const r = await procesarPagoSuscripcion({ externalReference: ref, status: "pending", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "estado_no_final");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("referencia con formato inválido: no modifica nada", async () => {
  const r = await procesarPagoSuscripcion({
    externalReference: `suscripcion-${localId}`, status: "approved", mpPaymentId: nuevoPagoMp(),
  });
  assert.equal(r, "referencia_invalida");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("referencia válida pero inexistente: no modifica nada", async () => {
  const r = await procesarPagoSuscripcion({
    externalReference: `suscripcion-${localId}-${randomUUID()}`,
    status: "approved", mpPaymentId: nuevoPagoMp(),
  });
  assert.equal(r, "intento_no_encontrado");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("referencia de otro local: no modifica nada", async () => {
  const ref = await crearIntento();
  const otra = ref.replace(`suscripcion-${localId}-`, `suscripcion-${localId + 99999}-`);
  const r = await procesarPagoSuscripcion({ externalReference: otra, status: "approved", mpPaymentId: nuevoPagoMp() });
  assert.equal(r, "intento_no_encontrado");
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

test("dos notificaciones concurrentes del mismo pago: una sola renovación", async () => {
  const ref = await crearIntento();
  const mp = nuevoPagoMp();
  const resultados = await Promise.all([
    procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp }),
    procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: mp }),
  ]);
  assert.equal(resultados.filter((r) => r === "renovada").length, 1);
  assert.equal((await leerLocal()).dias, 30);
});

test("error de base de datos en la transacción: no deja renovación parcial", async () => {
  const ref = await crearIntento();
  // Ocupamos el mp_payment_id en OTRA fila para que el UPDATE choque con el índice único.
  const repetido = nuevoPagoMp();
  const otraRef = await crearIntento();
  await pool.query(
    `UPDATE pagos_suscripcion SET mp_payment_id = ? WHERE external_reference = ?`,
    [repetido, otraRef]
  );

  await assert.rejects(
    procesarPagoSuscripcion({ externalReference: ref, status: "approved", mpPaymentId: repetido })
  );

  const [rows]: any = await pool.query(
    `SELECT estado, mp_payment_id FROM pagos_suscripcion WHERE external_reference = ?`, [ref]
  );
  assert.equal(rows[0].estado, "pendiente");
  assert.equal(rows[0].mp_payment_id, null);
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
});

interface PreferenciaSuscripcion {
  external_reference: string;
  notification_url: string;
  metadata: { local_id: number; pago_suscripcion_id: number };
  items: Array<{ unit_price: number; currency_id: string }>;
}

test("crear suscripción: cuenta global, URL exclusiva y un intento persistido antes de MP", async (t) => {
  const calls: Array<{ authorization: string | null; payload: PreferenciaSuscripcion }> = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), "https://api.mercadopago.com/checkout/preferences/");
    assert.equal(init?.method, "POST");
    const payload = JSON.parse(String(init?.body)) as PreferenciaSuscripcion;
    calls.push({ authorization: new Headers(init?.headers).get("Authorization"), payload });
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT external_reference, preference_id, estado FROM pagos_suscripcion WHERE id = ? AND local_id = ?",
      [payload.metadata.pago_suscripcion_id, localId]
    );
    assert.equal(rows[0].external_reference, payload.external_reference);
    assert.equal(rows[0].preference_id, null);
    assert.equal(rows[0].estado, "pendiente");
    return globalThis.Response.json({ id: "pref-suscripcion-global", init_point: "https://checkout.test/suscripcion" });
  });

  const result = await suscripcionService.generarPreference(localId);
  assert.equal(result.link, "https://checkout.test/suscripcion");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.notEqual(calls[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(calls[0].payload.notification_url, "https://backend.test/api/pagos/webhook/suscripciones");
  assert.ok(calls[0].payload.external_reference.startsWith(`suscripcion-${localId}-`));
  assert.equal(calls[0].payload.metadata.local_id, localId);
  assert.equal(calls[0].payload.items[0].unit_price, 100);
  assert.equal(calls[0].payload.items[0].currency_id, "ARS");
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT preference_id FROM pagos_suscripcion WHERE local_id = ?", [localId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].preference_id, "pref-suscripcion-global");
});

test("crear suscripción: token local ausente no impide el cobro global", async (t) => {
  await pool.query("UPDATE locales SET mp_access_token = NULL WHERE id = ?", [localId]);
  let authorization: string | null = null;
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return globalThis.Response.json({ id: "pref-suscripcion-sin-local", init_point: "https://checkout.test/suscripcion" });
  });
  await suscripcionService.generarPreference(localId);
  assert.equal(authorization, `Bearer ${GLOBAL_TOKEN}`);
});

test("crear suscripción: sin global nunca utiliza el token del local ni inserta un intento", async (t) => {
  delete process.env.MP_ACCESS_TOKEN;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No debe llamarse MP sin credencial global");
  });
  await assert.rejects(suscripcionService.generarPreference(localId), /token global/);
  assert.equal(fetch.mock.callCount(), 0);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM pagos_suscripcion WHERE local_id = ?", [localId]);
  assert.equal(rows.length, 0);
});

test("crear suscripción: credencial global se toma al generar, no de un cliente cacheado al importar", async (t) => {
  process.env.MP_ACCESS_TOKEN = "TOKEN_GLOBAL_RENOVADO_FICTICIO";
  let authorization: string | null = null;
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return globalThis.Response.json({ id: "pref-suscripcion-renovada", init_point: "https://checkout.test/suscripcion" });
  });
  await suscripcionService.generarPreference(localId);
  assert.equal(authorization, "Bearer TOKEN_GLOBAL_RENOVADO_FICTICIO");
});

test("crear suscripción: configuración de URL inválida o local inexistente no crea preferencias", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No debe consultarse MP");
  });
  process.env.BACKEND_URL = "https://backend.test/?dato=privado";
  await assert.rejects(suscripcionService.generarPreference(localId), /BACKEND_URL/);
  process.env.BACKEND_URL = "https://backend.test/";
  await assert.rejects(suscripcionService.generarPreference(2147483647), /Local no encontrado/);
  assert.equal(fetch.mock.callCount(), 0);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM pagos_suscripcion WHERE local_id = ?", [localId]);
  assert.equal(rows.length, 0);
});

test("crear suscripción: error SDK no se imprime ni se devuelve al cliente con credenciales", async (t) => {
  t.mock.method(globalThis, "fetch", async () => globalThis.Response.json({
    status: 400, message: `Error simulado ${GLOBAL_TOKEN}`, request: { token: GLOBAL_TOKEN },
  }, { status: 400 }));
  const result = { statusCode: 200, body: "" };
  const response = {
    status(code: number) { result.statusCode = code; return this; },
    json(body: unknown) { result.body = JSON.stringify(body); return this; },
  };
  await crearLinkSuscripcion({ user: { localId } } as unknown as Request, response as unknown as Response);
  assert.equal(result.statusCode, 500);
  assert.ok(!result.body.includes(GLOBAL_TOKEN));
  assert.ok(!JSON.stringify(erroresCreacion).includes(GLOBAL_TOKEN));
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT estado, preference_id FROM pagos_suscripcion WHERE local_id = ?", [localId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estado, "pendiente");
  assert.equal(rows[0].preference_id, null);
});

test("compatibilidad integrada: histórico y receptor nuevo renuevan el mismo pago global una sola vez", async (t) => {
  const ref = await crearIntento();
  const mpId = nuevoPagoMp();
  const authorizations: Array<string | null> = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), `https://api.mercadopago.com/v1/payments/${mpId}`);
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return globalThis.Response.json({ id: Number(mpId), status: "approved", external_reference: ref });
  });
  for (const handler of [webhook, webhookSuscripcion, webhook]) {
    const result = { statusCode: 200, body: "" };
    const response = {
      status(code: number) { result.statusCode = code; return this; },
      send(body: string) { result.body = body; return this; },
    };
    await handler({ body: { type: "payment", data: { id: mpId } }, query: {} } as unknown as Request,
      response as unknown as Response);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, "OK");
    assert.equal((await leerLocal()).dias, 30);
  }
  assert.ok(authorizations.every((authorization) => authorization === `Bearer ${GLOBAL_TOKEN}`));
  assert.equal(whatsappCalls, 0);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM pagos WHERE local_id = ?", [localId]);
  assert.equal(rows.length, 0, "Las suscripciones no deben crear o modificar pagos de turnos");
});

test("compatibilidad integrada: referencia antigua sin intento verificable no renueva por adivinación", async (t) => {
  const mpId = nuevoPagoMp();
  t.mock.method(globalThis, "fetch", async () => globalThis.Response.json({
    id: Number(mpId), status: "approved", external_reference: `suscripcion-${localId}`,
  }));
  const result = { statusCode: 200 };
  const response = {
    status(code: number) { result.statusCode = code; return this; },
    send() { return this; },
  };
  await webhook({ body: { type: "payment", data: { id: mpId } }, query: {} } as unknown as Request,
    response as unknown as Response);
  assert.equal(result.statusCode, 200);
  assert.equal((await leerLocal()).estado, ESTADO_INICIAL);
  assert.equal((await leerLocal()).venc, null);
  assert.equal(whatsappCalls, 0);
});
