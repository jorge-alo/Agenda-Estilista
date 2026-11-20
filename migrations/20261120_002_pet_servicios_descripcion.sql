-- Descripcion informativa opcional del catalogo PET. Validada primero en Docker local.
-- Columna aditiva en la tabla compartida; las filas existentes conservan NULL.
ALTER TABLE servicios
  ADD COLUMN descripcion VARCHAR(1000) NULL DEFAULT NULL;
