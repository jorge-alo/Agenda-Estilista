// One-shot, explicitly local migration verification. Never imports production DB/env.
import '../features/pagos/pagos.test.setup';
import { pool } from '../config/db';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

async function main() {
  const [columns] = await pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pet_recurrencia_contactos' AND COLUMN_NAME='revision'`);
  assert.equal(columns.length, 0, 'Migracion ya aplicada o parcial: detener, no repetir DDL');
  const fixtureIds: number[] = [];
  const tag = `D30MIG-${randomUUID()}`;
  try {
    for (const kind of ['PET_GROOMING', 'BEAUTY']) {
      const [local] = await pool.query<ResultSetHeader>(
        "INSERT INTO locales(nombre,slug,business_type) VALUES (?,?,?)", [tag, `${tag}-${kind}`, kind]);
      fixtureIds.push(local.insertId);
      const [pet] = await pool.query<ResultSetHeader>('INSERT INTO mascotas(local_id,nombre) VALUES (?,?)', [local.insertId, tag]);
      for (let i = 0; i < 5; i++) {
        const phone = `+549112345670${i}`;
        const [client] = await pool.query<ResultSetHeader>(
          'INSERT INTO clientes(local_id,nombre,telefono,telefono_normalizado) VALUES (?,?,?,?)', [local.insertId, tag, phone, i === 3 ? null : phone]);
        if (i !== 4) await pool.query('INSERT INTO mascota_clientes(local_id,mascota_id,cliente_id) VALUES (?,?,?)', [local.insertId, pet.insertId, client.insertId]);
        if (i === 1) await pool.query(`INSERT INTO pet_recurrencia_contactos
          (local_id,telefono_normalizado,estado,baja_at,referencia_baja,created_at,updated_at)
          VALUES (?,?,'baja',UTC_TIMESTAMP(3),'fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [local.insertId, phone]);
        if (i === 2) await pool.query(`INSERT INTO pet_recurrencia_contactos
          (local_id,telefono_normalizado,estado,cliente_id_autorizado,verificada_at,referencia_verificacion,created_at,updated_at)
          VALUES (?,?,'autorizada',?,UTC_TIMESTAMP(3),'fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [local.insertId, phone, client.insertId]);
      }
    }
    const sql = await readFile(resolve(__dirname, '../../migrations/20261120_001_pet_recurrencia_operativa.sql'), 'utf8');
    // mysql2 does not interpret the mysql client DELIMITER directive.
    const tx = await pool.getConnection();
    try {
      let delimiter = ';'; let statement = '';
      for (const line of sql.split(/\r?\n/)) {
        if (line.startsWith('DELIMITER ')) { delimiter = line.slice(10).trim(); continue; }
        if (line.trim().startsWith('--')) continue;
        statement += `${line}\n`;
        if (statement.trimEnd().endsWith(delimiter)) {
          await tx.query(statement.trimEnd().slice(0, -delimiter.length)); statement = '';
        }
      }
      assert.equal(statement.trim(), '');
    } finally { tx.release(); }
    for (const [index, localId] of fixtureIds.entries()) {
      const [contacts] = await pool.query<RowDataPacket[]>('SELECT estado,origen,operador_id,verificada_at FROM pet_recurrencia_contactos WHERE local_id=? ORDER BY telefono_normalizado', [localId]);
      assert.deepEqual(contacts.map(c => c.estado), index === 0 ? ['habilitada', 'baja', 'autorizada'] : ['baja', 'autorizada']);
      if (index === 0) {
        assert.equal(contacts[0].origen, 'incorporacion_inicial');
        assert.equal(contacts[0].operador_id, null);
        assert.equal(contacts[0].verificada_at, null);
      }
      const [events] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM pet_recurrencia_contacto_eventos WHERE local_id=?', [localId]);
      assert.equal(Number(events[0].n), contacts.length);
    }
    console.info('Migracion Docker D30 aplicada: PET inicial, baja, autorizacion, BEAUTY, legacy invalido y sin vinculo PASS.');
  } finally {
    for (const id of fixtureIds) await pool.query('DELETE FROM locales WHERE id=? AND nombre=?', [id, tag]);
  }
}
void main().catch(() => { console.error('Migracion local detenida; revisar esquema antes de repetir.'); process.exitCode = 1; }).finally(() => pool.end());
