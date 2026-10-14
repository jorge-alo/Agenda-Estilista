-- PET-03B: aplicar solamente en MySQL Docker local, agenda_db.
ALTER TABLE servicios
  ADD UNIQUE KEY uq_servicios_id_local (id, local_id);

CREATE TABLE mascota_servicios (
  local_id INT NOT NULL,
  mascota_id INT NOT NULL,
  servicio_id INT NOT NULL,
  duracion_minutos INT NOT NULL,

  PRIMARY KEY (mascota_id, servicio_id),
  KEY idx_mascota_servicios_mascota_local (mascota_id, local_id),
  KEY idx_mascota_servicios_servicio_local (servicio_id, local_id),

  CONSTRAINT fk_mascota_servicios_mascota_local
    FOREIGN KEY (mascota_id, local_id)
    REFERENCES mascotas (id, local_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT fk_mascota_servicios_servicio_local
    FOREIGN KEY (servicio_id, local_id)
    REFERENCES servicios (id, local_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT chk_mascota_servicios_duracion_positiva
    CHECK (duracion_minutos > 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;
