-- PET-11C.1: credenciales opacas PET. Aplicar solo en agenda_mysql / agenda_db.
-- Preflight: ambas tablas ausentes y clientes(id, local_id) UNIQUE / INT signed.
-- Los dos CREATE TABLE no son atomicos en MySQL: detenerse ante aplicacion parcial.
-- Fechas DATETIME(3) en UTC, suministradas explicitamente por el futuro service.
CREATE TABLE pet_access_tokens (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,
  cliente_id INT NOT NULL,
  purpose VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_pet_access_tokens_hash (token_hash),
  KEY idx_pet_access_tokens_cliente_local (cliente_id, local_id),
  KEY idx_pet_access_tokens_scope_created (local_id, cliente_id, purpose, created_at),

  CONSTRAINT fk_pet_access_tokens_cliente_local
    FOREIGN KEY (cliente_id, local_id) REFERENCES clientes (id, local_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT chk_pet_access_tokens_purpose
    CHECK (purpose IN ('PET_PUBLIC_LOGIN')),
  CONSTRAINT chk_pet_access_tokens_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT chk_pet_access_tokens_consumed_at
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CONSTRAINT chk_pet_access_tokens_revoked_at
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT chk_pet_access_tokens_terminal
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pet_client_sessions (
  id INT NOT NULL AUTO_INCREMENT,
  local_id INT NOT NULL,
  cliente_id INT NOT NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_pet_client_sessions_hash (token_hash),
  KEY idx_pet_client_sessions_cliente_local (cliente_id, local_id),

  CONSTRAINT fk_pet_client_sessions_cliente_local
    FOREIGN KEY (cliente_id, local_id) REFERENCES clientes (id, local_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT chk_pet_client_sessions_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT chk_pet_client_sessions_revoked_at
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
