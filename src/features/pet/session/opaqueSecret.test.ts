import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateOpaqueSecret, hashOpaqueSecret, isCanonicalOpaqueSecret } from "./opaqueSecret";

test("PET opaque: genera secretos canonicos de 32 bytes / 43 caracteres sin padding", () => {
  const secrets = Array.from({ length: 64 }, () => generateOpaqueSecret());
  assert.equal(new Set(secrets).size, secrets.length);
  assert.ok(secrets.every(secret => secret.length === 43 && isCanonicalOpaqueSecret(secret)));
  assert.ok(secrets.every(secret => Buffer.from(secret, "base64url").length === 32));
});

test("PET opaque: generate -> validar -> hash produce Buffer de 32 bytes", () => {
  const secret = generateOpaqueSecret();
  assert.ok(isCanonicalOpaqueSecret(secret));
  const hash = hashOpaqueSecret(secret);
  assert.ok(Buffer.isBuffer(hash));
  assert.equal(hash.length, 32);
});

test("PET opaque: mismo secreto produce el mismo hash en buffers independientes", () => {
  const secret = generateOpaqueSecret();
  const first = hashOpaqueSecret(secret);
  const second = hashOpaqueSecret(secret);
  assert.ok(first !== second);
  assert.ok(first.equals(second));
});

test("PET opaque: secretos distintos producen hashes distintos", () => {
  const first = Buffer.alloc(32, 1).toString("base64url");
  const second = Buffer.alloc(32, 2).toString("base64url");
  assert.ok(!hashOpaqueSecret(first).equals(hashOpaqueSecret(second)));
});

test("PET opaque: SHA-256 usa el string UTF-8 externo y no los bytes decodificados", () => {
  const bytes = Buffer.alloc(32, 7);
  const secret = bytes.toString("base64url");
  const actual = hashOpaqueSecret(secret);
  assert.ok(actual.equals(createHash("sha256").update(secret, "utf8").digest()));
  assert.ok(!actual.equals(createHash("sha256").update(bytes).digest()));
});

test("PET opaque: rechaza tipos, longitud, padding, base64 comun, espacios, unicode y JWT", () => {
  const canonical = Buffer.alloc(32).toString("base64url");
  const invalid: unknown[] = [
    undefined, null, 123, true, {}, [], Buffer.alloc(32),
    "", " ", canonical.slice(1), `${canonical}A`, `${canonical}=`,
    `${canonical.slice(0, -1)}=`, `${canonical.slice(0, -1)}+`,
    `${canonical.slice(0, -1)}/`, `${canonical.slice(0, -1)}.`,
    ` ${canonical}`, `${canonical} `, `${canonical}\n`,
    `${canonical.slice(0, -1)} `, `${canonical.slice(0, -1)}é`,
    `${canonical.slice(0, -1)}\u200b`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.firma",
  ];
  invalid.forEach((input, index) => {
    assert.equal(isCanonicalOpaqueSecret(input), false, `caso invalido ${index}`);
  });
});

test("PET opaque: rechaza aliases base64url con bits de padding no canonicos", () => {
  const canonical = Buffer.alloc(32).toString("base64url");
  for (const last of ["B", "C", "D"]) {
    const alias = canonical.slice(0, -1) + last;
    assert.ok(Buffer.from(alias, "base64url").equals(Buffer.from(canonical, "base64url")));
    assert.equal(isCanonicalOpaqueSecret(alias), false);
    assert.throws(() => hashOpaqueSecret(alias), TypeError);
  }
});

test("PET opaque: hash rechaza credenciales invalidas sin limpiar ni incluir input en error", () => {
  const secret = generateOpaqueSecret();
  for (const input of ["", ` ${secret}`, `${secret} `, `${secret}=`, `${secret}\n`]) {
    let error: unknown;
    try { hashOpaqueSecret(input); } catch (caught) { error = caught; }
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "Secreto opaco invalido");
  }
});
