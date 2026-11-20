-- PET D30: preferencia operativa reversible. No activa scheduler ni envios.
-- Ejecutar con writers de preferencias detenidos: DDL MySQL no transaccional.
ALTER TABLE pet_recurrencia_contactos
  DROP CHECK chk_pet_recurrencia_contacto_estado,
  ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN origen VARCHAR(32) NOT NULL DEFAULT 'legado',
  ADD COLUMN operador_id INT NULL,
  ADD COLUMN operacion_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD CONSTRAINT chk_pet_recurrencia_contacto_estado CHECK (
    (estado IN ('autorizada','habilitada') AND cliente_id_autorizado IS NOT NULL
      AND baja_at IS NULL AND referencia_baja IS NULL
      AND (estado <> 'autorizada' OR (verificada_at IS NOT NULL AND referencia_verificacion IS NOT NULL)))
    OR (estado = 'baja' AND baja_at IS NOT NULL AND referencia_baja IS NOT NULL
      AND CHAR_LENGTH(TRIM(referencia_baja)) > 0)
  );
-- Un snapshot de identidad operativa no es evidencia de consentimiento.
ALTER TABLE pet_recurrencia_contactos DROP CHECK chk_pet_recurrencia_contacto_evidencia,
  ADD CONSTRAINT chk_pet_recurrencia_contacto_evidencia CHECK (
    (verificada_at IS NULL AND referencia_verificacion IS NULL)
    OR (cliente_id_autorizado IS NOT NULL AND cliente_id_autorizado > 0 AND verificada_at IS NOT NULL
      AND referencia_verificacion IS NOT NULL AND CHAR_LENGTH(TRIM(referencia_verificacion)) > 0)
  );

CREATE TABLE pet_recurrencia_contacto_eventos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  local_id INT NOT NULL,
  telefono_normalizado VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT UNSIGNED NOT NULL,
  estado VARCHAR(16) NOT NULL,
  cliente_id INT NULL,
  origen VARCHAR(32) NOT NULL,
  operador_id INT NULL,
  operacion_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  registrada_at DATETIME(3) NOT NULL,
  verificada_at DATETIME(3) NULL,
  referencia_verificacion VARCHAR(255) NULL,
  baja_at DATETIME(3) NULL,
  referencia_baja VARCHAR(255) NULL,
  UNIQUE KEY uq_pet_contacto_revision(local_id, telefono_normalizado, revision),
  UNIQUE KEY uq_pet_contacto_operacion(local_id, operacion_id),
  CONSTRAINT fk_pet_contacto_evento_local FOREIGN KEY(local_id) REFERENCES locales(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Preservar el estado conocido, sin reconstruir ni inventar decisiones pasadas.
INSERT INTO pet_recurrencia_contacto_eventos
 (local_id,telefono_normalizado,revision,estado,cliente_id,origen,operador_id,operacion_id,
  registrada_at,verificada_at,referencia_verificacion,baja_at,referencia_baja)
SELECT local_id,telefono_normalizado,revision,estado,cliente_id_autorizado,'legado',NULL,NULL,
 updated_at,verificada_at,referencia_verificacion,baja_at,referencia_baja
FROM pet_recurrencia_contactos;

DROP TRIGGER trg_pet_recurrencia_contacto_bu;
DELIMITER $$
CREATE TRIGGER trg_pet_recurrencia_contacto_bu BEFORE UPDATE ON pet_recurrencia_contactos FOR EACH ROW
BEGIN
  IF NEW.local_id <> OLD.local_id OR NEW.telefono_normalizado <> OLD.telefono_normalizado THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_RECURRENCE_CONTACT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.estado = 'baja' AND NEW.estado <> 'baja' AND COALESCE((
    NEW.estado = 'habilitada' AND NEW.origen = 'ficha' AND NEW.operador_id > 0
    AND NEW.operacion_id IS NOT NULL AND NOT (NEW.operacion_id <=> OLD.operacion_id)
    AND NEW.verificada_at IS NULL AND NEW.referencia_verificacion IS NULL
  ),0) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_RECURRENCE_REACTIVATION_INVALID';
  END IF;
  SET NEW.revision = OLD.revision + 1;
END$$
CREATE TRIGGER trg_pet_recurrencia_contacto_ai AFTER INSERT ON pet_recurrencia_contactos FOR EACH ROW
BEGIN
  INSERT INTO pet_recurrencia_contacto_eventos
   (local_id,telefono_normalizado,revision,estado,cliente_id,origen,operador_id,operacion_id,
    registrada_at,verificada_at,referencia_verificacion,baja_at,referencia_baja)
  VALUES (NEW.local_id,NEW.telefono_normalizado,NEW.revision,NEW.estado,NEW.cliente_id_autorizado,
    NEW.origen,NEW.operador_id,NEW.operacion_id,NEW.updated_at,NEW.verificada_at,
    NEW.referencia_verificacion,NEW.baja_at,NEW.referencia_baja);
END$$
CREATE TRIGGER trg_pet_recurrencia_contacto_au AFTER UPDATE ON pet_recurrencia_contactos FOR EACH ROW
BEGIN
  INSERT INTO pet_recurrencia_contacto_eventos
   (local_id,telefono_normalizado,revision,estado,cliente_id,origen,operador_id,operacion_id,
    registrada_at,verificada_at,referencia_verificacion,baja_at,referencia_baja)
  VALUES (NEW.local_id,NEW.telefono_normalizado,NEW.revision,NEW.estado,NEW.cliente_id_autorizado,
    NEW.origen,NEW.operador_id,NEW.operacion_id,NEW.updated_at,NEW.verificada_at,
    NEW.referencia_verificacion,NEW.baja_at,NEW.referencia_baja);
END$$
CREATE TRIGGER trg_pet_contacto_evento_bu BEFORE UPDATE ON pet_recurrencia_contacto_eventos FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_RECURRENCE_HISTORY_IMMUTABLE';
END$$
CREATE TRIGGER trg_pet_contacto_evento_bd BEFORE DELETE ON pet_recurrencia_contacto_eventos FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_RECURRENCE_HISTORY_IMMUTABLE';
END$$
DELIMITER ;

-- Todos los responsables PET actuales elegibles. Ausencia de fila solamente:
-- no sobrescribir bajas, permisos verificados ni identidades historicas.
-- Operador NULL es intencional: origen real = migracion, no un usuario inventado.
INSERT INTO pet_recurrencia_contactos
 (local_id,telefono_normalizado,estado,cliente_id_autorizado,origen,created_at,updated_at)
SELECT c.local_id,c.telefono_normalizado,'habilitada',c.id,'incorporacion_inicial',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)
FROM clientes c JOIN locales l ON l.id=c.local_id AND l.business_type='PET_GROOMING'
WHERE c.telefono_normalizado REGEXP '^[+][1-9][0-9]{1,14}$'
 AND EXISTS (SELECT 1 FROM mascota_clientes mc WHERE mc.local_id=c.local_id AND mc.cliente_id=c.id)
 AND NOT EXISTS (SELECT 1 FROM pet_recurrencia_contactos pc
   WHERE pc.local_id=c.local_id AND pc.telefono_normalizado=c.telefono_normalizado);
