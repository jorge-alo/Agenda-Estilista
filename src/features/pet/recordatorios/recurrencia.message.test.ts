import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPetRecurrenceReminder, reciboRecurrenciaSimulado } from "./recurrencia.message";

test("plantilla: cuidado del manto, nuestra agenda online, acceso existente y baja sin precios/D35", () => {
  const message = buildPetRecurrenceReminder({mascotaNombre:"Luna",slug:"salón/mascotas",frontendUrl:"https://example.test/base/"});
  assert.ok(message.includes("última visita de Luna"));
  assert.ok(message.includes("conservar el manto sano, cómodo y evitar nudos"));
  assert.ok(message.includes("nuestra agenda online"));
  assert.ok(message.includes("“Ya soy cliente”"));
  assert.ok(message.includes("Si preferís no recibir estos recordatorios"));
  const link = message.match(/https:\/\/\S+/)?.[0];
  assert.equal(link,"https://example.test/base/sal%C3%B3n%2Fmascotas");
  const url = new URL(link!);
  assert.equal(url.search,""); assert.equal(url.hash,"");
  assert.ok(!/D35|precio|descuento|disponibilidad para esta semana|\/acceso|token=/i.test(message));
});

test("configuración inválida no genera URL ni mensaje utilizable", () => {
  for (const frontendUrl of ["http://example.test","https://user:password@example.test","https://example.test/?token=secret","invalid"]) {
    assert.throws(() => buildPetRecurrenceReminder({mascotaNombre:"Luna",slug:"pet",frontendUrl}));
  }
  assert.throws(() => buildPetRecurrenceReminder({mascotaNombre:"Luna",slug:" ",frontendUrl:"https://example.test"}));
});

test("aceptación requiere 2xx con key.id string no vacío y acotado; ambiguos son null", () => {
  assert.equal(reciboRecurrenciaSimulado({status:201,data:{key:{id:"receipt-fixture"}}}),"receipt-fixture");
  for (const response of [null,undefined,"ok",{}, {status:200}, {status:500,data:{key:{id:"x"}}},
    {status:NaN,data:{key:{id:"x"}}}, {status:"200",data:{key:{id:"x"}}},
    ...[null,5,""," ","x".repeat(256)].map(id => ({status:200,data:{key:{id}}}))]) {
    assert.equal(reciboRecurrenciaSimulado(response),null);
  }
});
