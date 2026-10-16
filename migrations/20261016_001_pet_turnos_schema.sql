-- PET-08A.1: aplicar solamente en MySQL Docker local, agenda_db.
-- Requiere el esquema verificado de turnos, mascotas y extras; no es idempotente.
ALTER TABLE turnos
  MODIFY COLUMN estilista_id INT NULL,
  MODIFY COLUMN cliente_nombre VARCHAR(255) NOT NULL,
  MODIFY COLUMN cliente_telefono VARCHAR(50) NOT NULL,

  ADD COLUMN mascota_id INT NULL,
  ADD COLUMN alta_exigencia_snapshot TINYINT(1) NULL DEFAULT NULL,
  ADD COLUMN servicio_nombre_snapshot VARCHAR(100) NULL,
  ADD COLUMN duracion_servicio_snapshot INT NULL,

  ADD KEY idx_turnos_mascota_local (mascota_id, local_id),
  ADD KEY idx_turnos_pet_agenda (local_id, fecha, estado, hora),

  ADD CONSTRAINT fk_turnos_mascota_local
    FOREIGN KEY (mascota_id, local_id)
    REFERENCES mascotas (id, local_id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,

  ADD CONSTRAINT chk_turnos_beauty_pet
    CHECK (
      (estilista_id IS NOT NULL AND mascota_id IS NULL)
      OR (estilista_id IS NULL AND mascota_id IS NOT NULL)
    ),

  ADD CONSTRAINT chk_turnos_alta_exigencia_snapshot
    CHECK (
      (mascota_id IS NULL AND alta_exigencia_snapshot IS NULL)
      OR (
        mascota_id IS NOT NULL
        AND alta_exigencia_snapshot IS NOT NULL
        AND alta_exigencia_snapshot IN (0, 1)
      )
    ),

  ADD CONSTRAINT chk_turnos_pet_hora_fin
    CHECK (
      mascota_id IS NULL
      OR (hora_fin IS NOT NULL AND hora < hora_fin)
    ),

  ADD CONSTRAINT chk_turnos_pet_servicio_snapshot
    CHECK (
      mascota_id IS NULL
      OR (
        servicio_nombre_snapshot IS NOT NULL
        AND duracion_servicio_snapshot IS NOT NULL
        AND duracion_servicio_snapshot > 0
      )
    );

CREATE TABLE turno_extras (
  id INT NOT NULL AUTO_INCREMENT,
  turno_id INT NOT NULL,
  extra_id INT NULL,
  nombre_snapshot VARCHAR(100) NOT NULL,
  duracion_minutos INT NOT NULL,

  PRIMARY KEY (id),

  UNIQUE KEY uq_turno_extras_turno_extra (turno_id, extra_id),
  KEY idx_turno_extras_extra (extra_id),

  CONSTRAINT fk_turno_extras_turno
    FOREIGN KEY (turno_id)
    REFERENCES turnos (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT fk_turno_extras_extra
    FOREIGN KEY (extra_id)
    REFERENCES extras (id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION,

  CONSTRAINT chk_turno_extras_duracion
    CHECK (duracion_minutos > 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;
