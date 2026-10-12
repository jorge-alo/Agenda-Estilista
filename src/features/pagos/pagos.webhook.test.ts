import assert from "node:assert/strict";
import Module from "node:module";
import { once } from "node:events";
import { request } from "node:http";
import { after, afterEach, beforeEach, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { Request, Response as ExpressResponse } from "express";
import type { ResultadoPagoTurno } from "./pagos.service";
import type { ResultadoPagoSuscripcion } from "../suscripcion/suscripcion.pagos";
import type { TurnoNotificationData } from "../notifications/domain/notification.types";

const PAYMENT_ID = "123456";
const GLOBAL_TOKEN = "TOKEN_GLOBAL_FICTICIO";
const LOCAL_TOKEN = "TOKEN_LOCAL_FICTICIO";
const PAGO_ID = 11;
const TURNO_ID = 12;
const LOCAL_ID = 5;

let sqlCalls = 0;
let whatsappCalls = 0;
const subscriptionCalls: unknown[] = [];
let subscriptionResult: ResultadoPagoSuscripcion = "renovada";
let subscriptionError: unknown = null;
let permitirWhatsApp = false;
let whatsappError: unknown = null;
const whatsappArgs: TurnoNotificationData[] = [];
const trace: string[] = [];
const savedModules = new Map<string, NodeModule | undefined>();

function replaceModule(specifier: string, exports: object) {
  const id = require.resolve(specifier);
  savedModules.set(id, require.cache[id]);
  const stub = new Module(id);
  stub.filename = id;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[id] = stub;
}

// Se sustituyen antes de importar el service/controller: db.ts carga .env
// y abre una conexión al importarse. Estas pruebas no ejecutan ese módulo.
replaceModule("../../config/db", {
  pool: {
    query: () => {
      sqlCalls++;
      throw new Error("SQL no permitido en estas pruebas aisladas");
    },
    getConnection: () => {
      sqlCalls++;
      throw new Error("Conexión a BD no permitida en estas pruebas aisladas");
    },
  },
});
replaceModule("../notifications/application/sendWhatsAppNotification", {
  sendTurnoConfirmado: async (data: TurnoNotificationData) => {
    whatsappCalls++;
    whatsappArgs.push(data);
    trace.push("whatsapp");
    if (!permitirWhatsApp) throw new Error("WhatsApp no permitido en este caso de prueba");
    if (whatsappError) throw whatsappError;
  },
});
replaceModule("../suscripcion/suscripcion.pagos", {
  procesarPagoSuscripcion: async (params: unknown) => {
    subscriptionCalls.push(params);
    if (subscriptionError) throw subscriptionError;
    return subscriptionResult;
  },
});

const { pagosService, SenaYaAprobadaError } = require("./pagos.service") as typeof import("./pagos.service");
const { webhook, webhookTurno, webhookSuscripcion, normalizarPaymentId, crearLinkPago } =
  require("./pagos.controller") as typeof import("./pagos.controller");
const { default: pagosRouter } = require("./pagos.route") as typeof import("./pagos.route");

interface PreferencePayload {
  items: Array<{ unit_price: number }>;
  notification_url: string;
  external_reference: string;
  metadata: { turno_id: number; local_id: number; pago_id: number; tipo: string };
}
const requests: Array<{ url: string; authorization: string | null; payload?: PreferencePayload }> = [];
const errorLogs: unknown[][] = [];
const warningLogs: unknown[][] = [];
const contextCalls: number[] = [];
const processingCalls: Parameters<typeof pagosService.procesarPagoTurno>[0][] = [];
const confirmationCalls: Array<{ turnoId: number; localId: number }> = [];
let contextError: unknown = null;
let processingError: unknown = null;
let confirmationError: unknown = null;
let contextResponse: Awaited<ReturnType<typeof pagosService.obtenerContextoPago>>;
let aprobarSenaEnLecturaFinal = false;
let confirmationResponse: Awaited<ReturnType<typeof pagosService.obtenerDatosConfirmacionTurno>>;
let processingResult: ResultadoPagoTurno;
const turnoParaPagoCalls: Array<{ turnoId: number; localId: number }> = [];
const registrationCalls: Parameters<typeof pagosService.registrarIntentoPago>[0][] = [];
const linkingCalls: Array<{ pagoId: number; localId: number; preferenceId: string }> = [];
let turnoParaPagoResponse: Awaited<ReturnType<typeof pagosService.obtenerTurnoParaPago>>;
let registrationError: unknown = null;
let linkingError: unknown = null;
let mpBody: Record<string, unknown>;
let mpHttpStatus: number;

function resultadoTurno(resultado: ResultadoPagoTurno["resultado"], changes: Partial<ResultadoPagoTurno> = {}): ResultadoPagoTurno {
  return {
    resultado, motivo: null, pagoId: PAGO_ID, turnoId: TURNO_ID, localId: LOCAL_ID,
    mpPaymentId: PAYMENT_ID, mpPaymentIdPersistido: PAYMENT_ID, turnoPagoId: PAGO_ID,
    notificarWhatsApp: false, requiereConciliacion: false, turnoCancelado: false,
    ...changes,
  };
}

function prepararPagoTurno() {
  mpBody = {
    id: Number(PAYMENT_ID), status: "approved", status_detail: "accredited",
    external_reference: `turno-${TURNO_ID}-pago-${PAGO_ID}`,
    transaction_amount: 30, currency_id: "ARS",
  };
}

function prepararPagoSuscripcion() {
  mpBody = {
    id: Number(PAYMENT_ID), status: "approved",
    external_reference: "suscripcion-5-12345678-1234-4123-8123-123456789abc",
  };
}

beforeEach((t) => {
  assert.ok("mock" in t);
  sqlCalls = 0;
  whatsappCalls = 0;
  subscriptionCalls.length = 0;
  requests.length = 0;
  errorLogs.length = 0;
  warningLogs.length = 0;
  contextCalls.length = 0;
  processingCalls.length = 0;
  confirmationCalls.length = 0;
  whatsappArgs.length = 0;
  trace.length = 0;
  turnoParaPagoCalls.length = 0;
  registrationCalls.length = 0;
  linkingCalls.length = 0;
  registrationError = null;
  linkingError = null;
  permitirWhatsApp = false;
  whatsappError = null;
  subscriptionResult = "renovada";
  subscriptionError = null;
  contextError = null;
  aprobarSenaEnLecturaFinal = false;
  processingError = null;
  confirmationError = null;
  contextResponse = {
    id: PAGO_ID, turno_id: TURNO_ID, local_id: LOCAL_ID, preference_id: null,
    monto: "30.00", tipo: "seña", estado: "pendiente", mp_payment_id: null,
    mp_status: null, mp_status_detail: null, turno_estado: "pendiente_pago",
    turno_pago_id: PAGO_ID, mp_access_token: LOCAL_TOKEN, sena_aprobada_id: null,
  } as NonNullable<typeof contextResponse>;
  confirmationResponse = {
    clienteNombre: "Cliente de prueba", clienteTelefono: "01100000000",
    fecha: "2099-01-01", hora: "10:00:00", servicioNombre: "Servicio de prueba",
    localNombre: "Local de prueba", localTelefono: "01100000001", localId: LOCAL_ID,
  } as NonNullable<typeof confirmationResponse>;
  processingResult = resultadoTurno("estado_no_final");
  turnoParaPagoResponse = {
    id: TURNO_ID, nombre: "Servicio de prueba", precio: "100.00", slug: "local-h5",
    mp_access_token: LOCAL_TOKEN, estado: "pendiente_pago",
  } as NonNullable<typeof turnoParaPagoResponse>;
  mpHttpStatus = 200;
  mpBody = { id: Number(PAYMENT_ID), status: "approved", external_reference: "otra-referencia" };

  // Solo se simula el entorno del proceso de tests; se restaura tras cada caso.
  t.mock.property(process, "env", {
    MP_ACCESS_TOKEN: GLOBAL_TOKEN, BACKEND_URL: "https://backend.test/", FRONTEND_URL: "https://frontend.test/",
    JWT_SECRET: "SECRETO_JWT_FICTICIO_SOLO_TESTS",
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warningLogs.push(args);
  });
  t.mock.method(console, "error", (...args: unknown[]) => {
    errorLogs.push(args);
  });
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    trace.push("mp");
    const captured: typeof requests[number] = {
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
    };
    if (init?.method === "POST") captured.payload = JSON.parse(String(init.body)) as PreferencePayload;
    requests.push(captured);
    return Response.json(mpBody, { status: mpHttpStatus });
  });
  t.mock.method(pagosService, "obtenerContextoPago", async (pagoId: number) => {
    trace.push("contexto");
    contextCalls.push(pagoId);
    if (contextError) throw contextError;
    if (aprobarSenaEnLecturaFinal && contextCalls.length === 2 && contextResponse) {
      contextResponse.sena_aprobada_id = 9;
    }
    return pagoId === PAGO_ID ? contextResponse : null;
  });
  t.mock.method(pagosService, "procesarPagoTurno", async (params: Parameters<typeof pagosService.procesarPagoTurno>[0]) => {
    trace.push("procesar");
    processingCalls.push(params);
    if (processingError) throw processingError;
    assert.ok(contextResponse);
    const validation = pagosService.validarPagoDelIntento(contextResponse, params.payment, params.paymentId);
    if (!validation.valido) return resultadoTurno("pago_invalido", { motivo: validation.motivo });
    return processingResult;
  });
  t.mock.method(pagosService, "obtenerDatosConfirmacionTurno", async (turnoId: number, localId: number) => {
    trace.push("datos");
    confirmationCalls.push({ turnoId, localId });
    if (confirmationError) throw confirmationError;
    return confirmationResponse;
  });
  t.mock.method(pagosService, "obtenerTurnoParaPago", async (turnoId: number, localId: number) => {
    turnoParaPagoCalls.push({ turnoId, localId });
    return turnoId === TURNO_ID && localId === LOCAL_ID ? turnoParaPagoResponse : null;
  });
  t.mock.method(pagosService, "registrarIntentoPago", async (data: Parameters<typeof pagosService.registrarIntentoPago>[0]) => {
    registrationCalls.push(data);
    if (registrationError) throw registrationError;
    assert.ok(contextResponse);
    const monto = Number(data.monto.toFixed(2));
    contextResponse.monto = monto.toFixed(2);
    contextResponse.tipo = data.tipo;
    return { pagoId: PAGO_ID, monto };
  });
  t.mock.method(pagosService, "vincularPreference", async (pagoId: number, localId: number, preferenceId: string) => {
    linkingCalls.push({ pagoId, localId, preferenceId });
    if (linkingError) throw linkingError;
    assert.ok(contextResponse);
    contextResponse.preference_id = preferenceId;
  });
});

