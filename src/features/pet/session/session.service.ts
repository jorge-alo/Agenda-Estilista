import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { InvalidClientPhoneError, normalizeClientPhone } from "../../../shared/phone/normalizeClientPhone";
import { generateOpaqueSecret, hashOpaqueSecret } from "./opaqueSecret";
import { validatePetFrontendUrl } from "./session.link";
import { startPetAccessDelivery, type PetAccessDelivery } from "./session.notification";
import { PET_LOGIN_PURPOSE, PetSessionRequestError, validateSessionPhone } from "./session.types";

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
