import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { InvalidClientPhoneError, normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { generateOpaqueSecret, hashOpaqueSecret } from "./opaqueSecret";
import { validatePetFrontendUrl } from "./session.link";
import { startPetAccessDelivery, type PetAccessDelivery } from "./session.notification";
import {
  PET_LOGIN_PURPOSE, PetSessionRequestError, validateConsumeToken, validateSessionPhone,
  type ConsumedPetAccess, type PetSessionContext,
} from "./session.types";

interface LocalRow extends RowDataPacket { id: number; slug: string; activo: number; business_type: string }
interface IdRow extends RowDataPacket { id: number }
interface ClientRow extends RowDataPacket { telefono_normalizado: string | null }
interface PetRow extends RowDataPacket { activo: number; reserva_online_habilitada: number }
interface QuotaRow extends RowDataPacket { cooldown: number; recent: number; daily: number }

async function hasEligiblePet(connection: PoolConnection, localId: number, clienteId: number): Promise<boolean> {
  // Discover candidates without locking a possibly empty JOIN/range. Then recheck
  // current pet flags and the actual M:N link under point locks, in stable order.
  const [candidates] = await connection.query<IdRow[]>(
    `SELECT m.id FROM mascota_clientes mc
     JOIN mascotas m ON m.id = mc.mascota_id AND m.local_id = mc.local_id
     WHERE mc.cliente_id = ? AND mc.local_id = ? AND m.local_id = ? ORDER BY m.id`,
    [clienteId, localId, localId],
  );
  for (const candidate of candidates) {
    const [pets] = await connection.query<PetRow[]>(
      "SELECT activo, reserva_online_habilitada FROM mascotas WHERE id = ? AND local_id = ? FOR SHARE",
      [candidate.id, localId],
    );
    if (!pets.length || pets[0].activo !== 1 || pets[0].reserva_online_habilitada !== 1) continue;
    const [links] = await connection.query<RowDataPacket[]>(
      "SELECT mascota_id FROM mascota_clientes WHERE mascota_id = ? AND cliente_id = ? AND local_id = ? FOR SHARE",
      [candidate.id, clienteId, localId],
    );
    if (links.length) return true;
  }
  return false;
}

async function issueChallenge(connection: PoolConnection, slug: string, body: unknown): Promise<PetAccessDelivery | null> {
  const [locals] = await connection.query<LocalRow[]>(
    "SELECT id, slug, activo, business_type FROM locales WHERE slug = ? FOR UPDATE", [slug],
  );
  if (!locals.length || locals[0].activo !== 1 || locals[0].business_type !== "PET_GROOMING") {
    throw new PetSessionRequestError(404, "PET_LOCAL_NOT_FOUND");
  }
  const local = locals[0];
  const phone = validateSessionPhone(body);
  // Uniform configuration validation for every valid-shaped input in a valid PET
  // local, before normalization/lookup, so misconfiguration cannot enumerate clients.
  const frontendBase = validatePetFrontendUrl(process.env.FRONTEND_URL, process.env.NODE_ENV);
  let canonical: string;
  try { canonical = normalizeClientPhone(phone); } catch (error) {
    if (error instanceof InvalidClientPhoneError) return null;
    throw error;
  }

  // The first consistent read happens AFTER the local lock (PET-08/PET-10C pattern).
  const [clients] = await connection.query<IdRow[]>(
    "SELECT id FROM clientes WHERE telefono_normalizado = ? AND local_id = ?", [canonical, local.id],
  );
  if (!clients.length) return null;
  const clienteId = clients[0].id;
  const [quotas] = await connection.query<QuotaRow[]>(
    `SELECT COALESCE(MAX(created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)), 0) AS cooldown,
            COALESCE(SUM(created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE)), 0) AS recent,
            COUNT(*) AS daily
     FROM pet_access_tokens WHERE local_id = ? AND cliente_id = ? AND purpose = ?
       AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)`,
    [local.id, clienteId, PET_LOGIN_PURPOSE],
  );
  // Count ALL emissions, including consumed/revoked challenges. Suppression must
  // leave the existing link untouched, even when that link is still active.
  if (Number(quotas[0].cooldown) || Number(quotas[0].recent) >= 3 || Number(quotas[0].daily) >= 10) return null;

  const [previous] = await connection.query<IdRow[]>(
    `SELECT id FROM pet_access_tokens WHERE local_id = ? AND cliente_id = ? AND purpose = ?
       AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY id`,
    [local.id, clienteId, PET_LOGIN_PURPOSE],
  );
  for (const row of previous) {
    await connection.query(
      "SELECT id FROM pet_access_tokens WHERE id = ? AND local_id = ? AND cliente_id = ? AND purpose = ? FOR UPDATE",
      [row.id, local.id, clienteId, PET_LOGIN_PURPOSE],
    );
  }
  const [current] = await connection.query<ClientRow[]>(
    "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE", [clienteId, local.id],
  );
  if (!current.length || current[0].telefono_normalizado !== canonical) return null;
  if (!await hasEligiblePet(connection, local.id, clienteId)) return null;

  for (const row of previous) {
    await connection.query(
      `UPDATE pet_access_tokens SET revoked_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND local_id = ? AND cliente_id = ? AND purpose = ?
         AND consumed_at IS NULL AND revoked_at IS NULL`,
      [row.id, local.id, clienteId, PET_LOGIN_PURPOSE],
    );
  }
  const secret = generateOpaqueSecret();
  await connection.query(
    `INSERT INTO pet_access_tokens (local_id, cliente_id, purpose, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE), UTC_TIMESTAMP(3))`,
    [local.id, clienteId, PET_LOGIN_PURPOSE, hashOpaqueSecret(secret)],
  );
  return { localId: local.id, canonical, slug: local.slug, secret, frontendBase };
}

export async function requestPetAccess(slug: string, body: unknown): Promise<void> {
  if (!slug || slug.length > 100) throw new PetSessionRequestError(404, "PET_LOCAL_NOT_FOUND");
  const connection = await pool.getConnection();
  let delivery: PetAccessDelivery | null;
  try {
    await connection.beginTransaction();
    delivery = await issueChallenge(connection, slug, body);
    await connection.commit();
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  // Nothing involving a secret/link or the transport can trigger a DB rollback now.
  if (delivery) startPetAccessDelivery(delivery);
}

interface AccessTokenRow extends RowDataPacket {
  id: number;
  cliente_id: number;
  purpose: string;
  consumed_at: Date | null;
  revoked_at: Date | null;
}
interface ExpiryRow extends RowDataPacket { unexpired: number }
interface PersistedExpiryRow extends RowDataPacket { expiresAt: string }

export async function consumePetAccess(slug: string, body: unknown): Promise<ConsumedPetAccess> {
  // Reject malformed credentials before even acquiring a DB connection.
  const token = validateConsumeToken(body);
  if (!slug || slug.length > 100) throw new PetSessionRequestError(404, "PET_LOCAL_NOT_FOUND");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [locals] = await connection.query<LocalRow[]>(
      "SELECT id, slug, activo, business_type FROM locales WHERE slug = ? FOR UPDATE", [slug],
    );
    if (!locals.length || locals[0].activo !== 1 || locals[0].business_type !== "PET_GROOMING") {
      throw new PetSessionRequestError(404, "PET_LOCAL_NOT_FOUND");
    }
    const localId = locals[0].id;
    const [challenges] = await connection.query<AccessTokenRow[]>(
      `SELECT id, cliente_id, purpose, consumed_at, revoked_at FROM pet_access_tokens
       WHERE token_hash = ? AND local_id = ? FOR UPDATE`, [hashOpaqueSecret(token), localId],
    );
    const challenge = challenges[0];
    if (!challenge || challenge.purpose !== PET_LOGIN_PURPOSE ||
        challenge.consumed_at !== null || challenge.revoked_at !== null) {
      throw new PetSessionRequestError(401, "PET_ACCESS_INVALID");
    }
    // MySQL's clock expression in a waiting SELECT could predate lock acquisition.
    // This separate statement starts AFTER the challenge lock has been acquired.
    const [expiry] = await connection.query<ExpiryRow[]>(
      "SELECT expires_at > UTC_TIMESTAMP(3) AS unexpired FROM pet_access_tokens WHERE id = ? AND local_id = ?",
      [challenge.id, localId],
    );
    if (expiry[0]?.unexpired !== 1) throw new PetSessionRequestError(401, "PET_ACCESS_INVALID");
    const [clients] = await connection.query<ClientRow[]>(
      "SELECT telefono_normalizado FROM clientes WHERE id = ? AND local_id = ? FOR SHARE",
      [challenge.cliente_id, localId],
    );
    if (!clients.length || clients[0].telefono_normalizado === null ||
        !await hasEligiblePet(connection, localId, challenge.cliente_id)) {
      throw new PetSessionRequestError(401, "PET_ACCESS_INVALID");
    }

    const sessionToken = generateOpaqueSecret();
    const [consumed] = await connection.query<ResultSetHeader>(
      `UPDATE pet_access_tokens SET consumed_at = UTC_TIMESTAMP(3)
       WHERE id = ? AND local_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > UTC_TIMESTAMP(3)`, [challenge.id, localId],
    );
    if (consumed.affectedRows !== 1) throw new PetSessionRequestError(401, "PET_ACCESS_INVALID");
    const [inserted] = await connection.query<ResultSetHeader>(
      `INSERT INTO pet_client_sessions (local_id, cliente_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 12 HOUR), UTC_TIMESTAMP(3))`,
      [localId, challenge.cliente_id, hashOpaqueSecret(sessionToken)],
    );
    // Format the actual inserted DATETIME(3) as UTC text, without mysql2/JS Date conversion.
    const [persisted] = await connection.query<PersistedExpiryRow[]>(
      `SELECT CONCAT(DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.'),
                     LEFT(DATE_FORMAT(expires_at, '%f'), 3), 'Z') AS expiresAt
       FROM pet_client_sessions WHERE id = ? AND local_id = ? AND cliente_id = ?`,
      [inserted.insertId, localId, challenge.cliente_id],
    );
    if (!persisted.length) throw new Error("PET_SESSION_INSERT_NOT_VISIBLE");
    await connection.commit();
    // No response/secret can escape before a successful COMMIT; finally releases first.
    return { sessionToken, expiresAt: persisted[0].expiresAt };
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

interface SessionContextRow extends RowDataPacket, PetSessionContext {}

export async function findPetPublicSession(slug: string, secret: string): Promise<PetSessionContext | null> {
  if (!slug || slug.length > 100) return null;
  const [sessions] = await pool.query<SessionContextRow[]>(
    `SELECT s.id AS sessionId, s.local_id AS localId, s.cliente_id AS clienteId
     FROM pet_client_sessions s
     JOIN clientes c ON c.id = s.cliente_id AND c.local_id = s.local_id
     JOIN locales l ON l.id = s.local_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3)
       AND l.slug = ? AND l.activo = 1 AND l.business_type = 'PET_GROOMING'`,
    [hashOpaqueSecret(secret), slug],
  );
  if (!sessions.length) return null;
  const { sessionId, localId, clienteId } = sessions[0];
  return { sessionId, localId, clienteId };
}
