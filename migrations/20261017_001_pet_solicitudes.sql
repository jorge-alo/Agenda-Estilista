-- PET-10B: solicitudes públicas independientes de clientes y mascotas.
CREATE TABLE solicitudes_pet (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,
  responsable_nombre VARCHAR(255) NOT NULL,
  responsable_telefono VARCHAR(50) NOT NULL,
  responsable_telefono_secundario VARCHAR(50) DEFAULT NULL,
  mascota_nombre VARCHAR(255) NOT NULL,
  mascota_raza VARCHAR(100) DEFAULT NULL,
  mascota_fecha_nacimiento DATE DEFAULT NULL,
  mascota_tamano VARCHAR(20) DEFAULT NULL,
  mascota_sexo VARCHAR(20) DEFAULT NULL,
  motivo_contacto VARCHAR(500) DEFAULT NULL,
  estado VARCHAR(16) NOT NULL DEFAULT 'NUEVA',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_solicitudes_pet_local_estado_fecha (local_id, estado, created_at),
  KEY idx_solicitudes_pet_local_fecha (local_id, created_at),
  CONSTRAINT chk_solicitudes_pet_estado CHECK (estado IN ('NUEVA', 'CONTACTADA', 'CONVERTIDA', 'DESCARTADA')),
  CONSTRAINT fk_solicitudes_pet_local FOREIGN KEY (local_id) REFERENCES locales (id)
    ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
