-- PET-05B: aplicar solamente en MySQL Docker local, agenda_db.
CREATE TABLE horarios_local (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,
  dia_semana INT NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fin TIME NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_horarios_local_intervalo
    (local_id, dia_semana, hora_inicio, hora_fin),
  KEY idx_horarios_local_dia_activo
    (local_id, dia_semana, activo),
  CONSTRAINT fk_horarios_local_local
    FOREIGN KEY (local_id) REFERENCES locales (id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT chk_horarios_local_dia
    CHECK (dia_semana BETWEEN 0 AND 6),
  CONSTRAINT chk_horarios_local_intervalo
    CHECK (
      hora_inicio >= '00:00:00'
      AND hora_fin <= '23:59:59'
      AND hora_inicio < hora_fin
    )
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE bloqueos_local (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,
  fecha DATE NOT NULL,
  hora_inicio TIME DEFAULT NULL,
  hora_fin TIME DEFAULT NULL,
  motivo VARCHAR(255) DEFAULT NULL,
  es_dia_completo TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bloqueos_local_fecha (local_id, fecha),
  CONSTRAINT fk_bloqueos_local_local
    FOREIGN KEY (local_id) REFERENCES locales (id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT chk_bloqueos_local_dia_completo
    CHECK (es_dia_completo IN (0, 1)),
  CONSTRAINT chk_bloqueos_local_intervalo
    CHECK (
      (
        es_dia_completo = 1
        AND hora_inicio IS NULL
        AND hora_fin IS NULL
      )
      OR
      (
        es_dia_completo = 0
        AND hora_inicio IS NOT NULL
        AND hora_fin IS NOT NULL
        AND hora_inicio >= '00:00:00'
        AND hora_fin <= '23:59:59'
        AND hora_inicio < hora_fin
      )
    )
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;
