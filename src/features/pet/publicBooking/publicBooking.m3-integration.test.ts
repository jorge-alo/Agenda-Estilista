import assert from "node:assert/strict";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import * as servicios from "../servicios/servicios.service";
import * as extras from "../extras/extras.service";
import { obtenerDisponibilidad } from "../disponibilidad/disponibilidad.service";
import { obtenerDisponibilidadPublica, obtenerOpcionesReserva } from "./publicBooking.service";
import { admin, body, FECHA, fixture, post, q, record, useBookingHarness } from "./publicBooking.turnos.test-support";

useBookingHarness("M3G");

test("M.3G catálogo/configuración → disponibilidad admin/pública → reservas 60+30+15=105 y snapshots históricos", async () => {
  const f = await fixture();
  const service = await servicios.crearServicio(f.localId, "M3G Baño");
  const e1 = await extras.crearExtra(f.localId, "M3G Desenredado");
  const e2 = await extras.crearExtra(f.localId, "M3G Tratamiento");
  const selection = { mascotaId: f.mascotaId, servicioId: service.id, extraIds: [e1.id, e2.id], fecha: FECHA };
  await servicios.guardarConfiguracion(f.localId, f.mascotaId, service.id, 60, true);
  await extras.guardarConfiguracion(f.localId, f.mascotaId, e1.id, 30, true);
  await extras.guardarConfiguracion(f.localId, f.mascotaId, e2.id, 15, true);
  const [catalogRow] = await q<RowDataPacket[]>("SELECT duracion, precio FROM servicios WHERE id=? AND local_id=?", [service.id, f.localId]);
  assert.deepEqual({ ...catalogRow }, { duracion: null, precio: null });
  const options = await obtenerOpcionesReserva(f.localId, f.clienteId, f.mascotaId);
  assert.deepEqual(options.servicios.find(s => s.id === service.id), { id: service.id, nombre: service.nombre, duracionMinutos: 60 });
  assert.equal(options.extras.find(e => e.id === e1.id)?.duracionExtraMinutos, 30);
  assert.equal(options.extras.find(e => e.id === e2.id)?.duracionExtraMinutos, 15);
  for (const result of [await obtenerDisponibilidad(f.localId, selection), await obtenerDisponibilidadPublica(f.localId, f.clienteId, selection)]) {
    assert.equal(result.duracionMinutos, 105);
    assert.ok(result.slots.some(slot => slot.horaInicio === "09:00" && slot.horaFin === "10:45"));
  }
  const adminResult = await admin(f, body(f, { ...selection, hora: "09:00" }));
  const publicResult = await post(f, body(f, { ...selection, hora: "11:00" }));
  assert.equal(adminResult.status, 201); assert.equal(record(adminResult).horaFin, "10:45");
  assert.equal(publicResult.status, 201); assert.equal(record(publicResult).horaFin, "12:45");
  const snapshot = async () => ({
    turnos: await q<RowDataPacket[]>("SELECT id,hora,hora_fin,servicio_nombre_snapshot,duracion_servicio_snapshot,estado FROM turnos WHERE local_id=? ORDER BY id", [f.localId]),
    extras: await q<RowDataPacket[]>("SELECT te.* FROM turno_extras te JOIN turnos t ON t.id=te.turno_id WHERE t.local_id=? ORDER BY te.id", [f.localId]),
  });
  const before = await snapshot();
  assert.ok(before.turnos.every(row => row.duracion_servicio_snapshot === 60));
  assert.deepEqual(before.extras.map(row => row.duracion_minutos).sort((a,b) => a-b), [15,15,30,30]);
  await servicios.guardarConfiguracion(f.localId, f.mascotaId, service.id, 90, false);
  await extras.guardarConfiguracion(f.localId, f.mascotaId, e1.id, 40, false);
  await servicios.editarServicio(f.localId, service.id, { nombre: "M3G Baño cambiado", activo: false });
  await extras.editarExtra(f.localId, e1.id, { nombre: "M3G Desenredado cambiado", activo: false });
  assert.deepEqual(await snapshot(), before);
  const inactiveOptions = await obtenerOpcionesReserva(f.localId, f.clienteId, f.mascotaId);
  assert.equal(inactiveOptions.servicios.some(s => s.id === service.id), false);
  assert.equal(inactiveOptions.extras.some(e => e.id === e1.id), false);
  assert.equal((await servicios.listarConfigurados(f.localId, f.mascotaId)).find(s => s.id === service.id)?.duracion_minutos, 90);
  assert.equal((await extras.listarConfigurados(f.localId, f.mascotaId)).find(e => e.id === e1.id)?.duracion_minutos, 40);
  assert.equal((await servicios.listarConfigurados(f.localId, f.mascotaId)).find(s => s.id === service.id)?.activo, 0);
  assert.equal((await extras.listarConfigurados(f.localId, f.mascotaId)).find(e => e.id === e1.id)?.activo, 0);
  await assert.rejects(obtenerDisponibilidadPublica(f.localId, f.clienteId, selection), { code: "PET_SERVICE_UNAVAILABLE" });
  await servicios.editarServicio(f.localId, service.id, { activo: true });
  await assert.rejects(obtenerDisponibilidadPublica(f.localId, f.clienteId, selection), { code: "PET_EXTRA_UNAVAILABLE" });
  await extras.editarExtra(f.localId, e1.id, { activo: true });
  assert.equal((await obtenerDisponibilidadPublica(f.localId, f.clienteId, selection)).duracionMinutos, 145);
  assert.deepEqual(await snapshot(), before);
});

