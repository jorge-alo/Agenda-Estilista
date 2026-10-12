-- Permite registrar un intento de pago antes de crear
-- la preferencia de Mercado Pago.
-- Conserva VARCHAR(255) y los índices existentes.

ALTER TABLE pagos
  MODIFY COLUMN preference_id VARCHAR(255) NULL;
