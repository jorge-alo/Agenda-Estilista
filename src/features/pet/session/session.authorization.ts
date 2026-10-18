import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { PetSessionRequestError, type PetSessionContext } from "./session.types";

interface SessionRow extends RowDataPacket { id: number; revoked_at: Date | null }
interface ExpiryRow extends RowDataPacket { vigente: number }

/** Caller already holds the local lock. Never use a pool/current Bearer as authority here. */
export async function bloquearSesionParaReserva(connection: PoolConnection, context: PetSessionContext): Promise<void> {
  const [rows] = await connection.query<SessionRow[]>(
    `SELECT id, revoked_at FROM pet_client_sessions
     WHERE id = ? AND local_id = ? AND cliente_id = ? FOR SHARE`,
    [context.sessionId, context.localId, context.clienteId],
  );
  if (!rows.length || rows[0].revoked_at !== null) {
    throw new PetSessionRequestError(401, "PET_SESSION_INVALID");
  }
  // A waiting statement's clock may predate lock acquisition. Start another
  // statement AFTER the session lock; repeat it immediately before COMMIT.
  await comprobarVigenciaSesion(connection, context);
}

export async function comprobarVigenciaSesion(connection: PoolConnection, context: PetSessionContext): Promise<void> {
  const [rows] = await connection.query<ExpiryRow[]>(
    `SELECT (revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)) AS vigente
     FROM pet_client_sessions WHERE id = ? AND local_id = ? AND cliente_id = ? FOR SHARE`,
    [context.sessionId, context.localId, context.clienteId],
  );
  if (rows[0]?.vigente !== 1) throw new PetSessionRequestError(401, "PET_SESSION_INVALID");
}
