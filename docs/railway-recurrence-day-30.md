# Railway manual checklist — RECURRENCE_DAY_30

**Registro operativo actualizado 2026-11-19.** El usuario confirmó que ejecutó manualmente
la migración en Railway. Este documento registra el resultado reportado y conserva los
pasos reproducibles de consulta/operación. No se accedió independientemente a Railway desde
esta sesión. La aplicación del SQL no activa el scheduler ni autoriza contactos/envíos.

## 0. Estado reportado del esquema y del runtime

**Actualizacion local 2026-11-20:** existe una migracion posterior
`20261120_001_pet_recurrencia_operativa.sql`, aplicada y probada solo en Docker. Agrega
`habilitada`, revision e historial; reemplaza el trigger terminal por reactivacion operativa
condicionada e incorpora responsables PET actuales sin fila previa. No inventa consentimiento.
**NO aplicada en Railway.** Esta guia conserva abajo la evidencia historica del esquema
20261119. El nuevo backend de preferencias requiere la migracion posterior antes de usarse.
Una futura aplicacion requiere revisar SQL exacto, estado real/backup/permisos de triggers,
detener writers y mantener D30 apagado; el DDL no es transaccional. No usar el runner local
contra Railway, no repetir el DDL original, no borrar historial para rollback ni activar
variables/envios como parte de una migracion. Aprobacion productiva siempre separada.

Resultado comunicado por el operador:

- MySQL Community Server **9.7.4**, base **`railway`**.
- `20261119_001_pet_recurrencia_contactos.sql` ejecutada manualmente el **19/11/2026**.
- Tabla creada con PK, FK y tres CHECK; trigger
  `trg_pet_recurrencia_contacto_bu` verificado con `SHOW CREATE TRIGGER`.
- `pet_recurrencia_contactos` contiene **0 registros**.
- DBeaver falló inicialmente al separar el bloque del trigger con `DELIMITER`; se resolvió
  ejecutando el bloque como script completo. No se reportaron cambios al SQL versionado.
- No se activó RECURRENCE_DAY_30, no se importaron autorizaciones y no se cambiaron variables
  Railway. **El backend del commit `0f442daf3957f09bfd92b8fca80233ba16c5b038` aún no fue
  publicado.** Por lo tanto, la creación de esta tabla no significa que el mensual esté
  disponible en runtime ni que se haya activado.

Detalles del respaldo, verificación y límite de evidencia en §3. Confirmar directamente
los datos del esquema con las consultas de §5 si se requiere certificación independiente.

## Estado de runtime antes de activar el esquema en código

El commit backend `0f442daf3957f09bfd92b8fca80233ba16c5b038` arranca con la flag de
recurrencia ausente: se comprobó localmente que no consulta MySQL ni registra el scheduler
RECURRENCE. En Railway, verificar por el dashboard de Variables:

- `PET_RECURRENCE_ENABLED`: no se modificó durante la migración; el backend mensual no fue publicado.
- `PET_RECURRENCE_PILOT_LOCAL_IDS`: no se modificó durante la migración.
- Leer sus valores actuales en Railway de forma privada antes del deploy; este informe no
  afirma cuáles están configurados.
- **No cambiar** `PET_REMINDERS_ENABLED`; controla el aviso PET del día anterior.

No pegar valores de variables en tickets, comandos, consultas o logs. Si la flag está en
`true`, detener el procedimiento y coordinar primero la desactivación/reinicio del servicio.
El mensual no envía con allowlist vacía; mantener la flag apagada hasta que publicación,
cohorte y una activación posterior tengan autorización explícita. El scheduler no escribe
ni envía solo por existir la tabla.

## 1. Identificar destino y verificar solo lectura

Para repetir o auditar, conectar mediante Railway dashboard o su comando de conexión
**oficial**, confirmando el proyecto, servicio MySQL y base `railway`. No usar
`agenda_mysql`, `agenda_db` local ni Vercel como destino productivo. No guardar credenciales
en el repo ni en el historial del shell.

Ejecutar estas consultas; no hacen escrituras:

