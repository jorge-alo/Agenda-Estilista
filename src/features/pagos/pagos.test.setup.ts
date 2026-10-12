// Preparación exclusiva de tests: sustituye config/db antes de importarlo.
// No carga .env. Solo permite el MySQL del contenedor Docker local conocido.
import { execFileSync } from "node:child_process";
import Module from "node:module";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";

interface DockerContainer {
  Config: { Image: string; Hostname: string; Env: string[] };
  State: { Running: boolean };
  NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> };
}

if (process.env.NODE_ENV === "production") {
  throw new Error("Tests abortados: NODE_ENV=production");
}

let container: DockerContainer;
try {
  // La salida se captura internamente: nunca se imprime la configuración
  // del contenedor ni las credenciales utilizadas para la conexión local.
  const output = execFileSync("docker", ["inspect", "agenda_mysql"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  const containers = JSON.parse(output) as DockerContainer[];
  if (containers.length !== 1) throw new Error("Contenedor inesperado");
  container = containers[0];
} catch {
  throw new Error("Tests abortados: no se pudo inspeccionar agenda_mysql local");
}

if (
  !container.State.Running ||
  container.Config.Image !== "mysql:8" ||
  !container.NetworkSettings.Ports["3306/tcp"]?.some((port) => port.HostPort === "3307")
) {
  throw new Error("Tests abortados: el contenedor no coincide con MySQL 8 local en puerto 3307");
}

const password = container.Config.Env
  .find((entry) => entry.startsWith("MYSQL_ROOT_PASSWORD="))
  ?.slice("MYSQL_ROOT_PASSWORD=".length);
if (!password) {
  throw new Error("Tests abortados: no está disponible la credencial del MySQL local");
}

const localPool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  user: "root",
  password,
  database: "agenda_db",
  connectionLimit: 4,
  waitForConnections: true,
});

let verification: Promise<void> | undefined;
function verifyLocalDatabase(): Promise<void> {
  verification ??= (async () => {
    let info: RowDataPacket[];
    try {
      [info] = await localPool.query<RowDataPacket[]>(
        "SELECT DATABASE() AS db, @@hostname AS host, @@port AS port"
      );
    } catch {
      throw new Error("Tests abortados: no se pudo verificar la conexión a MySQL Docker local");
    }
    if (
      info[0]?.db !== "agenda_db" ||
      info[0]?.host !== container.Config.Hostname ||
      Number(info[0]?.port) !== 3306
    ) {
      throw new Error("Tests abortados: la base conectada no corresponde al contenedor local");
    }

    const [columns] = await localPool.query<RowDataPacket[]>(
      `SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pagos'
         AND COLUMN_NAME = 'preference_id'`
    );
    if (columns[0]?.COLUMN_TYPE !== "varchar(255)" || columns[0]?.IS_NULLABLE !== "YES") {
      throw new Error("Tests abortados: falta aplicar manualmente la migración de preference_id en Docker local");
    }
  })();
  return verification;
}

const query = (async (sql: string, values?: Parameters<Pool["query"]>[1]) => {
  await verifyLocalDatabase();
  return localPool.query(sql, values);
}) as Pool["query"];

const guardedPool = {
  query,
  getConnection: async () => {
    await verifyLocalDatabase();
    return localPool.getConnection();
  },
  end: () => localPool.end(),
};

const dbPath = require.resolve("../../config/db");
const stub = new Module(dbPath);
stub.filename = dbPath;
stub.loaded = true;
stub.exports = { pool: guardedPool };
require.cache[dbPath] = stub;
