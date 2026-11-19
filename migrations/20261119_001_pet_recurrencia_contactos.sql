-- RECURRENCE_DAY_30: preparada, NO aplicada. No activa cron ni envios.
-- Preflight: MySQL 8 con CHECK enforced; locales.id INT signed e InnoDB.
-- Aplicacion Docker y Railway requieren autorizaciones separadas.
CREATE TABLE pet_recurrencia_contactos (
  local_id INT NOT NULL,
  telefono_normalizado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  estado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Snapshot historico, deliberadamente SIN FK a clientes: una baja debe sobrevivir
  -- a su borrado. El writer valida tenant/telefono actual bajo lock; el reader
  -- exige coincidencia con el cliente vigente. No concede permiso a un nuevo ID.
  cliente_id_autorizado INT NULL,
  verificada_at DATETIME(3) NULL,
  referencia_verificacion VARCHAR(255) NULL,
  baja_at DATETIME(3) NULL,
  referencia_baja VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (local_id, telefono_normalizado),
  CONSTRAINT fk_pet_recurrencia_contactos_local FOREIGN KEY (local_id)
    REFERENCES locales (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT chk_pet_recurrencia_contacto_telefono CHECK (
    telefono_normalizado REGEXP '^[+][1-9][0-9]{1,14}$'
  ),
  CONSTRAINT chk_pet_recurrencia_contacto_evidencia CHECK (
    (cliente_id_autorizado IS NULL AND verificada_at IS NULL AND referencia_verificacion IS NULL)
    OR (cliente_id_autorizado IS NOT NULL AND cliente_id_autorizado > 0 AND verificada_at IS NOT NULL
      AND referencia_verificacion IS NOT NULL AND CHAR_LENGTH(TRIM(referencia_verificacion)) > 0)
  ),
  CONSTRAINT chk_pet_recurrencia_contacto_estado CHECK (
    (estado = 'autorizada' AND cliente_id_autorizado IS NOT NULL
      AND verificada_at IS NOT NULL AND referencia_verificacion IS NOT NULL
      AND baja_at IS NULL AND referencia_baja IS NULL)
    OR (estado = 'baja' AND baja_at IS NOT NULL AND referencia_baja IS NOT NULL
      AND CHAR_LENGTH(TRIM(referencia_baja)) > 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- La importacion no es un mecanismo de reactivacion. No hay reactivacion en el piloto.
DELIMITER $$
CREATE TRIGGER trg_pet_recurrencia_contacto_bu
BEFORE UPDATE ON pet_recurrencia_contactos FOR EACH ROW
BEGIN
  IF NEW.local_id <> OLD.local_id OR NEW.telefono_normalizado <> OLD.telefono_normalizado THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_RECURRENCE_CONTACT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.estado = 'baja' AND NEW.estado <> 'baja' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_RECURRENCE_OPT_OUT_TERMINAL';
  END IF;
END$$
DELIMITER ;
