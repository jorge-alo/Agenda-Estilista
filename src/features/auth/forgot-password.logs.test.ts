import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const EMAIL_SENTINEL = "m6d-email-sentinel-unique@example.invalid";
const TOKEN_SENTINEL = "m6d-token-sentinel-unique";
const URL_SENTINEL = "m6d-reset-url-sentinel-unique";
const PASSWORD_SENTINEL = "m6d-password-sentinel-unique";

let generatedToken = "";
let deliveredLink = "";
let savedToken = "";
let tokenExpiresAt: Date | null = null;
let existingUser = true;
let emailSends = 0;
let providerSendResult: { data?: { id?: string }; error?: { message: string } | null } = { data: { id: "fixture-email-id" }, error: null };
let providerThrownError: string | null = null;
const queryPath = require.resolve("../../config/db");
const resendPath = require.resolve("resend");
const dotenvPath = require.resolve("dotenv");
const originals = new Map<string, NodeModule | undefined>([
  [queryPath, require.cache[queryPath]],
  [resendPath, require.cache[resendPath]],
  [dotenvPath, require.cache[dotenvPath]],
]);

function stubModule(id: string, exports: unknown): void {
  const stub = new Module(id);
  stub.filename = id;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[id] = stub;
}

stubModule(queryPath, {
  pool: {
    async query(sql: string, values: unknown[]) {
      if (sql.startsWith("SELECT id FROM usuarios WHERE reset_token")) {
        return [savedToken && values[0] === savedToken && tokenExpiresAt && tokenExpiresAt > new Date()
          ? [{ id: 451 }] : [], []];
      }
      if (sql.startsWith("SELECT id FROM usuarios")) {
        assert.deepEqual(values, [EMAIL_SENTINEL]);
        return [existingUser ? [{ id: 451, nombre: "Forgot password fixture" }] : [], []];
      }
      if (sql.startsWith("UPDATE usuarios SET reset_token")) {
        generatedToken = String(values[0]);
        savedToken = generatedToken;
        tokenExpiresAt = values[1] as Date;
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("UPDATE usuarios SET password")) {
        assert.deepEqual(values.slice(1), [451]);
        savedToken = "";
        tokenExpiresAt = null;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error("Unexpected query in forgot-password log test");
    },
  },
});
stubModule(resendPath, {
  Resend: class FakeResend {
    readonly emails = {
      async send(message: { to: string; html: string }) {
        emailSends++;
        const link = message.html.match(/href="([^"]*\/reset-password\?token=[^"]+)"/);
        if (link) deliveredLink = link[1];
        if (providerThrownError !== null) throw new Error(providerThrownError);
        return providerSendResult;
      },
    };
    constructor(_apiKey?: string) {}
  },
});
stubModule(dotenvPath, { config: () => ({ parsed: {} }) });

const { forgotPassword } = require("./auth.controller") as typeof import("./auth.controller");
const { resetPassword } = require("./auth.service") as typeof import("./auth.service");
const { emailService } = require("../../shared/services/email.service") as typeof import("../../shared/services/email.service");

function resetFixture(): void {
  generatedToken = "";
  savedToken = "";
  tokenExpiresAt = null;
  deliveredLink = "";
  existingUser = true;
  emailSends = 0;
  providerSendResult = { data: { id: "fixture-email-id" }, error: null };
  providerThrownError = null;
}

async function invokeForgot(body: Record<string, unknown> = { email: EMAIL_SENTINEL }) {
  let status = 200;
  let responseBody: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { responseBody = value; return this; },
  };
  await forgotPassword({ body } as never, response as never);
  return { status, body: responseBody };
}

