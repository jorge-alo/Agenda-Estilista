import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../config/db";
import { procesarRecordatorios } from "./recordatorios.cron";

interface TenantFixture {
  id: number;
  slug: string;
  serviceId: number;
  stylistId: number | null;
  probeStylistId: number | null;
  clientId: number;
  petId: number | null;
}

const prefix = `M6D_CRON_${randomUUID()}`;
const tenants: TenantFixture[] = [];
let fechaManana: string;

async function insert(sql: string, values: unknown[]): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(sql, values);
  return result.insertId;
}

async function createTenant(businessType: "BEAUTY" | "PET_GROOMING", index: number): Promise<TenantFixture> {
  const slug = `${prefix}-${index}`;
  const localId = await insert(
    `INSERT INTO locales (nombre, slug, business_type, activo, requiere_sena, telefono,
      suscripcion_estado, suscripcion_vencimiento)
     VALUES (?, ?, ?, 1, 0, '1155550000', 'activo', '2099-12-31')`,
    [prefix, slug, businessType],
  );
  const fixture: TenantFixture = {
    id: localId,
    slug,
    serviceId: 0,
    stylistId: null,
    probeStylistId: null,
    clientId: 0,
    petId: null,
  };
  tenants.push(fixture);
  fixture.serviceId = await insert(
    "INSERT INTO servicios (nombre, duracion, precio, local_id) VALUES (?, 30, 100, ?)",
    [`${prefix} service ${index}`, localId],
  );
  fixture.clientId = await insert(
    `INSERT INTO clientes (nombre, telefono, telefono_normalizado, local_id)
     VALUES (?, '1123456789', '5491123456789', ?)`,
    [`${prefix} client ${index}`, localId],
  );
  if (businessType === "BEAUTY") {
    fixture.stylistId = await insert(
      "INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)",
      [`${prefix} stylist ${index}`, localId],
    );
  } else {
    // This structurally BEAUTY-shaped row proves the local vertical alone excludes it.
    fixture.probeStylistId = await insert(
      "INSERT INTO estilistas (nombre, local_id) VALUES (?, ?)",
      [`${prefix} probe stylist ${index}`, localId],
    );
    fixture.petId = await insert(
      "INSERT INTO mascotas (local_id, nombre, activo, alta_exigencia) VALUES (?, ?, 1, 0)",
      [localId, `${prefix} pet ${index}`],
    );
    await pool.query(
      "INSERT INTO mascota_clientes (local_id, mascota_id, cliente_id) VALUES (?, ?, ?)",
      [localId, fixture.petId, fixture.clientId],
    );
    await pool.query(
      "INSERT INTO mascota_servicios (local_id, mascota_id, servicio_id, duracion_minutos) VALUES (?, ?, ?, 30)",
      [localId, fixture.petId, fixture.serviceId],
    );
  }
  return fixture;
}

async function createTurno(
  tenant: TenantFixture,
  options: { date?: string; state?: string; phone?: string; beautyShape?: boolean } = {},
): Promise<number> {
  const date = options.date ?? fechaManana;
  const phone = options.phone ?? "1123456789";
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO turnos (
      local_id, fecha, hora, hora_fin, estilista_id, mascota_id, cliente_id,
      cliente_nombre, cliente_telefono, servicio_id, servicio_nombre_snapshot,
      duracion_servicio_snapshot, alta_exigencia_snapshot, estado
    ) VALUES (?, ?, '10:00', '10:30', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant.id,
      date,
      options.beautyShape ? tenant.probeStylistId : tenant.stylistId,
      options.beautyShape ? null : tenant.petId,
      tenant.clientId,
      `${prefix} customer`,
      phone,
      tenant.serviceId,
      tenant.petId === null || options.beautyShape ? null : `${prefix} pet service`,
      tenant.petId === null || options.beautyShape ? null : 30,
      tenant.petId === null || options.beautyShape ? null : 0,
      options.state ?? "activo",
    ],
  );
  return result.insertId;
}

before(async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  fechaManana = tomorrow.toISOString().split("T")[0];

  const beauty = await createTenant("BEAUTY", 1);
  const pet = await createTenant("PET_GROOMING", 2);
  await createTurno(beauty);
  await createTurno(pet);
  await createTurno(pet, { beautyShape: true });
  await createTurno(beauty, { state: "cancelado" });
  const otherDate = new Date(`${fechaManana}T00:00:00.000Z`);
  otherDate.setUTCDate(otherDate.getUTCDate() + 2);
  await createTurno(beauty, { date: otherDate.toISOString().slice(0, 10) });
});

after(async () => {
  try {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const tenant of tenants) {
        const [rows] = await connection.query<RowDataPacket[]>("SELECT slug FROM locales WHERE id = ? FOR UPDATE", [tenant.id]);
        assert.equal(rows[0]?.slug, tenant.slug, "Fixture identity mismatch; stop cleanup");
        await connection.query("DELETE te FROM turno_extras te JOIN turnos t ON t.id = te.turno_id WHERE t.local_id = ?", [tenant.id]);
        await connection.query("DELETE FROM turnos WHERE local_id = ?", [tenant.id]);
        for (const table of ["mascota_extras", "mascota_servicios", "mascota_clientes", "pet_settings"] as const) {
          await connection.query(`DELETE FROM ${table} WHERE local_id = ?`, [tenant.id]);
        }
        await connection.query("DELETE FROM mascotas WHERE local_id = ?", [tenant.id]);
        await connection.query("DELETE FROM estilistas WHERE local_id = ?", [tenant.id]);
        await connection.query("DELETE FROM servicios WHERE local_id = ?", [tenant.id]);
        await connection.query("DELETE FROM clientes WHERE local_id = ?", [tenant.id]);
        await connection.query("DELETE FROM locales WHERE id = ? AND slug = ?", [tenant.id, tenant.slug]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } finally {
    await pool.end();
  }
});

test("cron BEAUTY excludes PET by business_type and keeps valid BEAUTY reminders", async (t: TestContext) => {
  const originalQuery = pool.query.bind(pool);
  let selectionSql = "";
  t.mock.method(pool, "query", (async (sql: string, values?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("FROM turnos t")) selectionSql = sql;
    return originalQuery(sql, values as never);
  }) as typeof pool.query);

  const sent: Array<{ phone: string; message: string; instance: string }> = [];
  await procesarRecordatorios(fechaManana, async (phone, message, instance) => {
    sent.push({ phone, message, instance });
  });

  assert.match(selectionSql, /l\.business_type\s*=\s*'BEAUTY'/);
  assert.match(selectionSql, /t\.mascota_id\s+IS\s+NULL/);
  assert.match(selectionSql, /t\.estilista_id\s+IS\s+NOT\s+NULL/);
  assert.match(selectionSql, /t\.fecha\s*=\s*\?/);
  assert.match(selectionSql, /t\.estado\s*=\s*'activo'/);
  assert.match(selectionSql, /t\.cliente_telefono\s+IS\s+NOT\s+NULL/);

  assert.equal(sent.length, 1, "Only the valid BEAUTY fixture should receive a reminder");
  assert.equal(sent[0].instance, String(tenants[0].id));
  assert.match(sent[0].message, new RegExp(prefix));
});
