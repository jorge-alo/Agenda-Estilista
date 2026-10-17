-- PET-10C.1: trazabilidad de conversión. Aplicar después de PET-10B.
-- Requiere que no existan solicitudes CONVERTIDA sin referencias (verificar antes de aplicar).
ALTER TABLE solicitudes_pet
  ADD COLUMN cliente_id INT DEFAULT NULL,
  ADD COLUMN mascota_id INT DEFAULT NULL,
  ADD COLUMN converted_at DATETIME DEFAULT NULL,
  ADD KEY idx_solicitudes_pet_cliente_local (cliente_id, local_id),
  ADD KEY idx_solicitudes_pet_mascota_local (mascota_id, local_id),
  ADD CONSTRAINT fk_solicitudes_pet_cliente_local
    FOREIGN KEY (cliente_id, local_id) REFERENCES clientes (id, local_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT fk_solicitudes_pet_mascota_local
    FOREIGN KEY (mascota_id, local_id) REFERENCES mascotas (id, local_id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT chk_solicitudes_pet_conversion CHECK (
    (estado = 'CONVERTIDA' AND cliente_id IS NOT NULL AND mascota_id IS NOT NULL AND converted_at IS NOT NULL)
    OR
    (estado <> 'CONVERTIDA' AND cliente_id IS NULL AND mascota_id IS NULL AND converted_at IS NULL)
  );
