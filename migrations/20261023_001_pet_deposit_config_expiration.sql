-- PET deposit phase 1: additive schema only. Apply first to verified local Docker agenda_db.
-- Not idempotent; do not alter existing migrations or apply to Railway without separate approval.
ALTER TABLE locales
  ADD COLUMN pet_deposit_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN pet_deposit_amount DECIMAL(10,2) NULL,
  ADD CONSTRAINT chk_locales_pet_deposit_enabled
    CHECK (pet_deposit_enabled IN (0, 1)),
  ADD CONSTRAINT chk_locales_pet_deposit_amount
    CHECK (pet_deposit_amount IS NULL OR pet_deposit_amount > 0),
  ADD CONSTRAINT chk_locales_pet_deposit_required
    CHECK (pet_deposit_enabled = 0 OR pet_deposit_amount IS NOT NULL);

ALTER TABLE turnos
  ADD COLUMN pet_deposit_expires_at DATETIME(3) NULL,
  ADD INDEX idx_turnos_pet_deposit_expiration
    (local_id, estado, pet_deposit_expires_at);