afterEach(() => {
  assert.equal(sqlCalls, 0, "No deben ejecutarse operaciones de base de datos");
  if (!permitirWhatsApp) assert.equal(whatsappCalls, 0, "No debe intentarse WhatsApp en este caso");
});

after(() => {
  for (const [id, previous] of savedModules) {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  }
});

type Handler = (req: Request, res: ExpressResponse) => Promise<unknown>;

async function invokeWebhook(
  body: Record<string, unknown>, handler: Handler = webhook, query: Record<string, unknown> = {},
  user?: { localId: number }
) {
  const result = { statusCode: 200, body: "" };
  const response = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    send(payload: string) {
      trace.push("ack");
      result.body = payload;
      return this;
    },
    json(payload: unknown) {
      result.body = JSON.stringify(payload);
      return this;
    },
  };

  await handler({ body, query, user } as unknown as Request, response as unknown as ExpressResponse);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return result;
}

test("service: consulta con el token explícito, aunque exista un global distinto", async () => {
  const payment = await pagosService.obtenerPaymentInfo(PAYMENT_ID, LOCAL_TOKEN);

  assert.equal(payment.id, Number(PAYMENT_ID));
  assert.equal(payment.status, "approved");
  assert.deepEqual(requests, [{
    url: `https://api.mercadopago.com/v1/payments/${PAYMENT_ID}`,
    authorization: `Bearer ${LOCAL_TOKEN}`,
  }]);
});

