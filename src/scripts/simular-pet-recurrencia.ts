/** Explicit Docker-only entrypoint. Never loads .env or accepts a backdated clock/consent override. */
export function argumentosSimulacionRecurrencia(args: string[]) {
  if (args.length !== 4 || args[0] !== "--local-id" || !/^[1-9]\d*$/.test(args[1])
    || args[2] !== "--frontend-url" || !args[3]) {
    throw new Error("Uso: --local-id ID --frontend-url URL_HTTPS");
  }
  const localId = Number(args[1]);
  if (!Number.isSafeInteger(localId)) throw new Error("PET_RECURRENCE_LOCAL_INVALID");
  return { localId, frontendUrl: args[3] };
}

async function main(): Promise<void> {
  const opciones = argumentosSimulacionRecurrencia(process.argv.slice(2));
  // Reuse the existing guarded Docker pool before importing config/db or feature code.
  // Refuses NODE_ENV=production and verifies container, loopback port and DB identity.
  require("../features/pagos/pagos.test.setup");
  const { pool } = await import("../config/db");
  try {
    const { simularRecurrenciaPet } = await import("../features/pet/recordatorios/recurrencia.service");
    console.log(JSON.stringify(await simularRecurrenciaPet(opciones), null, 2));
  } finally { await pool.end(); }
}

if (require.main === module) {
  void main().catch(() => {
    console.error("Simulación PET detenida: revisar argumentos, Docker local y esquema. Sin envíos ni datos sensibles.");
    process.exitCode = 1;
  });
}
