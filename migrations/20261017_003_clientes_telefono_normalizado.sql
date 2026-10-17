-- PET-11B.4C: identidad E.164 nullable durante la transición (no convertir snapshots).
-- Aplicar únicamente tras preflight sin colisiones por (local_id, E.164).
ALTER TABLE clientes
  ADD COLUMN telefono_normalizado VARCHAR(16) NULL AFTER telefono,
  ADD UNIQUE KEY uq_clientes_telefono_normalizado_local (telefono_normalizado, local_id);