test("service: funciona sin token global cuando recibe una credencial explícita", async () => {
  delete process.env.MP_ACCESS_TOKEN;

  await pagosService.obtenerPaymentInfo(PAYMENT_ID, LOCAL_TOKEN);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
});

test("service: no reutiliza la credencial de una consulta anterior", async () => {
  await pagosService.obtenerPaymentInfo(PAYMENT_ID, LOCAL_TOKEN);
  await pagosService.obtenerPaymentInfo(PAYMENT_ID, GLOBAL_TOKEN);

  assert.deepEqual(requests.map((request) => request.authorization), [
    `Bearer ${LOCAL_TOKEN}`,
    `Bearer ${GLOBAL_TOKEN}`,
  ]);
});

test("service: rechaza token ausente, vacío o en blanco sin usar el global", async () => {
  for (const token of [undefined, "", "   "]) {
    await assert.rejects(
      pagosService.obtenerPaymentInfo(PAYMENT_ID, token as string),
      /Access Token explícito/
    );
  }

  assert.equal(requests.length, 0);
});

test("service: propaga el error de MP y no lo transforma en null ni prueba otro token", async () => {
  mpHttpStatus = 404;
  mpBody = { status: 404, error: "not_found", message: "Payment not found" };

  await assert.rejects(
    pagosService.obtenerPaymentInfo(PAYMENT_ID, LOCAL_TOKEN),
    (error: unknown) => {
      assert.deepEqual(error, mpBody);
      return true;
    }
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(errorLogs.length, 0);
});

test("histórico: consulta solo la cuenta global y reconoce una referencia ajena sin procesarla", async () => {
  const result = await invokeWebhook({ type: "payment", data: { id: PAYMENT_ID } });

  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.equal(subscriptionCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(contextCalls.length, 0);
});

test("histórico: conserva los formatos alternativos de notificación", async () => {
  for (const body of [
    { topic: "payment", resource: `https://api.mercadopago.com/v1/payments/${PAYMENT_ID}` },
    { action: "payment.created", data: { id: PAYMENT_ID } },
  ]) {
    const result = await invokeWebhook(body);
    assert.deepEqual(result, { statusCode: 200, body: "OK" });
  }

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url.endsWith(`/v1/payments/${PAYMENT_ID}`)));
  assert.ok(requests.every((request) => request.authorization === `Bearer ${GLOBAL_TOKEN}`));
});

test("histórico: sin global responde 500 y no busca una credencial local", async () => {
  delete process.env.MP_ACCESS_TOKEN;

  const result = await invokeWebhook({ type: "payment", data: { id: PAYMENT_ID } });

  assert.deepEqual(result, { statusCode: 500, body: "Error" });
  assert.equal(requests.length, 0);
});

test("histórico: MP 404 se reconoce sin inferir local, repetir con otros tokens ni loguear secretos", async () => {
  mpHttpStatus = 404;
  mpBody = {
    status: 404,
    message: `Error simulado con credencial ${GLOBAL_TOKEN}`,
    request: { headers: { Authorization: `Bearer ${GLOBAL_TOKEN}` } },
  };

  const result = await invokeWebhook({ type: "payment", data: { id: PAYMENT_ID } });

  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.equal(errorLogs.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(contextCalls.length, 0);
  assert.equal(subscriptionCalls.length, 0);
  assert.ok(JSON.stringify(warningLogs).includes("revisión específica pendiente"));
  assert.ok(!JSON.stringify(warningLogs).includes(GLOBAL_TOKEN));
  assert.ok(!JSON.stringify(errorLogs).includes(GLOBAL_TOKEN));
});

test("histórico: ignora IDs inválidos sin consultar MP", async () => {
  const result = await invokeWebhook({ type: "payment", data: { id: "no-es-un-id" } });

  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests.length, 0);
});

test("histórico: mantiene la delegación de suscripciones tras consultar con el global", async () => {
  const externalReference = "suscripcion-5-12345678-1234-4123-8123-123456789abc";
  mpBody = { id: Number(PAYMENT_ID), status: "approved", external_reference: externalReference };

  const result = await invokeWebhook({ type: "payment", data: { id: PAYMENT_ID } });

  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.deepEqual(subscriptionCalls, [{
    externalReference,
    status: "approved",
    mpPaymentId: PAYMENT_ID,
  }]);
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(confirmationCalls.length, 0);
});

