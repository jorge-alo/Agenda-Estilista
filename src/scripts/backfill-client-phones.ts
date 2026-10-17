import dotenv from "dotenv";
import mysql from "mysql2/promise";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { InvalidClientPhoneError, normalizeClientPhone } from "../shared/phone/normalizeClientPhone";

interface ClientRow extends RowDataPacket {
  id: number;
  local_id: number;
  telefono: string;
  telefono_normalizado: string | null;
}

const expectedInvalid = ["4:6", "4:8", "4:9"];

async function run(): Promise<void> {
  dotenv.config({ quiet: true });
  const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
  if (!["localhost", "127.0.0.1", "::1"].includes(DB_HOST ?? "") || Number(DB_PORT) !== 3307 || DB_NAME !== "agenda_db") {
    throw new Error("Destino Docker local no verificado");
  }

  const pool = mysql.createPool({
    host: DB_HOST, port: Number(DB_PORT), database: DB_NAME, user: DB_USER, password: DB_PASSWORD,
    waitForConnections: true, connectionLimit: 2, queueLimit: 0,
  });
  try {
    const [[destination]] = await pool.query<(RowDataPacket & { host: string; db: string })[]>(
      "SELECT @@hostname AS host, DATABASE() AS db",
    );
    if (destination.host !== "570d7d86a989" || destination.db !== "agenda_db") {
      throw new Error("Contenedor/base inesperados");
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [clients] = await connection.query<ClientRow[]>(
        "SELECT id, local_id, telefono, telefono_normalizado FROM clientes ORDER BY id FOR UPDATE",
      );
      if (clients.length !== 10) throw new Error("Cambió el total histórico de clientes");

      const invalid: string[] = [];
      const canonicalByTenant = new Set<string>();
      let updates = 0;
      for (const client of clients) {
        let canonical: string;
        try {
          canonical = normalizeClientPhone(client.telefono);
        } catch (error) {
          if (!(error instanceof InvalidClientPhoneError)) throw error;
          invalid.push(`${client.local_id}:${client.id}`);
          if (client.telefono_normalizado !== null) throw new Error("Cliente inválido con canonical existente");
          continue;
        }

        const key = `${client.local_id}:${canonical}`;
        if (canonicalByTenant.has(key)) throw new Error("Colisión canónica detectada");
        canonicalByTenant.add(key);
        if (client.telefono_normalizado !== null) {
          if (client.telefono_normalizado !== canonical) throw new Error("Canonical existente no coincide con helper");
          continue;
        }
        const [result] = await connection.query<ResultSetHeader>(
          `UPDATE clientes SET telefono_normalizado = ?
           WHERE id = ? AND local_id = ? AND telefono_normalizado IS NULL AND telefono = ?`,
          [canonical, client.id, client.local_id, client.telefono],
        );
        if (result.affectedRows !== 1) throw new Error("UPDATE no afectó exactamente un cliente");
        updates++;
      }

      if (invalid.join(",") !== expectedInvalid.join(",") || canonicalByTenant.size !== 7) {
        throw new Error("Conteos/IDs de preflight inesperados");
      }
      const [[counts]] = await connection.query<(RowDataPacket & { total: number; filled: number })[]>(
        "SELECT COUNT(*) AS total, COUNT(telefono_normalizado) AS filled FROM clientes",
      );
      const [nullRows] = await connection.query<(RowDataPacket & { id: number; local_id: number })[]>(
        "SELECT id, local_id FROM clientes WHERE telefono_normalizado IS NULL ORDER BY id",
      );
      if (counts.total !== 10 || counts.filled !== 7 ||
          nullRows.map(row => `${row.local_id}:${row.id}`).join(",") !== expectedInvalid.join(",")) {
        throw new Error("Integridad post-backfill inesperada; ROLLBACK");
      }
      await connection.commit();
      console.log(JSON.stringify({ total: counts.total, canonical: counts.filled, nullLegacy: nullRows.length,
        nullIds: nullRows.map(row => ({ clienteId: row.id, localId: row.local_id })), updates, colisiones: 0 }));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } finally {
    await pool.end();
  }
}

void run().catch(() => {
  console.error("Backfill detenido/rollback: verificar conteos, IDs o integridad (sin mostrar teléfonos).");
  process.exitCode = 1;
});
