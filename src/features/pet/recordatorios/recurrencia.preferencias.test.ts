import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../../config/db';
import { crearResponsable } from '../mascotas/mascotas.service';
import { cambiarPreferenciaD30, leerPreferenciaD30, validarCambioD30 } from './recurrencia.preferencias';
import { prepararFuenteContactosRecurrencia, operarContactosRecurrencia } from './recurrencia.contactos';

const ids: number[] = [];
const tag = `D30PREF-${randomUUID()}`;
async function fixture(enabled = true) {
  const [l] = await pool.query<ResultSetHeader>("INSERT INTO locales(nombre,slug,business_type) VALUES (?,?,'PET_GROOMING')", [tag, `${tag}-${ids.length}`]);
  ids.push(l.insertId);
  const c = await crearResponsable(l.insertId, { nombre: tag, telefono: '1123456789', recordatoriosD30: enabled }, 17);
  const read = () => leerPreferenciaD30(pool, l.insertId, c.id);
  const write = async (habilitada: boolean, revision?: number, op = randomUUID()) => {
    const actual = await read();
    return cambiarPreferenciaD30(l.insertId, c.id, 17, { habilitada, revision: revision ?? actual.revision, telefono: actual.telefono!, operacionId: op });
  };
  return { localId: l.insertId, c, read, write };
}
after(async () => {
  for (const id of ids) await pool.query('DELETE FROM locales WHERE id=? AND nombre=?', [id, tag]);
  const [residue] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM pet_recurrencia_contacto_eventos WHERE local_id IN (?)', [ids]);
  assert.equal(Number(residue[0].n), 0);
  await pool.end();
});
test('alta: habilitada sin consentimiento fabricado, checkbox false = baja; reutilizacion no pisa preferencia', async () => {
  const f = await fixture();
  assert.deepEqual(await f.read(), { estado: 'habilitada', habilitada: true, revision: 1, telefono: '+541123456789' });
  const [rows] = await pool.query<RowDataPacket[]>('SELECT verificada_at,referencia_verificacion,operador_id,origen FROM pet_recurrencia_contactos WHERE local_id=?', [f.localId]);
  assert.equal(rows[0].verificada_at, null); assert.equal(rows[0].referencia_verificacion, null);
  assert.equal(rows[0].operador_id, 17); assert.equal(rows[0].origen, 'alta_responsable');
  const resolver = await prepararFuenteContactosRecurrencia(pool, f.localId);
  assert.equal((await resolver({ localId: f.localId, clienteId: f.c.id, telefonoCanonical: '+541123456789' }))?.estado, 'habilitada');
  await f.write(false);
  const reused = await crearResponsable(f.localId, { nombre: 'Otra ficha', telefono: '1123456789', recordatoriosD30: true }, 18);
  assert.equal(reused.isNew, false); assert.equal((await f.read()).estado, 'baja');
  assert.equal((await (await fixture(false)).read()).estado, 'baja');
});
test('baja y reactivaciones preservan todo el historial; retry viejo no reactiva ni duplica', async () => {
  const f = await fixture();
  const op = randomUUID();
  await f.write(false, 1, op);
  await f.write(true, 2);
  await f.write(false, 3);
  const current = await f.write(false, 1, op);
  assert.equal(current.revision, 4); assert.equal(current.estado, 'baja');
  const [events] = await pool.query<RowDataPacket[]>('SELECT estado,operador_id FROM pet_recurrencia_contacto_eventos WHERE local_id=? ORDER BY revision', [f.localId]);
  assert.deepEqual(events.map(e => e.estado), ['habilitada', 'baja', 'habilitada', 'baja']);
  assert.ok(events.every(e => e.operador_id === 17));
  await assert.rejects(f.write(true, 1, op), { code: 'PET_D30_OPERATION_CONFLICT' });
  await assert.rejects(f.write(true, 2), { code: 'PET_D30_CONFLICT' });
});
test('dos operadores sobre la misma revision: solo una escritura; baja nueva invalida una reactivacion vieja', async () => {
  const f = await fixture(false);
  const results = await Promise.allSettled([f.write(true, 1), f.write(false, 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await f.write(false);
  await assert.rejects(f.write(true, 1), { code: 'PET_D30_CONFLICT' });
});
test('tenant, telefono cambiado, entrada estricta y reactivacion SQL accidental', async () => {
  const f = await fixture(false); const other = await fixture();
  const actual = await f.read();
  const body = { habilitada: true, revision: 1, telefono: actual.telefono!, operacionId: randomUUID() };
  assert.deepEqual(validarCambioD30(body), body);
  assert.throws(() => validarCambioD30({ ...body, local_id: f.localId }));
  assert.throws(() => validarCambioD30({ ...body, habilitada: 'true' }));
  await assert.rejects(cambiarPreferenciaD30(other.localId, f.c.id, 17, body), { code: 'PET_D30_NOT_FOUND' });
  await assert.rejects(pool.query("UPDATE pet_recurrencia_contactos SET estado='habilitada',baja_at=NULL,referencia_baja=NULL WHERE local_id=?", [f.localId]), { code: 'ER_SIGNAL_EXCEPTION' });
  await pool.query("UPDATE clientes SET telefono_normalizado='+5491123456790' WHERE local_id=? AND id=?", [f.localId, f.c.id]);
  await assert.rejects(cambiarPreferenciaD30(f.localId, f.c.id, 17, body), { code: 'PET_D30_PHONE_CHANGED' });
});
test('baja sobrevive eliminar/recrear cliente; historial inmutable e importador no levanta baja', async () => {
  const f = await fixture(false);
  await pool.query('DELETE FROM clientes WHERE id=? AND local_id=?', [f.c.id, f.localId]);
  const recreated = await crearResponsable(f.localId, { nombre: tag, telefono: '1123456789' }, 17);
  assert.equal((await leerPreferenciaD30(pool, f.localId, recreated.id)).estado, 'baja');
  await assert.rejects(pool.query('DELETE FROM pet_recurrencia_contacto_eventos WHERE local_id=?', [f.localId]), { code: 'ER_SIGNAL_EXCEPTION' });
  await operarContactosRecurrencia({ localId: f.localId, aplicar: true, operaciones: [{ tipo: 'autorizacion', clienteId: recreated.id,
    telefonoCanonical: '+541123456789', verificadaAt: '2026-01-01T00:00:00.000Z', referenciaVerificacion: 'no-levantar-baja' }] });
  assert.equal((await leerPreferenciaD30(pool, f.localId, recreated.id)).estado, 'baja');
});
test('UNIQUE de operacion revierte estado, revision e historial de una escritura duplicada', async () => {
  const f = await fixture();
  const op = randomUUID();
  await f.write(false, 1, op);
  const second = await crearResponsable(f.localId, { nombre: tag, telefono: '1123456791' }, 17);
  const actual = await leerPreferenciaD30(pool, f.localId, second.id);
  await assert.rejects(pool.query(`UPDATE pet_recurrencia_contactos SET estado='baja',
    origen='ficha',operador_id=17,operacion_id=?,baja_at=UTC_TIMESTAMP(3),referencia_baja='fixture',
    updated_at=UTC_TIMESTAMP(3) WHERE local_id=? AND telefono_normalizado=?`, [op, f.localId, actual.telefono]), { code: 'ER_DUP_ENTRY' });
  assert.deepEqual(await leerPreferenciaD30(pool, f.localId, second.id), actual);
  const [events] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM pet_recurrencia_contacto_eventos WHERE local_id=? AND cliente_id=?', [f.localId, second.id]);
  assert.equal(Number(events[0].n), 1);
});
