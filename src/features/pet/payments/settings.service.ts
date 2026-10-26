import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { PetDepositSettingsError, type PetDepositSettings, type PetDepositSettingsWrite } from "./settings.types";

interface LocalRow extends RowDataPacket {
  business_type: string;
  pet_deposit_enabled: number;
  pet_deposit_amount: string | null;
  mp_access_token: string | null;
}

function estado(row: LocalRow): PetDepositSettings {
  return {
    pet_deposit_enabled: row.pet_deposit_enabled === 1,
    pet_deposit_amount: row.pet_deposit_amount,
    currency: "ARS",
    mpConfigured: typeof row.mp_access_token === "string" && row.mp_access_token.trim().length > 0,
  };
}

function localPet(rows: LocalRow[]): LocalRow {
  if (!rows.length) throw new PetDepositSettingsError(404, "PET_LOCAL_NOT_FOUND");
  if (rows[0].business_type !== "PET_GROOMING") {
    throw new PetDepositSettingsError(403, "PET_BUSINESS_REQUIRED");
  }
  return rows[0];
}

const selectLocal = `SELECT business_type, pet_deposit_enabled, pet_deposit_amount, mp_access_token
                     FROM locales WHERE id = ?`;

export async function obtener(localId: number): Promise<PetDepositSettings> {
  const [rows] = await pool.query<LocalRow[]>(selectLocal, [localId]);
  return estado(localPet(rows));
}

export async function guardar(localId: number, payload: PetDepositSettingsWrite): Promise<PetDepositSettings> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // Serializa esta verificación con las escrituras del token en la misma fila de locales.
    const [rows] = await connection.query<LocalRow[]>(`${selectLocal} FOR UPDATE`, [localId]);
    const local = localPet(rows);
    if (payload.pet_deposit_enabled && !estado(local).mpConfigured) {
      throw new PetDepositSettingsError(409, "PET_DEPOSIT_MP_REQUIRED");
    }
    await connection.query(
      "UPDATE locales SET pet_deposit_enabled = ?, pet_deposit_amount = ? WHERE id = ?",
      [payload.pet_deposit_enabled ? 1 : 0, payload.pet_deposit_amount, localId],
    );
    const [updated] = await connection.query<LocalRow[]>(selectLocal, [localId]);
    const result = estado(localPet(updated));
    await connection.commit();
    return result;
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
