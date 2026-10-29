-- PET concurrent capacity, additive schema only. Apply once to verified local Docker agenda_db.
-- Not idempotent; Railway requires separate approval.
ALTER TABLE locales
  ADD COLUMN pet_concurrent_capacity INT NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_locales_pet_concurrent_capacity
    CHECK (pet_concurrent_capacity BETWEEN 1 AND 10);
