import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Response } from "express";
import { evolutionClient } from "./evolution.client";
import { sendWhatsApp } from "./whatsapp.provider";
import { conectarWhatsApp, estadoWhatsApp } from "../whatsapp.controller";

const PHONE = "5491198765432";
const MESSAGE = "Magic link https://app.example/acceso#token=FAKE_MAGIC_TOKEN";
const TOKEN = "FAKE_EVOLUTION_API_KEY";
const RESPONSE_SECRET = "FAKE_RESPONSE_SECRET";
const QR_SECRET = "FAKE_QR_SECRET";

function captureLogs(t: TestContext) {
  const entries: unknown[][] = [];
  for (const method of ["log", "info", "warn", "error"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { entries.push(args); });
  }
  return entries;
}

function fakeResponse() {
  const result: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const response = {
    status(code: number) { result.statusCode = code; return response; },
    json(body: unknown) { result.body = body; return response; },
  };
  return { result, response: response as unknown as Response };
}

function fakeAuthRequest(localId: number) {
  return { params: { localId: String(localId) }, user: { userId: 1, localId } };
}

test("sendWhatsApp mantiene contrato y no registra destino ni mensaje en éxito", async t => {
  const logs = captureLogs(t);
  let requestArgs: unknown[] = [];
  t.mock.method(evolutionClient, "post", async (url: string, data?: unknown) => {
    requestArgs = [url, data];
    return { data: { message: "sent" } } as never;
  });

  await sendWhatsApp(PHONE, MESSAGE, "42");

  assert.deepEqual(requestArgs, ["/message/sendText/42", {
    number: PHONE,
    textMessage: { text: MESSAGE },
  }]);
  assert.deepEqual(logs, []);
});

test("sendWhatsApp sanitiza el log de error y propaga el mismo rechazo", async t => {
  const logs = captureLogs(t);
  const failure = Object.assign(new Error(`fallo: ${PHONE} ${MESSAGE} ${TOKEN}`), {
    code: "ECONNABORTED",
    response: { status: 502, data: { phone: PHONE, message: MESSAGE, token: RESPONSE_SECRET } },
    config: { url: `/send/${PHONE}?token=${TOKEN}`, headers: { apikey: TOKEN }, data: MESSAGE },
  });
  t.mock.method(evolutionClient, "post", async () => { throw failure; });

  await assert.rejects(sendWhatsApp(PHONE, MESSAGE, "42"), error => error === failure);

  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], ["Evolution request failed", {
    provider: "evolution", operation: "sendText", instance: "42", status: 502, code: "ECONNABORTED",
  }]);
  const renderedLogs = JSON.stringify(logs);
  for (const secret of [PHONE, MESSAGE, TOKEN, RESPONSE_SECRET, "apikey", "config", "url"]) {
    assert.equal(renderedLogs.includes(secret), false, `logger no incluye ${secret}`);
  }
});

test("sendWhatsApp no registra códigos de error no reconocidos", async t => {
  const logs = captureLogs(t);
  const failure = Object.assign(new Error("no registrar"), {
    code: "FAKE_SECRET_TOKEN",
    response: { status: 502, data: { token: TOKEN } },
  });
  t.mock.method(evolutionClient, "post", async () => { throw failure; });

  await assert.rejects(sendWhatsApp(PHONE, MESSAGE, "42"), error => error === failure);

  assert.deepEqual(logs, [["Evolution request failed", {
    provider: "evolution", operation: "sendText", instance: "42", status: 502,
  }]]);
  assert.equal(JSON.stringify(logs).includes("FAKE_SECRET_TOKEN"), false);
});

test("conectarWhatsApp no filtra error de create/connect ni el QR; mantiene respuesta funcional", async t => {
  const logs = captureLogs(t);
  const createFailure = Object.assign(new Error(`create phone=${PHONE} token=${TOKEN}`), {
    code: "ERR_BAD_REQUEST",
    response: { status: 400, data: { response: { message: [`already in use ${PHONE} ${TOKEN}`] }, token: RESPONSE_SECRET } },
    config: { headers: { apikey: TOKEN }, data: MESSAGE },
  });
  const connectFailure = Object.assign(new Error(`QR ${MESSAGE} ${TOKEN}`), {
    code: "ERR_BAD_RESPONSE",
    response: { status: 503, data: { qr: RESPONSE_SECRET, message: MESSAGE, phone: PHONE } },
    config: { url: `/connect/${PHONE}`, headers: { apikey: TOKEN } },
  });
  t.mock.method(evolutionClient, "post", async () => { throw createFailure; });
  t.mock.method(evolutionClient, "get", async () => { throw connectFailure; });
  const { result, response } = fakeResponse();

  await conectarWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof conectarWhatsApp>[0], response);

  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.body, { error: "Error obteniendo QR" });
  assert.deepEqual(logs, [
    ["Evolution request failed", { provider: "evolution", operation: "createInstance", instance: "42", status: 400, code: "ERR_BAD_REQUEST" }],
    ["Evolution instance already exists; continuing connection", { provider: "evolution", operation: "createInstance", instance: "42", status: 400 }],
    ["Evolution request failed", { provider: "evolution", operation: "connectInstance", instance: "42", status: 503, code: "ERR_BAD_RESPONSE" }],
  ]);
  const renderedLogs = JSON.stringify(logs);
  for (const secret of [PHONE, MESSAGE, TOKEN, RESPONSE_SECRET, "apikey", "config", "url", "qr"]) {
    assert.equal(renderedLogs.includes(secret), false, `logger no incluye ${secret}`);
  }
});

test("conectarWhatsApp mantiene el QR en la respuesta funcional, nunca en logs", async t => {
  const logs = captureLogs(t);
  t.mock.method(evolutionClient, "post", async () => ({ data: { qrcode: { base64: QR_SECRET } } }) as never);
  t.mock.method(evolutionClient, "get", async () => ({ data: { base64: QR_SECRET } }) as never);
  const { result, response } = fakeResponse();

  await conectarWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof conectarWhatsApp>[0], response);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { qr: QR_SECRET });
  assert.deepEqual(logs, []);
  assert.equal(JSON.stringify(logs).includes(QR_SECRET), false);
});

test("connectionState conserva respuesta funcional y no registra error crudo", async t => {
  const logs = captureLogs(t);
  const failure = Object.assign(new Error(`${PHONE} ${MESSAGE} ${TOKEN}`), {
    code: "ERR_BAD_RESPONSE",
    response: { status: 503, data: { phone: PHONE, token: TOKEN, message: MESSAGE } },
    config: { headers: { apikey: TOKEN } },
  });
  t.mock.method(evolutionClient, "get", async () => { throw failure; });
  const { result, response } = fakeResponse();

  await estadoWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof estadoWhatsApp>[0], response);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { conectado: false, estado: "close" });
  assert.deepEqual(logs, []);
});

test("connectionState conserva estado conectado sin logging adicional", async t => {
  const logs = captureLogs(t);
  t.mock.method(evolutionClient, "get", async () => ({ data: { instance: { state: "open" }, token: TOKEN } }) as never);
  const { result, response } = fakeResponse();

  await estadoWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof estadoWhatsApp>[0], response);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { conectado: true, estado: "open" });
  assert.deepEqual(logs, []);
});
