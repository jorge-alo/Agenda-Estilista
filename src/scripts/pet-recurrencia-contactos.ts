import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

export function argumentosContactosRecurrencia(args: string[]) {
  if ((args.length !== 4 && args.length !== 5) || args[0] !== "--local-id"
    || !/^[1-9]\d*$/.test(args[1]) || !Number.isSafeInteger(Number(args[1]))
    || args[2] !== "--archivo" || !args[3] || (args.length === 5 && args[4] !== "--aplicar")
    || /^\.env(?:\.|$)/i.test(basename(args[3]))) {
    throw new Error("PET_RECURRENCE_ARGUMENTS_INVALID");
  }
  return { localId: Number(args[1]), archivo: args[3], aplicar: args[4] === "--aplicar" };
}

async function main(): Promise<void> {
  const { archivo, ...opciones } = argumentosContactosRecurrencia(process.argv.slice(2));
  if ((await stat(archivo)).size > 256 * 1024) throw new Error("PET_RECURRENCE_BATCH_TOO_LARGE");
  const text = await readFile(archivo, "utf8");
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("PET_RECURRENCE_BATCH_TOO_LARGE");
  const operaciones: unknown = JSON.parse(text);
  // No .env or Railway: same protected local target as the recurrence simulation.
  require("../features/pagos/pagos.test.setup");
  const { pool } = await import("../config/db");
  try {
    const { operarContactosRecurrencia } = await import("../features/pet/recordatorios/recurrencia.contactos");
    console.log(JSON.stringify(await operarContactosRecurrencia({ ...opciones, operaciones }), null, 2));
  } finally { await pool.end(); }
}

if (require.main === module) {
  void main().catch(() => {
    // Never print raw input, path, phone, evidence or SQL/connection errors.
    console.error("Operación de contactos PET detenida: revisar lote, argumentos, Docker y migración pendiente. Sin datos sensibles.");
    process.exitCode = 1;
  });
}
