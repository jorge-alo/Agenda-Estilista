-- PET-04B: aplicar solamente en MySQL Docker local, agenda_db.
CREATE TABLE extras (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,

  nombre VARCHAR(100) NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_extras_id_local (id, local_id),
  UNIQUE KEY uq_extras_nombre_local (nombre, local_id),

  KEY idx_extras_local (local_id),

  CONSTRAINT fk_extras_local
    FOREIGN KEY (local_id)
    REFERENCES locales (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE mascota_extras (
  local_id INT NOT NULL,
  mascota_id INT NOT NULL,
  extra_id INT NOT NULL,
  duracion_minutos INT NOT NULL,

  PRIMARY KEY (mascota_id, extra_id),

  KEY idx_mascota_extras_mascota_local
    (mascota_id, local_id),

  KEY idx_mascota_extras_extra_local
    (extra_id, local_id),

  CONSTRAINT fk_mascota_extras_mascota_local
    FOREIGN KEY (mascota_id, local_id)
    REFERENCES mascotas (id, local_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT fk_mascota_extras_extra_local
    FOREIGN KEY (extra_id, local_id)
    REFERENCES extras (id, local_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT chk_mascota_extras_duracion_positiva
    CHECK (duracion_minutos > 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;
