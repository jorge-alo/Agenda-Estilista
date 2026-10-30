-- NOTIF-01 Fase 1A. Aplicar solo en agenda_mysql / agenda_db tras verificar el preflight.
-- turnos.id es globalmente unico, pero no existe indice (id, local_id) para FK tenant-aware.
ALTER TABLE turnos ADD UNIQUE KEY uq_turnos_id_local_recordatorios (id, local_id);

CREATE TABLE pet_recordatorios (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,
  tipo VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  turno_id INT NULL,
  mascota_id INT NULL,
  ultimo_turno_completado_id INT NULL,
  cliente_id INT NULL,
  estado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  claimed_at DATETIME(3) NULL,
  accepted_at DATETIME(3) NULL,
  provider_message_id VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pet_recordatorios_turno (local_id, tipo, turno_id),
  UNIQUE KEY uq_pet_recordatorios_recurrencia (local_id, tipo, mascota_id, ultimo_turno_completado_id),
  KEY idx_pet_recordatorios_turno_local (turno_id, local_id),
  KEY idx_pet_recordatorios_ultimo_local (ultimo_turno_completado_id, local_id),
  KEY idx_pet_recordatorios_mascota_local (mascota_id, local_id),
  KEY idx_pet_recordatorios_cliente_local (cliente_id, local_id),
  KEY idx_pet_recordatorios_sending (estado, claimed_at),
  CONSTRAINT fk_pet_recordatorios_local FOREIGN KEY (local_id)
    REFERENCES locales (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_pet_recordatorios_turno FOREIGN KEY (turno_id, local_id)
    REFERENCES turnos (id, local_id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_pet_recordatorios_ultimo FOREIGN KEY (ultimo_turno_completado_id, local_id)
    REFERENCES turnos (id, local_id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_pet_recordatorios_mascota FOREIGN KEY (mascota_id, local_id)
    REFERENCES mascotas (id, local_id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_pet_recordatorios_cliente FOREIGN KEY (cliente_id, local_id)
    REFERENCES clientes (id, local_id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT chk_pet_recordatorios_identidad CHECK (
    (tipo = 'APPOINTMENT_REMINDER' AND turno_id IS NOT NULL
      AND mascota_id IS NULL AND ultimo_turno_completado_id IS NULL)
    OR
    (tipo = 'RECURRENCE_DAY_30' AND turno_id IS NULL
      AND mascota_id IS NOT NULL AND ultimo_turno_completado_id IS NOT NULL)
  ),
  CONSTRAINT chk_pet_recordatorios_estado CHECK (estado IN ('pending', 'sending', 'sent', 'unknown')),
  CONSTRAINT chk_pet_recordatorios_claim CHECK (
    (estado = 'pending' AND claimed_at IS NULL AND accepted_at IS NULL)
    OR (estado IN ('sending', 'unknown') AND claimed_at IS NOT NULL AND accepted_at IS NULL)
    OR (estado = 'sent' AND claimed_at IS NOT NULL AND accepted_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