```sql
SELECT DATABASE() AS database_name, VERSION() AS mysql_version,
       @@hostname AS server_hostname, @@session.time_zone AS session_timezone,
       @@system_time_zone AS system_timezone;

SELECT TABLE_NAME, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('locales','turnos','mascotas','clientes','pet_recordatorios',
                     'mascota_clientes','pet_recurrencia_contactos')
ORDER BY TABLE_NAME;

SHOW CREATE TABLE locales;
SHOW CREATE TABLE turnos;
SHOW CREATE TABLE mascotas;
SHOW CREATE TABLE clientes;
SHOW CREATE TABLE mascota_clientes;
SHOW CREATE TABLE pet_recordatorios;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND ((TABLE_NAME = 'locales' AND COLUMN_NAME = 'id')
    OR (TABLE_NAME = 'turnos' AND COLUMN_NAME IN ('id','local_id','mascota_id','estado','fecha','hora'))
    OR (TABLE_NAME = 'pet_recordatorios' AND COLUMN_NAME IN
      ('local_id','tipo','turno_id','mascota_id','ultimo_turno_completado_id','cliente_id',
       'cliente_local_id','estado','claimed_at','accepted_at','provider_message_id')))
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('turnos','pet_recordatorios')
  AND INDEX_NAME IN ('uq_turnos_id_local_recordatorios','uq_pet_recordatorios_recurrencia',
                     'uq_pet_recordatorios_turno')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

SELECT CONSTRAINT_NAME, TABLE_NAME, CONSTRAINT_TYPE, ENFORCED
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('locales','pet_recordatorios')
ORDER BY TABLE_NAME, CONSTRAINT_TYPE, CONSTRAINT_NAME;

SELECT CONSTRAINT_NAME, CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND CONSTRAINT_NAME IN ('chk_pet_recordatorios_identidad','chk_pet_recordatorios_estado',
                          'chk_pet_recordatorios_claim');

SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE()
  AND TRIGGER_NAME IN ('trg_pet_recordatorios_destinatario_bi',
                       'trg_pet_recordatorios_destinatario_bu')
ORDER BY TRIGGER_NAME;

SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'pet_recurrencia_contactos';
```

**No imprimir filas de clientes, teléfonos ni contenido de recordatorios.** El último SELECT
solo prueba existencia de tabla; si está, no volver a ejecutar el `CREATE TABLE`.

## 2. Identificar migraciones requeridas

El repo no registra una tabla/journal de migraciones fiable. Identificar el estado por
estructura, `SHOW CREATE TABLE`, índices, CHECKs, FKs y triggers; no asumir que un número
de migración equivale a esquema aplicado.

El backend necesita previamente:

1. `20261030_001_pet_recordatorios.sql`: UNIQUE `(turnos.id,turnos.local_id)`, tabla
   `pet_recordatorios`, UNIQUE de identidad APPOINTMENT/RECURRENCE y FKs tenant-aware.
2. `20261030_002_pet_recordatorios_recipient_fk.sql`: `cliente_local_id`, FK destinatario
   y ambos triggers de coherencia.
3. `20261030_003_pet_recordatorios_processing_states.sql`: CHECK con `dispatching` y
   `skipped` además de los estados previos.
4. `20261119_001_pet_recurrencia_contactos.sql`: tabla de autorizaciones/bajas y trigger
   terminal de baja descrito abajo.

No editar ni volver a ejecutar una migración que ya esté aplicada. Las migraciones 001–003
pueden no estar en Railway aunque sí estén en Docker. En particular 001 agrega un UNIQUE
a `turnos` (tabla central), 002 incluye un backfill y ALTER de FKs/triggers, y 003 modifica
CHECKs: si cualquiera falta, detenerse y revisar cada migración, volumen de tabla, índices,
duplicados, constraints y ventana de mantenimiento. Requieren plan/backup y aprobación
productiva propia antes de ejecutarlas. **No saltar directamente a 20261119_001.**

Si el preflight revela una instalación parcial, como tabla sin triggers o constraint con
nombre existente pero definición distinta, detenerse: no aplicar el archivo entero a ciegas.
Preparar reconciliación idempotente específica y obtener aprobación separada.

## 3. Respaldo y límites de verificación reportados

El operador confirmó un respaldo previo mediante **DBeaver/mysqldump**, incluyendo una
segunda copia con `--set-gtid-purged=OFF`. Se verificaron estructura, datos, triggers y que
el dump finalizara correctamente. **No se probó restauración.** No registrar rutas privadas,
credenciales ni contenido del dump en este documento.

La descripción disponible confirma backup previo y resultado del DDL, pero no aporta
consulta/exportación legible de cada CHECK/FK ni el texto de `SHOW CREATE TRIGGER`; el usuario
confirma PK/FK/tres CHECK y verificación del trigger. La guía no presenta esos detalles como
revisados independientemente. Para una auditoría posterior, usar las consultas de §5.