function normalizar(body: unknown, query: Record<string, unknown> = {}) {
  return normalizarPaymentId({ body, query } as unknown as Request);
}

const evento = () => ({ type: "payment", data: { id: PAYMENT_ID } });
const queryTurno = () => ({ pago_id: String(PAGO_ID) });

test("normalizar: admite Webhook, IPN, action y notificaciones solo por query", () => {
  for (const [body, query] of [
    [evento(), {}],
    [{ type: "payment", data: { id: Number(PAYMENT_ID) } }, {}],
    [{ topic: "payment", resource: `https://api.mercadopago.com/v1/payments/${PAYMENT_ID}` }, {}],
    [{ action: "payment.created", data: { id: PAYMENT_ID } }, {}],
    [{ action: "payment.updated", data: { id: PAYMENT_ID } }, {}],
    [{}, { type: "payment", "data.id": PAYMENT_ID }],
    [{}, { topic: "payment", id: PAYMENT_ID }],
    [{}, { type: "payment", data: { id: PAYMENT_ID } }],
  ] as Array<[unknown, Record<string, unknown>]>) {
    assert.equal(normalizar(body, query), PAYMENT_ID);
  }
});

test("normalizar: comprueba todas las fuentes presentes y no confunde el ID del evento", () => {
  assert.equal(normalizar({ ...evento(), id: "987654", user_id: 999 }, {
    type: "payment", "data.id": PAYMENT_ID, id: PAYMENT_ID,
  }), PAYMENT_ID);
  assert.equal(normalizar(evento(), { "data.id": "654321" }), null);
  assert.equal(normalizar({ ...evento(), resource: "https://api.mercadopago.com/v1/payments/654321" }), null);
});

