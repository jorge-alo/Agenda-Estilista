import assert from "node:assert/strict";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";

const children = ["mascota_servicios", "mascota_clientes", "pet_settings", "servicios", "mascotas", "clientes"] as const;
const unexpected = ["turnos", "solicitudes_pet", "extras", "mascota_extras", "pet_access_tokens", "pet_client_sessions",
  "usuarios", "estilistas", "pagos", "pagos_suscripcion", "horarios_local", "bloqueos_local", "bloqueos_horarios"] as const;

/** Read-only verification by the exact IDs registered by this process, including after cleanup. */
export async function assertNoMascotaFixtures(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  for (const table of ["locales", ...children, ...unexpected] as const) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM ${table} WHERE ${table === "locales" ? "id" : "local_id"} IN (${placeholders})`, ids,
    );
    assert.equal(Number(rows[0].total), 0, `Fixture residual en ${table}`);
  }
}

/** Only for these isolated suites: exact process-owned local + UUID slug, never a name/range cleanup. */
export async function cleanupMascotaFixture(id: number, slug: string): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [locals] = await connection.query<(RowDataPacket & { slug: string })[]>(
      "SELECT slug FROM locales WHERE id = ? FOR UPDATE", [id],
    );
    if (locals.length) {
      assert.equal(locals[0].slug, slug, "La identidad del fixture cambió; no limpiar");
      for (const table of unexpected) {
        const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${table} WHERE local_id = ?`, [id]);
        assert.equal(Number(rows[0].total), 0, `Dependencia inesperada en ${table}; detener cleanup`);
      }
      // Bridges first, then the non-cascading service FK, then the remaining
      // parents. Explicit deletes make every fixture family's lifecycle visible.
      for (const table of children) await connection.query(`DELETE FROM ${table} WHERE local_id = ?`, [id]);
      await connection.query("DELETE FROM locales WHERE id = ? AND slug = ?", [id, slug]);
    }
    await connection.commit();
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  await assertNoMascotaFixtures([id]);
}