## 4. Backup y autorización antes de DDL (procedimiento histórico/repetición)

1. Crear un **backup/snapshot completo** de la base desde Railway, esperar resultado
   `successful` y anotar timestamp/identificador. Verificar que la política de retención
   permite restaurarlo. Si no hay backup restaurable, no seguir.
2. Conservar el artefacto fuera del repositorio y bajo el control de acceso productivo.
   Opcionalmente realizar un dump consistente adicional por el canal oficial, con
   credenciales introducidas de forma interactiva; no incluir password en argv, URL,
   historial ni logs. Un dump adicional no reemplaza el snapshot restaurable.
3. Revisar el archivo exacto `migrations/20261119_001_pet_recurrencia_contactos.sql`
   del commit `0f442daf3957f09bfd92b8fca80233ba16c5b038`; SHA-256 esperado:
   `d688f8884e82e4a59c57f77bd7475413be67dec752ad8eb2d79ee644b17ac0d6`.
4. Confirmar que tabla y trigger están ambos ausentes y que 001–003 son compatibles.
   Obtener aprobación explícita para **esta migración Railway** antes de ejecutarla.

## 5. Aplicar solo la migración nueva (NO repetir tras éxito)

Usar un cliente MySQL compatible con el servidor Railway, sobre la conexión oficial y con TLS obligatorio,
password interactivo y el archivo del commit validado. El cliente `mysql` debe soportar
`DELIMITER`; la migración crea la tabla y luego un trigger. Ejemplo esquemático (sustituir
host/usuario/base por los datos oficiales; nunca poner la contraseña en el comando):

```bash
mysql --host=HOST_RAILWAY --user=USUARIO --password --ssl-mode=REQUIRED DATABASE < migrations/20261119_001_pet_recurrencia_contactos.sql
```

No ejecutar desde un shell con `.env` como fuente; el destino debe ser explícito y revisado.
El DDL MySQL no es transaccional: si falla cualquier sentencia, **parar y diagnosticar**
con `information_schema`; no reejecutar el archivo completo ni borrar objetos. La tabla
puede haberse creado antes de fallar el trigger. Mantener la flag apagada y no importar
contactos durante esta etapa.

## 6. Verificación posterior, solo lectura

```sql
SELECT TABLE_NAME, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_recurrencia_contactos';

SHOW CREATE TABLE pet_recurrencia_contactos;

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_recurrencia_contactos'
ORDER BY ORDINAL_POSITION;

SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_recurrencia_contactos'
ORDER BY INDEX_NAME, SEQ_IN_INDEX;

SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE, ENFORCED
FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'pet_recurrencia_contactos'
ORDER BY CONSTRAINT_TYPE, CONSTRAINT_NAME;

SELECT CONSTRAINT_NAME, CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND CONSTRAINT_NAME IN ('chk_pet_recurrencia_contacto_telefono',
                          'chk_pet_recurrencia_contacto_evidencia',
                          'chk_pet_recurrencia_contacto_estado');

SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE()
  AND TRIGGER_NAME = 'trg_pet_recurrencia_contacto_bu';

SELECT COUNT(*) AS contactos_importados FROM pet_recurrencia_contactos;
```

Esperado: tabla InnoDB; PK `(local_id,telefono_normalizado)`; FK solo a `locales`
con `ON DELETE CASCADE`; tres CHECKs `ENFORCED=YES`; un trigger `BEFORE UPDATE`;
conteo cero, porque esta guía no autoriza cargas reales. Confirmar que las CHECKs de
`pet_recordatorios` siguen permitiendo `dispatching` y `skipped`.

## 7. Confirmar que el mensual sigue apagado

En Railway Variables, verificar **después de cualquier deploy/restart**:

- `PET_RECURRENCE_ENABLED` ausente o distinto del string exacto `true`.
- `PET_RECURRENCE_PILOT_LOCAL_IDS` ausente/vacío.
- No cambiar `PET_REMINDERS_ENABLED`; es el recordatorio PET del día anterior.

El scheduler mensual no se registra con flag apagada o allowlist vacía. El arranque local
posterior a `0f442` se verificó sin conexión DB cuando la flag estaba unset. El backend
`0f442` aún no está publicado según el estado reportado. No inferir disponibilidad runtime
por el cambio de esquema; publicación del código y activación futura son decisiones separadas.

No importar contactos reales, no probar desde Railway con una allowlist activa y no enviar
WhatsApp como parte de la migración. La cohorte, evidencia/bajas, despliegue y activación
requieren pasos y aprobaciones separados.
