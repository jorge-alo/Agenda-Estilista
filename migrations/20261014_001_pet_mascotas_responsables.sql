-- PET-02B: Mascotas + Responsables M:N
-- Aplicar solo en MySQL Docker local (agenda_mysql, agenda_db)

-- 1. Agregar índice único compuesto en clientes para soportar FK compuesta
ALTER TABLE clientes
  ADD UNIQUE KEY uq_clientes_id_local (id, local_id);

-- 2. Tabla mascotas
CREATE TABLE mascotas (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,

  nombre VARCHAR(255) NOT NULL,
  raza VARCHAR(100) DEFAULT NULL,
  fecha_nacimiento DATE DEFAULT NULL,
  sexo VARCHAR(20) DEFAULT NULL,
  tamano VARCHAR(20) DEFAULT NULL,
  tipo_pelo VARCHAR(50) DEFAULT NULL,
  observaciones TEXT DEFAULT NULL,

  alta_exigencia TINYINT(1) NOT NULL DEFAULT 0,
  reserva_online_habilitada TINYINT(1) NOT NULL DEFAULT 0,
  activo TINYINT(1) NOT NULL DEFAULT 1,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  UNIQUE KEY uq_mascotas_id_local (id, local_id),

  KEY idx_mascotas_local (local_id),

  CONSTRAINT fk_mascotas_local
    FOREIGN KEY (local_id)
    REFERENCES locales (id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- 3. Tabla puente mascota_clientes (M:N)
CREATE TABLE mascota_clientes (
  local_id INT NOT NULL,
  mascota_id INT NOT NULL,
  cliente_id INT NOT NULL,

  PRIMARY KEY (mascota_id, cliente_id),

  KEY idx_mascota_clientes_mascota_local
    (mascota_id, local_id),

  KEY idx_mascota_clientes_cliente_local
    (cliente_id, local_id),

  CONSTRAINT fk_mascota_clientes_mascota_local
    FOREIGN KEY (mascota_id, local_id)
    REFERENCES mascotas (id, local_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT fk_mascota_clientes_cliente_local
    FOREIGN KEY (cliente_id, local_id)
    REFERENCES clientes (id, local_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;