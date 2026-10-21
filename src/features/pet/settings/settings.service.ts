import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../../config/db";
import type { HighDemandRule, PetSettings, PetSettingsPayload } from "./settings.types";

type SettingsRow = RowDataPacket & {
  high_demand_rule: HighDemandRule;
  high_demand_gap_minutes: number | null;
  high_demand_max_per_day: number | null;
};

const SIN_CONFIGURAR: PetSettings = {
  configured: false,
  highDemandRule: null,
  highDemandGapMinutes: null,
  highDemandMaxPerDay: null,
};

export async function obtener(localId: number): Promise<PetSettings> {
  const [rows] = await pool.query<SettingsRow[]>(
    `SELECT high_demand_rule, high_demand_gap_minutes, high_demand_max_per_day
     FROM pet_settings WHERE local_id = ?`,
    [localId]
  );
  if (!rows.length) return SIN_CONFIGURAR;
  const row = rows[0];
  return {
    configured: true,
    highDemandRule: row.high_demand_rule,
    highDemandGapMinutes: row.high_demand_gap_minutes,
    highDemandMaxPerDay: row.high_demand_max_per_day,
  };
}

export async function guardar(localId: number, payload: PetSettingsPayload): Promise<PetSettings> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // The upsert has a local FK: acquire local before settings, as online/booking do.
    await connection.query("SELECT id FROM locales WHERE id = ? FOR UPDATE", [localId]);
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
    return { configured: true, ...payload };
  } catch (error: unknown) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