test("M.3G configuración no habilita online: admin permitido, público offline rechazado; quitar relaciones no borra catálogo", async () => {
  const f = await fixture();
  await q("UPDATE mascotas SET reserva_online_habilitada=0 WHERE id=? AND local_id=?", [f.mascotaId,f.localId]);
  await servicios.guardarConfiguracion(f.localId,f.mascotaId,f.servicioId,60,false);
  await extras.guardarConfiguracion(f.localId,f.mascotaId,f.extraIds[0],30,false);
  const [pet] = await q<RowDataPacket[]>("SELECT reserva_online_habilitada FROM mascotas WHERE id=? AND local_id=?", [f.mascotaId,f.localId]);
  assert.equal(pet.reserva_online_habilitada,0);
  assert.equal((await admin(f,body(f,{extraIds:[f.extraIds[0]]}))).status,201);
  assert.deepEqual((await post(f,body(f,{hora:"12:00"}))).data,{error:"PET_MASCOTA_UNAVAILABLE"});
  await servicios.quitarConfiguracion(f.localId,f.mascotaId,f.servicioId);
  await extras.quitarConfiguracion(f.localId,f.mascotaId,f.extraIds[0]);
  assert.ok((await servicios.listarCatalogo(f.localId)).some(s=>s.id===f.servicioId));
  assert.ok((await extras.listarCatalogo(f.localId)).some(e=>e.id===f.extraIds[0]));
  await assert.rejects(obtenerDisponibilidad(f.localId,{mascotaId:f.mascotaId,servicioId:f.servicioId,extraIds:[],fecha:FECHA}), {code:"PET_SERVICIO_NO_ASOCIADO"});
});

test("M.3G dos tenants: configuración ajena nunca entra en opciones, disponibilidad o nuevas relaciones", async () => {
  const a=await fixture(), b=await fixture();
  const selection={mascotaId:a.mascotaId,servicioId:a.servicioId,extraIds:[b.extraIds[0]],fecha:FECHA};
  await assert.rejects(servicios.guardarConfiguracion(a.localId,a.mascotaId,b.servicioId,60,true), {status:404});
  await assert.rejects(extras.guardarConfiguracion(a.localId,a.mascotaId,b.extraIds[0],30,true), {status:404});
  await assert.rejects(servicios.listarConfigurados(a.localId,b.mascotaId), {status:404});
  await assert.rejects(extras.listarConfigurados(a.localId,b.mascotaId), {status:404});
  await assert.rejects(obtenerDisponibilidadPublica(a.localId,a.clienteId,selection), {code:"PET_EXTRA_UNAVAILABLE"});
  await assert.rejects(obtenerDisponibilidadPublica(a.localId,a.clienteId,{...selection,servicioId:b.servicioId,extraIds:[]}), {code:"PET_SERVICE_UNAVAILABLE"});
  const options=await obtenerOpcionesReserva(a.localId,a.clienteId,a.mascotaId);
  assert.equal(options.servicios.some(s=>s.id===b.servicioId),false);
  assert.equal(options.extras.some(e=>b.extraIds.includes(e.id)),false);
});
