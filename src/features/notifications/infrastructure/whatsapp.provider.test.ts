import assert from "node:assert/strict";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import type { Response } from "express";
import { evolutionClient } from "./evolution.client";
import { getPetWhatsAppConnectionState, sendPetWhatsAppWithReceipt, sendWhatsApp } from "./whatsapp.provider";
import { conectarWhatsApp, estadoWhatsApp } from "../whatsapp.controller";

const PHONE = "5491198765432";
const MESSAGE = "Magic link https://app.example/acceso#token=FAKE_MAGIC_TOKEN";
const TOKEN = "FAKE_EVOLUTION_API_KEY";
const RESPONSE_SECRET = "FAKE_RESPONSE_SECRET";
const QR_SECRET = "FAKE_QR_SECRET";

const originalEvolutionVersion = process.env.EVOLUTION_API_VERSION;
beforeEach(() => {
  delete process.env.EVOLUTION_API_VERSION;
});
afterEach(() => {
  if (originalEvolutionVersion === undefined) delete process.env.EVOLUTION_API_VERSION;
  else process.env.EVOLUTION_API_VERSION = originalEvolutionVersion;
});

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
    response: { status: 400, data: { response: { message: ['This name "42" is already in use.'] }, token: RESPONSE_SECRET } },
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

test("PET connection preflight distinguishes close, open and an uncertain response without logging payload", async t => {
  const logs = captureLogs(t);
  t.mock.method(evolutionClient, "get", async (url: string) => {
    assert.equal(url, "/instance/connectionState/42");
    return { data: { instance: { state: "close" }, token: TOKEN } } as never;
  });
  assert.equal(await getPetWhatsAppConnectionState("42"), "closed");
  t.mock.restoreAll();
  const logsOpen = captureLogs(t);
  t.mock.method(evolutionClient, "get", async () => ({ data: { instance: { state: "open" } } }) as never);
  assert.equal(await getPetWhatsAppConnectionState("42"), "open");
  assert.deepEqual(logs, []);
  assert.deepEqual(logsOpen, []);
});

test("PET provider only accepts well-formed key.id on HTTP 2xx, never logs phone or message", async t => {
  const logs = captureLogs(t);
  t.mock.method(evolutionClient, "post", async (url: string, data?: unknown) => {
    assert.deepEqual([url, data], ["/message/sendText/42", {
      number: PHONE, textMessage: { text: MESSAGE },
    }]);
    return { status: 201, data: { key: { id: "EVOLUTION_ID_1" } } } as never;
  });
  assert.equal(await sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), "EVOLUTION_ID_1");
  assert.deepEqual(logs, []);
});

test("PET provider treats malformed 2xx and HTTP error as ambiguous; logs only sanitized metadata", async t => {
  const logs = captureLogs(t);
  t.mock.method(evolutionClient, "post", async () => ({ status: 200, data: { message: "sent" } }) as never);
  assert.equal(await sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), null);
  t.mock.restoreAll();
  const failure = Object.assign(new Error(`${PHONE} ${MESSAGE} ${TOKEN}`), {
    code: "ECONNABORTED", response: { status: 504, data: { token: TOKEN } },
  });
  const logsFailure = captureLogs(t);
  t.mock.method(evolutionClient, "post", async () => { throw failure; });
  await assert.rejects(sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), error => error === failure);
  assert.deepEqual(logs, []);
  assert.deepEqual(logsFailure, [["Evolution request failed", {
    provider: "evolution", operation: "sendText", instance: "42", status: 504, code: "ECONNABORTED",
  }]]);
  assert.equal(JSON.stringify(logsFailure).includes(PHONE), false);
  assert.equal(JSON.stringify(logsFailure).includes(TOKEN), false);
});