test("forgot-password usa FRONTEND_URL y no registra body, email, token ni enlace", async (t) => {
  t.mock.property(process, "env", {
    FRONTEND_URL: "https://frontend.example.test/",
    CORS_ORIGINS: "https://frontend.example.test,https://preview.pages.dev",
    NODE_ENV: "production",
  });
  const output: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  resetFixture();
  try {
    const result = await invokeForgot({
      email: EMAIL_SENTINEL,
      token: TOKEN_SENTINEL,
      resetUrl: URL_SENTINEL,
      password: PASSWORD_SENTINEL,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { message: "Si el correo está registrado, recibirás un enlace de recuperación." });
    assert.match(generatedToken, /^[a-f0-9]{64}$/);
    assert.equal(deliveredLink, `https://frontend.example.test/reset-password?token=${generatedToken}`);
    assert.equal(emailSends, 1);
    assert.equal(savedToken, generatedToken);
    assert.ok(tokenExpiresAt instanceof Date);
    const ttl = tokenExpiresAt.getTime() - Date.now();
    assert.ok(ttl > 14 * 60_000 && ttl <= 15 * 60_000, "El token expira en 15 minutos");
    assert.ok(!deliveredLink.includes(TOKEN_SENTINEL));
    assert.ok(!deliveredLink.includes(URL_SENTINEL));

    const allObservableLogs = output.join("\n");
    for (const secret of [EMAIL_SENTINEL, TOKEN_SENTINEL, URL_SENTINEL, PASSWORD_SENTINEL, generatedToken, deliveredLink]) {
      assert.ok(!allObservableLogs.includes(secret), `Sensitive value appeared in logs: ${secret === generatedToken ? "generated token" : "sentinel"}`);
      assert.ok(!JSON.stringify(result.body).includes(secret));
    }

    const providerError = `${EMAIL_SENTINEL} ${TOKEN_SENTINEL} ${URL_SENTINEL} ${generatedToken} ${deliveredLink}`;
    providerSendResult = { error: { message: providerError } };
    await emailService.enviarEmailRecuperacion({ to: EMAIL_SENTINEL, resetLink: deliveredLink });
    providerSendResult = { data: { id: "fixture-email-id" }, error: null };
    providerThrownError = providerError;
    await emailService.enviarEmailRecuperacion({ to: EMAIL_SENTINEL, resetLink: deliveredLink });
    const failedSendLogs = output.slice(1).join("\n");
    for (const secret of [EMAIL_SENTINEL, TOKEN_SENTINEL, URL_SENTINEL, PASSWORD_SENTINEL, generatedToken, deliveredLink]) {
      assert.ok(!failedSendLogs.includes(secret), "Provider error must not leak recovery data into logs");
    }
    assert.ok(failedSendLogs.includes("Password recovery email delivery failed"));
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
});

test("FRONTEND_URL sin barra final conserva el mismo path y query", async (t) => {
  t.mock.property(process, "env", {
    FRONTEND_URL: "https://frontend.example.test",
    CORS_ORIGINS: "https://frontend.example.test,https://preview.pages.dev",
    NODE_ENV: "production",
  });
  resetFixture();
  assert.equal((await invokeForgot()).status, 200);
  assert.equal(deliveredLink, `https://frontend.example.test/reset-password?token=${generatedToken}`);
  assert.equal(emailSends, 1);
});

test("usuario inexistente conserva respuesta ciega sin token ni envío", async (t) => {
  t.mock.property(process, "env", {
    FRONTEND_URL: "https://frontend.example.test",
    CORS_ORIGINS: "https://frontend.example.test,https://preview.pages.dev",
    NODE_ENV: "production",
  });
  resetFixture();
  existingUser = false;
  assert.deepEqual(await invokeForgot(), {
    status: 200,
    body: { message: "Si el correo está registrado, recibirás un enlace de recuperación." },
  });
  assert.equal(generatedToken, "");
  assert.equal(emailSends, 0);
});

test("FRONTEND_URL faltante o inválida no persiste token ni envía enlace", async (t) => {
  const output: string[] = [];
  const config: { FRONTEND_URL?: string; CORS_ORIGINS: string; NODE_ENV: string } = {
    CORS_ORIGINS: "https://frontend.example.test,https://preview.pages.dev",
    NODE_ENV: "production",
  };
  t.mock.property(process, "env", config);
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    for (const frontendUrl of [undefined, "not-a-url", "http://frontend.example.test", "https://user:password@frontend.example.test", "https://frontend.example.test/?secret=fixture", "https://frontend.example.test/#secret"]) {
      if (frontendUrl === undefined) delete config.FRONTEND_URL;
      else config.FRONTEND_URL = frontendUrl;
      resetFixture();
      const result = await invokeForgot();
      assert.deepEqual(result, { status: 500, body: { error: "Error al procesar la solicitud" } });
      existingUser = false;
      assert.deepEqual(await invokeForgot(), result, "La configuración inválida no revela si el email existe");
      assert.equal(generatedToken, "");
      assert.equal(savedToken, "");
      assert.equal(emailSends, 0);
      assert.equal(deliveredLink, "");
      assert.ok(!output.join("\n").includes("secret=fixture"));
      assert.ok(!output.join("\n").includes("user:password"));
    }
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
});

test("HTTP se admite solo en desarrollo/test y el token sigue siendo de un solo uso", async (t) => {
  t.mock.property(process, "env", { FRONTEND_URL: "http://localhost:5173/", NODE_ENV: "test" });
  resetFixture();
  assert.equal((await invokeForgot()).status, 200);
  assert.equal(deliveredLink, `http://localhost:5173/reset-password?token=${generatedToken}`);
  const token = generatedToken;
  assert.deepEqual(await resetPassword(token, "new-password-fixture"), { success: true });
  await assert.rejects(resetPassword(token, "new-password-fixture"), { message: "Token inválido o expirado" });
});

test("forgot-password logger test sentinels are unique and do not alias", () => {
  assert.equal(new Set([EMAIL_SENTINEL, TOKEN_SENTINEL, URL_SENTINEL, PASSWORD_SENTINEL]).size, 4);
});

for (const [id, original] of originals) {
  if (original) require.cache[id] = original;
  else delete require.cache[id];
}
