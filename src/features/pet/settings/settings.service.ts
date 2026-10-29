import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import { validarCapacidadPet } from "../disponibilidad/disponibilidad.service";
import { PetSettingsError, validarCapacidadPayload, type HighDemandRule, type PetCapacityPayload, type PetSettings, type PetSettingsPayload } from "./settings.types";

type SettingsRow = RowDataPacket & {
  high_demand_rule: HighDemandRule;
  high_demand_gap_minutes: number | null;
  high_demand_max_per_day: number | null;
};

type LocalRow = RowDataPacket & { business_type: string; pet_concurrent_capacity: number };

const SIN_CONFIGURAR = {
  configured: false,
  highDemandRule: null,
  highDemandGapMinutes: null,
  highDemandMaxPerDay: null,
};

export async function obtener(localId: number): Promise<PetSettings> {
  const [locales] = await pool.query<LocalRow[]>(
    "SELECT pet_concurrent_capacity, business_type FROM locales WHERE id = ? AND business_type = 'PET_GROOMING'", [localId],
  );
  if (!locales.length) throw new PetSettingsError(404, "Local PET no encontrado");
  const petConcurrentCapacity = validarCapacidadPet(locales[0].pet_concurrent_capacity);
  const [rows] = await pool.query<SettingsRow[]>(
    `SELECT high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day
     FROM pet_settings WHERE local_id = ?`,
    [localId]
  );
  if (!rows.length) return { ...SIN_CONFIGURAR, petConcurrentCapacity };
  const row = rows[0];
  return {
    configured: true,
    highDemandRule: row.high_demand_rule,
    highDemandGapMinutes: row.high_demand_gap_minutes,
    highDemandMaxPerDay: row.high_demand_max_per_day,
    petConcurrentCapacity,
  };
}

export async function guardar(localId: number, payload: PetSettingsPayload): Promise<PetSettings> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // The upsert has a local FK: acquire local before settings, as online/booking do.
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT pet_concurrent_capacity, business_type FROM locales WHERE id = ? FOR UPDATE", [localId]);
    if (!locales.length || locales[0].business_type !== "PET_GROOMING") throw new PetSettingsError(403, "Local PET requerido");
    await connection.query(
      `INSERT INTO pet_settings
       (local_id, high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day)
     VALUES (?, ?, ?, ?) AS nuevo
     ON DUPLICATE KEY UPDATE
       high_demand_rule = nuevo.high_demand_rule,
       high_demand_gap_minutes = nuevo.high_demand_gap_minutes,
       high_demand_max_per_day = nuevo.high_demand_max_per_day`,
      [localId, payload.highDemandRule, payload.highDemandGapMinutes, payload.highDemandMaxPerDay],
    );
    await connection.commit();
    return { configured: true, ...payload, petConcurrentCapacity: validarCapacidadPet(locales[0].pet_concurrent_capacity) };
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function guardarCapacidad(localId: number, body: unknown): Promise<PetCapacityPayload> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [locales] = await connection.query<LocalRow[]>(
      "SELECT business_type, pet_concurrent_capacity FROM locales WHERE id = ? FOR UPDATE", [localId]);
    if (!locales.length || locales[0].business_type !== "PET_GROOMING") throw new PetSettingsError(403, "Local PET requerido");
    const payload = validarCapacidadPayload(body);
    await connection.query(
      "UPDATE locales SET pet_concurrent_capacity = ? WHERE id = ? AND business_type = 'PET_GROOMING'",
      [payload.petConcurrentCapacity, localId],
    );
    await connection.commit();
    return payload;
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