test("normalizar: rechaza tipos ajenos, IDs ambiguos y valores no canónicos", () => {
  assert.equal(normalizar({ type: "merchant_order", data: { id: PAYMENT_ID } }), null);
  assert.equal(normalizar(evento(), { type: "merchant_order" }), null);
  assert.equal(normalizar({ data: { id: PAYMENT_ID } }), null);
  for (const id of [undefined, null, "", "0", 0, -1, 1.5, "0123456", " 123456", "1e5", "abc", [PAYMENT_ID], {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizar({ type: "payment", data: { id } }), null);
  }
  assert.equal(normalizar(evento(), { "data.id": [PAYMENT_ID, PAYMENT_ID] }), null);
  assert.equal(normalizar({ type: "payment", data: "inválido" }, { "data.id": PAYMENT_ID }), null);
});

test("turnos: resuelve intento y token local, procesa y confirma sin utilizar el global", async () => {
  prepararPagoTurno();
  processingResult = resultadoTurno("confirmado", { notificarWhatsApp: true });
  permitirWhatsApp = true;
  const result = await invokeWebhook({ ...evento(), local_id: 999, user_id: 999 }, webhookTurno, {
    ...queryTurno(), local_id: "999",
  });

  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.deepEqual(contextCalls, [PAGO_ID]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(processingCalls.length, 1);
  assert.equal(processingCalls[0].pagoId, PAGO_ID);
  assert.equal(processingCalls[0].paymentId, PAYMENT_ID);
  assert.equal(processingCalls[0].payment.external_reference, `turno-${TURNO_ID}-pago-${PAGO_ID}`);
  assert.deepEqual(confirmationCalls, [{ turnoId: TURNO_ID, localId: LOCAL_ID }]);
  assert.equal(whatsappCalls, 1);
  assert.equal(whatsappArgs[0].localId, String(LOCAL_ID));
  assert.equal(whatsappArgs[0].clienteTelefono, "5491100000000");
  assert.deepEqual(trace, ["contexto", "mp", "procesar", "ack", "datos", "whatsapp"]);
  assert.equal(subscriptionCalls.length, 0);
});

test("turnos: funciona sin token global si el local tiene credencial", async () => {
  delete process.env.MP_ACCESS_TOKEN;
  prepararPagoTurno();
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
});

test("turnos: ausencia de credencial local devuelve 500 sin fallback global", async () => {
  assert.ok(contextResponse);
  for (const token of [null, "", "   "]) {
    contextResponse.mp_access_token = token;
    const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
    assert.deepEqual(result, { statusCode: 500, body: "Error" });
  }
  assert.equal(requests.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(subscriptionCalls.length, 0);
});

test("turnos: evento ambiguo se reconoce sin consultar contexto ni MP", async () => {
  const result = await invokeWebhook(evento(), webhookTurno, { ...queryTurno(), "data.id": "654321" });
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(contextCalls.length, 0);
  assert.equal(requests.length, 0);
});

test("turnos: pago_id ausente, repetido o inválido se ignora sin consultar MP", async () => {
  for (const pago_id of [undefined, "0", "-1", "1.5", "abc", "0011", [String(PAGO_ID)], {}, "9007199254740992"]) {
    const result = await invokeWebhook(evento(), webhookTurno, { pago_id });
    assert.deepEqual(result, { statusCode: 200, body: "OK" });
  }
  assert.equal(contextCalls.length, 0);
  assert.equal(requests.length, 0);
});

test("turnos: intento inexistente o inconsistente se reconoce sin consultar MP", async () => {
  contextResponse = null;
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests.length, 0);
  assert.equal(processingCalls.length, 0);
});

test("turnos: un pago de suscripción no se procesa ni se deriva al otro receptor", async () => {
  prepararPagoSuscripcion();
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(processingCalls.length, 1);
  assert.equal(subscriptionCalls.length, 0);
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.ok(JSON.stringify(warningLogs).includes("referencia_no_coincide"));
});

for (const resultado of [
  "pago_rechazado", "pago_cancelado", "registrado_sin_confirmar", "ya_procesado",
  "conflicto_de_pago", "estado_no_final", "pago_invalido", "intento_no_encontrado", "relacion_inconsistente",
] as const) {
  test(`turnos: ${resultado} devuelve 200 sin intentar WhatsApp`, async () => {
    prepararPagoTurno();
    processingResult = resultadoTurno(resultado, {
      requiereConciliacion: resultado === "conflicto_de_pago" || resultado === "registrado_sin_confirmar",
    });
    const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
    assert.deepEqual(result, { statusCode: 200, body: "OK" });
    assert.equal(confirmationCalls.length, 0);
    assert.equal(whatsappCalls, 0);
  });
}

test("turnos: resultado confirmado sin señal de notificación no envía WhatsApp", async () => {
  prepararPagoTurno();
  processingResult = resultadoTurno("confirmado", { notificarWhatsApp: false });
  await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.equal(confirmationCalls.length, 0);
});

test("turnos: una señal de notificación en un resultado no confirmado tampoco envía", async () => {
  prepararPagoTurno();
  processingResult = resultadoTurno("ya_procesado", { notificarWhatsApp: true });
  await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.equal(confirmationCalls.length, 0);
});

test("turnos: espera que termine el procesamiento antes de reconocer o notificar", async (t) => {
  prepararPagoTurno();
  permitirWhatsApp = true;
  let completar: () => void = () => {};
  const commitSimulado = new Promise<void>((resolve) => { completar = resolve; });
  t.mock.method(pagosService, "procesarPagoTurno", async () => {
    await commitSimulado;
    trace.push("commit");
    return resultadoTurno("confirmado", { notificarWhatsApp: true });
  });
  const running = invokeWebhook(evento(), webhookTurno, queryTurno());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(confirmationCalls.length, 0);
  assert.equal(whatsappCalls, 0);
  assert.ok(!trace.includes("ack"));
  completar();
  const result = await running;
  assert.equal(result.statusCode, 200);
  assert.ok(trace.indexOf("commit") < trace.indexOf("ack"));
  assert.ok(trace.indexOf("commit") < trace.indexOf("whatsapp"));
});

test("turnos: el ACK no espera la finalización de WhatsApp y su error no cambia HTTP 200", async () => {
  prepararPagoTurno();
  processingResult = resultadoTurno("confirmado", { notificarWhatsApp: true });
  permitirWhatsApp = true;
  whatsappError = new Error(`Error simulado ${LOCAL_TOKEN}`);
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(whatsappCalls, 1);
  assert.ok(trace.indexOf("ack") < trace.indexOf("whatsapp"));
  assert.ok(!JSON.stringify(errorLogs).includes(LOCAL_TOKEN));
});

test("turnos: sin datos de confirmación no intenta WhatsApp y conserva HTTP 200", async () => {
  prepararPagoTurno();
  processingResult = resultadoTurno("confirmado", { notificarWhatsApp: true });
  confirmationResponse = null;
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.equal(result.statusCode, 200);
  assert.equal(confirmationCalls.length, 1);
  assert.equal(whatsappCalls, 0);
});

test("turnos: error al leer datos después de confirmar no genera un reintento del pago", async () => {
  prepararPagoTurno();
  processingResult = resultadoTurno("confirmado", { notificarWhatsApp: true });
  confirmationError = new Error(`Error simulado ${LOCAL_TOKEN}`);
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.equal(result.statusCode, 200);
  assert.equal(whatsappCalls, 0);
  assert.ok(!JSON.stringify(errorLogs).includes(LOCAL_TOKEN));
});

test("turnos: error de MP produce 500 sin procesar, notificar ni exponer credenciales", async () => {
  mpHttpStatus = 404;
  mpBody = { status: 404, message: `Error ${LOCAL_TOKEN} ${GLOBAL_TOKEN}`, headers: { Authorization: LOCAL_TOKEN } };
  const result = await invokeWebhook(evento(), webhookTurno, queryTurno());
  assert.deepEqual(result, { statusCode: 500, body: "Error" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(processingCalls.length, 0);
  assert.ok(!JSON.stringify(errorLogs).includes(LOCAL_TOKEN));
  assert.ok(!JSON.stringify(errorLogs).includes(GLOBAL_TOKEN));
});

test("turnos: error de contexto o procesamiento produce 500 sin notificar", async () => {
  prepararPagoTurno();
  contextError = new Error(`Error SQL simulado ${LOCAL_TOKEN}`);
  assert.equal((await invokeWebhook(evento(), webhookTurno, queryTurno())).statusCode, 500);
  assert.equal(requests.length, 0);
  contextError = null;
  processingError = new Error(`Error SQL simulado ${LOCAL_TOKEN}`);
  assert.equal((await invokeWebhook(evento(), webhookTurno, queryTurno())).statusCode, 500);
  assert.equal(confirmationCalls.length, 0);
  assert.ok(!JSON.stringify(errorLogs).includes(LOCAL_TOKEN));
});

test("suscripciones: usa solo el global y delega exclusivamente en suscripciones", async () => {
  prepararPagoSuscripcion();
  const result = await invokeWebhook({ ...evento(), local_id: LOCAL_ID }, webhookSuscripcion, queryTurno());
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(subscriptionCalls.length, 1);
  assert.equal(whatsappCalls, 0);
});

test("suscripciones: acepta solo query y rechaza discrepancias entre body y query", async () => {
  prepararPagoSuscripcion();
  assert.equal((await invokeWebhook({}, webhookSuscripcion, { type: "payment", "data.id": PAYMENT_ID })).statusCode, 200);
  assert.equal(subscriptionCalls.length, 1);
  assert.equal((await invokeWebhook(evento(), webhookSuscripcion, { "data.id": "654321" })).statusCode, 200);
  assert.equal(subscriptionCalls.length, 1);
  assert.equal(requests.length, 1);
});

test("suscripciones: sin global no usa el token local aunque exista", async () => {
  delete process.env.MP_ACCESS_TOKEN;
  prepararPagoSuscripcion();
  const result = await invokeWebhook(evento(), webhookSuscripcion, queryTurno());
  assert.deepEqual(result, { statusCode: 500, body: "Error" });
  assert.equal(requests.length, 0);
  assert.equal(contextCalls.length, 0);
});

test("suscripciones: pago de turno o Payment ID diferente no se procesa ni se deriva", async () => {
  prepararPagoTurno();
  assert.equal((await invokeWebhook(evento(), webhookSuscripcion)).statusCode, 200);
  prepararPagoSuscripcion();
  mpBody.id = 654321;
  assert.equal((await invokeWebhook(evento(), webhookSuscripcion)).statusCode, 200);
  assert.equal(subscriptionCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(contextCalls.length, 0);
});

for (const resultado of [
  "renovada", "registrada_sin_renovar", "ya_aprobada", "segundo_pago_aprobado",
  "referencia_invalida", "estado_no_final", "intento_no_encontrado", "local_inexistente",
] as const) {
  test(`suscripciones: ${resultado} responde 200 sin WhatsApp ni procesamiento de turnos`, async () => {
    prepararPagoSuscripcion();
    subscriptionResult = resultado;
    assert.equal((await invokeWebhook(evento(), webhookSuscripcion)).statusCode, 200);
    assert.equal(processingCalls.length, 0);
    assert.equal(whatsappCalls, 0);
  });
}

test("suscripciones: errores MP, estado ausente o error SQL responden 500", async () => {
  mpHttpStatus = 404;
  mpBody = { status: 404, message: `Error simulado ${GLOBAL_TOKEN}` };
  assert.equal((await invokeWebhook(evento(), webhookSuscripcion)).statusCode, 500);
  mpHttpStatus = 200;
  prepararPagoSuscripcion();
  delete mpBody.status;
  assert.equal((await invokeWebhook(evento(), webhookSuscripcion)).statusCode, 500);
  prepararPagoSuscripcion();
  subscriptionError = new Error(`Error SQL simulado ${GLOBAL_TOKEN}`);
  assert.equal((await invokeWebhook(evento(), webhookSuscripcion)).statusCode, 500);
  assert.ok(!JSON.stringify(errorLogs).includes(GLOBAL_TOKEN));
});

async function postLocal(port: number, path: string, body: object, headers: Record<string, string> = {}) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("rutas: ambos receptores públicos están montados y el endpoint anterior sigue disponible", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pagos", pagosRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    prepararPagoTurno();
    assert.deepEqual(await postLocal(address.port, `/api/pagos/webhook/turnos?pago_id=${PAGO_ID}`, evento()), { statusCode: 200, body: "OK" });
    assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
    prepararPagoSuscripcion();
    assert.deepEqual(await postLocal(address.port, "/api/pagos/webhook/suscripciones", evento()), { statusCode: 200, body: "OK" });
    assert.equal(requests[1].authorization, `Bearer ${GLOBAL_TOKEN}`);
    mpBody.external_reference = "otra-referencia";
    assert.deepEqual(await postLocal(address.port, "/api/pagos/webhook", evento()), { statusCode: 200, body: "OK" });
    assert.equal(requests[2].authorization, `Bearer ${GLOBAL_TOKEN}`);
    assert.equal((await postLocal(address.port, "/api/pagos/crear-link", {})).statusCode, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function prepararPreference() {
  mpBody = { id: "pref-h5-http", init_point: "https://checkout.test/h5-http" };
}

test("crear-link: usa local del JWT y token/slug/precio de BD, ignorando datos de cuenta del body", async () => {
  prepararPreference();
  const result = await invokeWebhook({
    turnoId: String(TURNO_ID), tipo: "seña", porcentajeSeña: 30,
    local_id: 999, accessToken: GLOBAL_TOKEN, mp_access_token: GLOBAL_TOKEN, slug: "otro-local",
  }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    message: "Link de pago creado exitosamente", link: "https://checkout.test/h5-http", pagoId: PAGO_ID,
  });
  assert.deepEqual(turnoParaPagoCalls, [{ turnoId: TURNO_ID, localId: LOCAL_ID }]);
  assert.deepEqual(registrationCalls, [{ turnoId: TURNO_ID, localId: LOCAL_ID, monto: 30, tipo: "seña" }]);
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(requests[0].payload?.notification_url, `https://backend.test/api/pagos/webhook/turnos?pago_id=${PAGO_ID}`);
  assert.equal(requests[0].payload?.external_reference, `turno-${TURNO_ID}-pago-${PAGO_ID}`);
  assert.deepEqual(requests[0].payload?.metadata, { turno_id: TURNO_ID, local_id: LOCAL_ID, pago_id: PAGO_ID, tipo: "seña" });
  assert.deepEqual(linkingCalls, [{ pagoId: PAGO_ID, localId: LOCAL_ID, preferenceId: "pref-h5-http" }]);
  assert.equal(subscriptionCalls.length, 0);
  assert.equal(processingCalls.length, 0);
});

test("crear-link: sin token local responde 400 aunque exista global y no crea intento", async () => {
  assert.ok(turnoParaPagoResponse);
  turnoParaPagoResponse.mp_access_token = null;
  const result = await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(result.statusCode, 400);
  assert.equal(registrationCalls.length, 0);
  assert.equal(requests.length, 0);
});

test("crear-link: no permite sustituir el local del JWT para cobrar un turno ajeno", async () => {
  const result = await invokeWebhook({ turnoId: TURNO_ID, local_id: LOCAL_ID }, crearLinkPago, {}, { localId: 999 });
  assert.equal(result.statusCode, 404);
  assert.equal(turnoParaPagoCalls[0].localId, 999);
  assert.equal(registrationCalls.length, 0);
  assert.equal(requests.length, 0);
});

test("crear-link: turno cerrado, sin slug o entrada inválida no genera preference", async () => {
  assert.ok(turnoParaPagoResponse);
  for (const estado of ["cancelado", "completado"] as const) {
    turnoParaPagoResponse.estado = estado;
    assert.equal((await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID })).statusCode, 400);
  }
  turnoParaPagoResponse.estado = "pendiente_pago";
  turnoParaPagoResponse.slug = null;
  assert.equal((await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID })).statusCode, 400);
  for (const body of [
    { turnoId: 0 }, { turnoId: [TURNO_ID] }, { turnoId: TURNO_ID, tipo: "suscripcion" },
    { turnoId: TURNO_ID, porcentajeSeña: 0 }, { turnoId: TURNO_ID, porcentajeSeña: "30" },
  ]) {
    assert.equal((await invokeWebhook(body, crearLinkPago, {}, { localId: LOCAL_ID })).statusCode, 400);
  }
  assert.equal(registrationCalls.length, 0);
  assert.equal(requests.length, 0);
});

test("crear-link: permite pago completo de turno activo con cuenta local, sin suscripciones", async () => {
  prepararPreference();
  assert.ok(turnoParaPagoResponse);
  assert.ok(contextResponse);
  turnoParaPagoResponse.estado = "activo";
  contextResponse.turno_estado = "activo";
  const result = await invokeWebhook({ turnoId: TURNO_ID, tipo: "completo" }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(result.statusCode, 200);
  assert.equal(requests[0].payload?.items[0].unit_price, 100);
  assert.equal(requests[0].payload?.metadata.tipo, "completo");
  assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
  assert.equal(subscriptionCalls.length, 0);
});

test("crear-link: fallo de registro o MP responde 500 sin devolver enlaces", async () => {
  prepararPreference();
  registrationError = new Error(`Error SQL simulado ${LOCAL_TOKEN}`);
  const registro = await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(registro.statusCode, 500);
  assert.equal(requests.length, 0);
  registrationError = null;
  mpHttpStatus = 401;
  mpBody = { status: 401, message: `Error MP simulado ${LOCAL_TOKEN}`, request: { token: LOCAL_TOKEN } };
  const mp = await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(mp.statusCode, 500);
  assert.equal(JSON.parse(mp.body).link, undefined);
  assert.equal(linkingCalls.length, 0);
  assert.ok(!JSON.stringify(errorLogs).includes(LOCAL_TOKEN));
});

test("crear-link: MP creado con fallo al vincular conserva evidencia segura y nunca expone init_point", async () => {
  prepararPreference();
  linkingError = new Error(`Error simulado ${LOCAL_TOKEN}`);
  const result = await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(result.statusCode, 500);
  assert.equal(JSON.parse(result.body).link, undefined);
  assert.equal(registrationCalls.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(linkingCalls.length, 1);
  assert.ok(JSON.stringify(errorLogs).includes("vinculacion_preference"));
  assert.ok(JSON.stringify(errorLogs).includes("pref-h5-http"));
  assert.ok(!JSON.stringify(errorLogs).includes(LOCAL_TOKEN));
});

test("crear-link HTTP: autorización real de prueba mantiene el local del JWT en la preferencia", async () => {
  prepararPreference();
  const app = express();
  app.use(express.json());
  app.use("/api/pagos", pagosRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const token = jwt.sign({ localId: LOCAL_ID }, "SECRETO_JWT_FICTICIO_SOLO_TESTS", { expiresIn: "1m" });
    const result = await postLocal(address.port, "/api/pagos/crear-link", {
      turnoId: TURNO_ID, local_id: 999, mp_access_token: GLOBAL_TOKEN,
    }, { Authorization: `Bearer ${token}` });
    assert.equal(result.statusCode, 200);
    assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
    assert.equal(requests[0].payload?.metadata.local_id, LOCAL_ID);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("B2 crear-link: rechazo transaccional de seña aprobada devuelve 409 sin MP ni enlace", async () => {
  prepararPreference();
  registrationError = new SenaYaAprobadaError();
  const result = await invokeWebhook({ turnoId: TURNO_ID, tipo: "seña" }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).codigo, "SENA_YA_APROBADA");
  assert.equal(JSON.parse(result.body).link, undefined);
  assert.equal(requests.length, 0);
  assert.equal(linkingCalls.length, 0);
});

test("B2 crear-link: aprobación detectada después de MP devuelve 409 y conserva el intento vinculado", async () => {
  prepararPreference();
  assert.ok(contextResponse);
  const snapshot = contextResponse;
  aprobarSenaEnLecturaFinal = true;
  const result = await invokeWebhook({ turnoId: TURNO_ID }, crearLinkPago, {}, { localId: LOCAL_ID });
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).link, undefined);
  assert.equal(requests.length, 1);
  assert.equal(linkingCalls.length, 1);
  assert.equal(snapshot.preference_id, "pref-h5-http");
  assert.ok(JSON.stringify(warningLogs).includes("pref-h5-http"));
});

test("histórico: seña antigua visible en cuenta global se ignora sin buscar intento ni modificar turno", async () => {
  mpBody = {
    id: Number(PAYMENT_ID), status: "approved", preference_id: "pref-antigua",
    external_reference: `turno-${TURNO_ID}`, metadata: { local_id: LOCAL_ID, pago_id: PAGO_ID },
  };
  const result = await invokeWebhook({
    ...evento(), user_id: 177407147, local_id: LOCAL_ID, metadata: { local_id: LOCAL_ID },
    external_reference: "suscripcion-falsa-en-body",
  });
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(subscriptionCalls.length, 0);
  assert.equal(confirmationCalls.length, 0);
  assert.equal(whatsappCalls, 0);
});

test("histórico: pago_id identifica contexto de turno y se ignora antes de consultar cualquier cuenta", async () => {
  prepararPagoTurno();
  const result = await invokeWebhook(evento(), webhook, queryTurno());
  assert.deepEqual(result, { statusCode: 200, body: "OK" });
  assert.equal(requests.length, 0);
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(subscriptionCalls.length, 0);
});

test("histórico: discrepancia body/query no provoca consulta, clasificación por user_id ni búsqueda local", async () => {
  const result = await invokeWebhook({ ...evento(), user_id: 177407147 }, webhook, { "data.id": "654321" });
  assert.equal(result.statusCode, 200);
  assert.equal(requests.length, 0);
  assert.equal(contextCalls.length, 0);
});

test("histórico: otros fallos MP y fallos del procesamiento global siguen siendo reintentables", async (t) => {
  let fallarConsulta = true;
  t.mock.method(pagosService, "obtenerPaymentInfo", async () => {
    if (fallarConsulta) {
      throw { status: 503, message: `Error simulado ${GLOBAL_TOKEN}`, request: { token: GLOBAL_TOKEN } };
    }
    return {
      id: Number(PAYMENT_ID), status: "approved",
      external_reference: "suscripcion-5-12345678-1234-4123-8123-123456789abc",
    } as Awaited<ReturnType<typeof pagosService.obtenerPaymentInfo>>;
  });
  assert.equal((await invokeWebhook(evento())).statusCode, 500);
  fallarConsulta = false;
  subscriptionError = { status: 404, message: `Error de procesamiento ${GLOBAL_TOKEN}` };
  assert.equal((await invokeWebhook(evento())).statusCode, 500, "El 404 solo se ignora en la consulta MP histórica");
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.ok(!JSON.stringify(errorLogs).includes(GLOBAL_TOKEN));
});

test("suscripciones nuevas: MP 404 conserva HTTP 500, sin aplicar la excepción histórica", async () => {
  mpHttpStatus = 404;
  mpBody = { status: 404, message: "Payment not found" };
  const result = await invokeWebhook(evento(), webhookSuscripcion);
  assert.equal(result.statusCode, 500);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${GLOBAL_TOKEN}`);
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
});

test("histórico: duplicado global vuelve al procesador idempotente sin confirmar turnos ni notificar", async () => {
  prepararPagoSuscripcion();
  subscriptionResult = "renovada";
  assert.equal((await invokeWebhook(evento())).statusCode, 200);
  subscriptionResult = "ya_aprobada";
  assert.equal((await invokeWebhook(evento())).statusCode, 200);
  assert.equal(subscriptionCalls.length, 2);
  assert.deepEqual(subscriptionCalls[0], subscriptionCalls[1]);
  assert.equal(contextCalls.length, 0);
  assert.equal(processingCalls.length, 0);
  assert.equal(whatsappCalls, 0);
});

test("tres endpoints HTTP: cada receptor respeta su credencial y su dominio sin redirecciones", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pagos", pagosRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    prepararPagoTurno();
    assert.equal((await postLocal(address.port, `/api/pagos/webhook/turnos?pago_id=${PAGO_ID}`, evento())).statusCode, 200);
    assert.equal(requests[0].authorization, `Bearer ${LOCAL_TOKEN}`);
    assert.equal(processingCalls.length, 1);
    assert.equal(subscriptionCalls.length, 0);
    prepararPagoSuscripcion();
    assert.equal((await postLocal(address.port, "/api/pagos/webhook/suscripciones", evento())).statusCode, 200);
    assert.equal(requests[1].authorization, `Bearer ${GLOBAL_TOKEN}`);
    assert.equal(subscriptionCalls.length, 1);
    assert.equal((await postLocal(address.port, "/api/pagos/webhook", evento())).statusCode, 200);
    assert.equal(requests[2].authorization, `Bearer ${GLOBAL_TOKEN}`);
    assert.equal(subscriptionCalls.length, 2);
    const contextsBefore = contextCalls.length;
    const turnsBefore = processingCalls.length;
    prepararPagoTurno();
    mpBody.external_reference = `turno-${TURNO_ID}`;
    assert.equal((await postLocal(address.port, "/api/pagos/webhook", evento())).statusCode, 200);
    assert.equal(requests[3].authorization, `Bearer ${GLOBAL_TOKEN}`);
    assert.equal(subscriptionCalls.length, 2);
    assert.equal(processingCalls.length, turnsBefore);
    assert.equal(contextCalls.length, contextsBefore);
    assert.equal((await postLocal(address.port, `/api/pagos/webhook?pago_id=${PAGO_ID}`, evento())).statusCode, 200);
    assert.equal(requests.length, 4, "El contexto de turno no dispara una consulta global de compatibilidad");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
