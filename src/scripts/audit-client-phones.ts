import dotenv from "dotenv";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { InvalidClientPhoneError, normalizeClientPhone } from "../shared/phone/normalizeClientPhone";

interface ClientPhoneRow extends RowDataPacket {
  id: number;
  local_id: number;
  telefono: string | null;
}

interface InvalidClientRow {
  clienteId: number;
  localId: number;
}

interface CollisionGroup {
  localId: number;
  clienteIds: number[];
}

async function auditClientPhones(): Promise<void> {
  dotenv.config({ quiet: true });

  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT);
  const database = process.env.DB_NAME;
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!host || !localHosts.has(host) || port !== 3307 || database !== "agenda_db") {
    throw new Error("Preflight detenido: requiere DB local loopback, puerto Docker 3307 y agenda_db");
  }

  const pool = mysql.createPool({
    host,
    port,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0,
  });

  try {
    const [targetRows] = await pool.query<(RowDataPacket & { db: string })[]>("SELECT DATABASE() AS db");
    if (targetRows[0]?.db !== "agenda_db") {
      throw new Error("Preflight detenido: base conectada inesperada");
    }

    const [clients] = await pool.query<ClientPhoneRow[]>(
      "SELECT id, local_id, telefono FROM clientes ORDER BY local_id, id",
    );
    const invalidos: InvalidClientRow[] = [];
    const canonicalByTenant = new Map<string, Map<number, number[]>>();

    for (const client of clients) {
      let canonical: string;
      try {
        canonical = normalizeClientPhone(client.telefono ?? "");
      } catch (error) {
        if (!(error instanceof InvalidClientPhoneError)) throw error;
        invalidos.push({ clienteId: client.id, localId: client.local_id });
        continue;
      }

      let tenantGroup = canonicalByTenant.get(canonical);
      if (!tenantGroup) {
        tenantGroup = new Map<number, number[]>();
        canonicalByTenant.set(canonical, tenantGroup);
      }
      const ids = tenantGroup.get(client.local_id) ?? [];
      ids.push(client.id);
      tenantGroup.set(client.local_id, ids);
    }

    const colisiones: CollisionGroup[] = [];
    for (const tenantGroup of canonicalByTenant.values()) {
      for (const [localId, clienteIds] of tenantGroup) {
        if (clienteIds.length > 1) colisiones.push({ localId, clienteIds: clienteIds.sort((a, b) => a - b) });
      }
    }

    const filasColisionadas = colisiones.reduce((total, group) => total + group.clienteIds.length, 0);
    const report: Record<string, unknown> = {
      totalClientes: clients.length,
      validos: clients.length - invalidos.length,
      invalidos: invalidos.length,
      gruposColision: colisiones.length,
      filasInvolucradasEnColisiones: filasColisionadas,
    };
    if (invalidos.length) report.invalidosIds = invalidos;
    if (colisiones.length) report.colisiones = colisiones;
    console.log(JSON.stringify(report, null, 2));

    if (invalidos.length || colisiones.length) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

void auditClientPhones().catch(() => {
  console.error("Preflight de identidad telefónica falló; no se imprimen datos de conexión ni teléfonos.");
  process.exitCode = 1;
});
