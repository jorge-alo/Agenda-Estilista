-- NOTIF-01 Fase 1A: destinatario nullable sin perder la identidad historica.
-- Requiere 20261030_001_pet_recordatorios.sql; aplicar solo en agenda_mysql / agenda_db.
-- MySQL DDL no es transaccional: no reejecutar si una sentencia intermedia falla.
ALTER TABLE pet_recordatorios
  ADD COLUMN cliente_local_id INT NULL AFTER cliente_id;

-- Compatible tambien con filas anteriores a esta migracion.
UPDATE pet_recordatorios
SET cliente_local_id = local_id
WHERE cliente_id IS NOT NULL;

-- SET NULL afecta ambas columnas hijas de la FK, nunca el local_id de la identidad.
-- MySQL 8.4 impide CHECK sobre columnas con acciones referenciales SET NULL;
-- la validacion equivalente se realiza con triggers para INSERT/UPDATE directos.
ALTER TABLE pet_recordatorios
  DROP FOREIGN KEY fk_pet_recordatorios_cliente,
  DROP INDEX idx_pet_recordatorios_cliente_local,
  ADD KEY idx_pet_recordatorios_destinatario (cliente_id, cliente_local_id),
  ADD CONSTRAINT fk_pet_recordatorios_destinatario
    FOREIGN KEY (cliente_id, cliente_local_id) REFERENCES clientes (id, local_id)
    ON DELETE SET NULL ON UPDATE NO ACTION;

-- Cascadas InnoDB no invocan triggers del child: DELETE del cliente anula ambas
-- columnas de destinatario y conserva la fila/UNIQUE historicos.
DELIMITER $$
CREATE TRIGGER trg_pet_recordatorios_destinatario_bi
BEFORE INSERT ON pet_recordatorios FOR EACH ROW
BEGIN
  IF (NEW.cliente_id IS NULL AND NEW.cliente_local_id IS NOT NULL)
    OR (NEW.cliente_id IS NOT NULL AND NEW.cliente_local_id IS NULL)
    OR (NEW.cliente_id IS NOT NULL AND NEW.cliente_local_id IS NOT NULL
      AND NEW.cliente_local_id <> NEW.local_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_REMINDER_RECIPIENT_INVALID';
  END IF;
END$$

CREATE TRIGGER trg_pet_recordatorios_destinatario_bu
BEFORE UPDATE ON pet_recordatorios FOR EACH ROW
BEGIN
  IF (NEW.cliente_id IS NULL AND NEW.cliente_local_id IS NOT NULL)
    OR (NEW.cliente_id IS NOT NULL AND NEW.cliente_local_id IS NULL)
    OR (NEW.cliente_id IS NOT NULL AND NEW.cliente_local_id IS NOT NULL
      AND NEW.cliente_local_id <> NEW.local_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PET_REMINDER_RECIPIENT_INVALID';
  END IF;
END$$
DELIMITER ;
