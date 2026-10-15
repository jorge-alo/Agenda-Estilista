-- PET-06B: aplicar solamente en MySQL Docker local, agenda_db.
CREATE TABLE pet_settings (
  local_id INT NOT NULL,

  high_demand_rule VARCHAR(16) NOT NULL,
  high_demand_gap_minutes INT DEFAULT NULL,
  high_demand_max_per_day INT DEFAULT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (local_id),

  CONSTRAINT fk_pet_settings_local
    FOREIGN KEY (local_id)
    REFERENCES locales (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT chk_pet_settings_rule
    CHECK (
      high_demand_rule IN ('MIN_GAP', 'MAX_PER_DAY')
    ),

  CONSTRAINT chk_pet_settings_values
    CHECK (
      (
        high_demand_rule = 'MIN_GAP'
        AND high_demand_gap_minutes IS NOT NULL
        AND high_demand_gap_minutes > 0
        AND high_demand_max_per_day IS NULL
      )
      OR
      (
        high_demand_rule = 'MAX_PER_DAY'
        AND high_demand_max_per_day IS NOT NULL
        AND high_demand_max_per_day > 0
        AND high_demand_gap_minutes IS NULL
      )
    )
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;