for (const version of [undefined, "v1", "v2"] as const) {
  const label = version ?? "default v1";

  test(`${label}: ambos emisores conservan destino, texto y key.id con el JSON correcto`, async t => {
    if (version !== undefined) process.env.EVOLUTION_API_VERSION = version;
    const logs = captureLogs(t);
    const requests: unknown[][] = [];
    t.mock.method(evolutionClient, "post", async (url: string, data?: unknown) => {
      requests.push([url, data]);
      return { status: 201, data: { key: { id: "ACCEPTED_ID" }, status: "PENDING" } } as never;
    });

    assert.equal(await sendWhatsApp(PHONE, MESSAGE, "42"), undefined);
    assert.equal(await sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), "ACCEPTED_ID");
    const payload = version === "v2"
      ? { number: PHONE, text: MESSAGE }
      : { number: PHONE, textMessage: { text: MESSAGE } };
    assert.deepEqual(requests, [
      ["/message/sendText/42", payload], ["/message/sendText/42", payload],
    ]);
    assert.deepEqual(logs, []);
  });

  test(`${label}: creación conserva nombre/QR y solo v2 agrega integration`, async t => {
    if (version !== undefined) process.env.EVOLUTION_API_VERSION = version;
    const logs = captureLogs(t);
    const calls: unknown[][] = [];
    t.mock.method(evolutionClient, "post", async (url: string, data?: unknown) => {
      calls.push([url, data]);
      return { data: {} } as never;
    });
    t.mock.method(evolutionClient, "get", async (url: string) => {
      calls.push([url]);
      return { data: { base64: QR_SECRET } } as never;
    });
    const { result, response } = fakeResponse();
    await conectarWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof conectarWhatsApp>[0], response);

    assert.deepEqual(calls, [
      ["/instance/create", version === "v2"
        ? { instanceName: "42", qrcode: true, integration: "WHATSAPP-BAILEYS" }
        : { instanceName: "42", qrcode: true }],
      ["/instance/connect/42"],
    ]);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { qr: QR_SECRET });
    assert.deepEqual(logs, []);
  });

  test(`${label}: recibos ambiguos y errores no se convierten en aceptación ni generan retry`, async t => {
    if (version !== undefined) process.env.EVOLUTION_API_VERSION = version;
    const logs = captureLogs(t);
    const replies = [
      { status: 200, data: {} },
      ...[undefined, null, "", 42, "x".repeat(256)].map(id => ({ status: 201, data: { key: { id } } })),
      { status: 500, data: { key: { id: "NOT_ACCEPTED" } } },
    ];
    const failure = Object.assign(new Error(`${TOKEN} ${MESSAGE}`), { response: { status: 400 } });
    let calls = 0;
    t.mock.method(evolutionClient, "post", async () => {
      calls++;
      if (replies.length) return replies.shift() as never;
      throw failure;
    });
    for (let i = 0; i < 7; i++) assert.equal(await sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), null);
    await assert.rejects(sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), error => error === failure);
    await assert.rejects(sendWhatsApp(PHONE, MESSAGE, "42"), error => error === failure);
    assert.equal(calls, 9);
    assert.equal(logs.length, 2);
    for (const secret of [PHONE, MESSAGE, TOKEN]) assert.equal(JSON.stringify(logs).includes(secret), false);
  });
}

test("creación solo recupera duplicado explícito del mismo nombre en HTTP 400/403, string o array", async t => {
  captureLogs(t);
  for (const version of ["v1", "v2"]) {
    process.env.EVOLUTION_API_VERSION = version;
    for (const status of [400, 403]) {
      for (const message of ['This name "42" is already in use.', ['This name "42" is already in use.']]) {
        t.mock.method(evolutionClient, "post", async () => {
          throw { response: { status, data: { response: { message } } } };
        });
        const get = t.mock.method(evolutionClient, "get", async (url: string) => {
          assert.equal(url, "/instance/connect/42");
          return { data: { base64: QR_SECRET } } as never;
        });
        const { result, response } = fakeResponse();
        await conectarWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof conectarWhatsApp>[0], response);
        assert.equal(get.mock.callCount(), 1);
        assert.equal(result.statusCode, 200);
        assert.deepEqual(result.body, { qr: QR_SECRET });
      }
    }
  }
});

test("HTTP 400 real, auth, duplicado ajeno y errores malformados no alcanzan connect ni filtran payload", async t => {
  const logs = captureLogs(t);
  for (const version of ["v1", "v2"]) {
    process.env.EVOLUTION_API_VERSION = version;
    const failure = (status: number, message: unknown) => ({ response: { status, data: { response: { message }, token: TOKEN } } });
    for (const error of [
      failure(400, "Invalid integration"), failure(400, ["instance requires property text"]),
      failure(400, undefined), failure(403, "Forbidden"),
      failure(401, 'This name "42" is already in use.'),
      failure(500, 'This name "42" is already in use.'),
      failure(400, 'This name "99" is already in use.'),
      failure(400, ['This name "42" is already in use.', "Invalid integration"]),
      failure(400, { text: "already in use" }),
      null, "already in use", { response: null },
    ]) {
      const post = t.mock.method(evolutionClient, "post", async () => { throw error; });
      const get = t.mock.method(evolutionClient, "get", async () => assert.fail("no connect on create failure"));
      const { result, response } = fakeResponse();
      await conectarWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof conectarWhatsApp>[0], response);
      assert.equal(post.mock.callCount(), 1);
      assert.equal(get.mock.callCount(), 0);
      assert.equal(result.statusCode, 500);
      assert.deepEqual(result.body, { error: "La API de WhatsApp no respondió a tiempo. Intentá de nuevo en unos segundos." });
    }
  }
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  assert.equal(JSON.stringify(logs).includes("Invalid integration"), false);
  assert.equal(JSON.stringify(logs).includes("Evolution instance already exists"), false);
});

test("versión inválida falla antes de HTTP, sin fallback ni exposición del valor", async t => {
  process.env.EVOLUTION_API_VERSION = TOKEN;
  const logs = captureLogs(t);
  const post = t.mock.method(evolutionClient, "post", async () => assert.fail("invalid version cannot POST"));
  const get = t.mock.method(evolutionClient, "get", async () => assert.fail("invalid version cannot connect"));
  await assert.rejects(sendWhatsApp(PHONE, MESSAGE, "42"), /^Error: EVOLUTION_API_VERSION_INVALID$/);
  await assert.rejects(sendPetWhatsAppWithReceipt(PHONE, MESSAGE, "42"), /^Error: EVOLUTION_API_VERSION_INVALID$/);
  const { result, response } = fakeResponse();
  await conectarWhatsApp(fakeAuthRequest(42) as unknown as Parameters<typeof conectarWhatsApp>[0], response);
  assert.equal(result.statusCode, 500);
  assert.equal(post.mock.callCount(), 0);
  assert.equal(get.mock.callCount(), 0);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
});
