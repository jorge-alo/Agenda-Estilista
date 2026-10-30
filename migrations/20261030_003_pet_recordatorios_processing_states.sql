-- NOTIF-01 Fase 1B: estados de procesamiento PET; aplicar solo en Docker local.
-- No modifica el transporte BEAUTY ni las migraciones 001/002.
ALTER TABLE pet_recordatorios
  DROP CHECK chk_pet_recordatorios_estado,
  DROP CHECK chk_pet_recordatorios_claim,
  ADD CONSTRAINT chk_pet_recordatorios_estado CHECK (
    estado IN ('pending', 'sending', 'dispatching', 'sent', 'unknown', 'skipped')
  ),
  ADD CONSTRAINT chk_pet_recordatorios_claim CHECK (
    (estado = 'pending' AND claimed_at IS NULL AND accepted_at IS NULL)
    OR (estado IN ('sending', 'dispatching', 'unknown', 'skipped')
      AND claimed_at IS NOT NULL AND accepted_at IS NULL)
    OR (estado = 'sent' AND claimed_at IS NOT NULL AND accepted_at IS NOT NULL)
  );
