import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

const EMAIL_SENTINEL = "m6d-email-sentinel-unique@example.invalid";
const TOKEN_SENTINEL = "m6d-token-sentinel-unique";
const URL_SENTINEL = "m6d-reset-url-sentinel-unique";
const PASSWORD_SENTINEL = "m6d-password-sentinel-unique";

let generatedToken = "";
let deliveredLink = "";
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
      if (sql.startsWith("SELECT id FROM usuarios")) {
        assert.deepEqual(values, [EMAIL_SENTINEL]);
        return [[{ id: 451, nombre: "Forgot password fixture" }], []];
      }
      if (sql.startsWith("UPDATE usuarios SET reset_token")) {
        generatedToken = String(values[0]);
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
const { emailService } = require("../../shared/services/email.service") as typeof import("../../shared/services/email.service");

test("forgot-password responde ciego y no registra body, email, token ni enlace", async () => {
  const output: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  generatedToken = "";
  deliveredLink = "";
  providerSendResult = { data: { id: "fixture-email-id" }, error: null };
  providerThrownError = null;
  try {
    let status = 200;
    let body: unknown;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    };

    await forgotPassword({ body: {
      email: EMAIL_SENTINEL,
      token: TOKEN_SENTINEL,
      resetUrl: URL_SENTINEL,
      password: PASSWORD_SENTINEL,
    } } as never, response as never);

    assert.equal(status, 200);
    assert.deepEqual(body, { message: "Si el correo está registrado, recibirás un enlace de recuperación." });
    assert.ok(generatedToken.length > 0, "The reset flow must generate a token for the fixture user");
    assert.ok(deliveredLink.includes(generatedToken), "The email sender receives the generated reset link");
    assert.ok(!deliveredLink.includes(TOKEN_SENTINEL));
    assert.ok(!deliveredLink.includes(URL_SENTINEL));

    const allObservableLogs = output.join("\n");
    for (const secret of [EMAIL_SENTINEL, TOKEN_SENTINEL, URL_SENTINEL, PASSWORD_SENTINEL, generatedToken, deliveredLink]) {
      assert.ok(!allObservableLogs.includes(secret), `Sensitive value appeared in logs: ${secret === generatedToken ? "generated token" : "sentinel"}`);
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

test("forgot-password logger test sentinels are unique and do not alias", () => {
  assert.equal(new Set([EMAIL_SENTINEL, TOKEN_SENTINEL, URL_SENTINEL, PASSWORD_SENTINEL]).size, 4);
});

for (const [id, original] of originals) {
  if (original) require.cache[id] = original;
  else delete require.cache[id];
}
