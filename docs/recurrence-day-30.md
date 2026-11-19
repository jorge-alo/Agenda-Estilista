# PET — RECURRENCE_DAY_30 (piloto, apagado por defecto)

Guía autocontenida del backend. Código de etapas 1–4 y E2E validado en Docker. La migración
de contactos se aplicó manualmente también en Railway, pero el backend de `0f442` no está
publicado según confirmación del operador; no hay cargas reales ni activación mensual.

## Contrato funcional

- D0 es la **fecha agendada** del último turno `completado` por mascota/local,
  ordenado por fecha, hora e ID. No es la fecha del clic en Completar.
- Solo D0 + 30 días calendario = **hoy** en `America/Argentina/Buenos_Aires`.
  Ventana `[10:00,12:00)` ART; nunca backfill D31/D40/D60.
- Destinatario: responsable del último completado, aún vinculado, con canonical
  válido y autorización verificada. No hay fallback a otro responsable.
- Local y mascota deben permitir la reserva pública. Una próxima reserva activa
  o pendiente_pago, futura o en curso, excluye aunque sea para después de D35.
- D35 inclusive es el plazo comercial para efectuar una reserva, cuya atención
  puede ser posterior. Sin cálculo de beneficios, descuentos ni cambios de precios.
- Mensaje de cuidado del manto con «nuestra agenda online» y ruta pública `/:slug`:
  base FRONTEND_URL validada + slug codificado, sin tokens ni enlaces de acceso.
  Sin precios/D35 ni promesa de disponibilidad semanal en el texto.
- APPOINTMENT_REMINDER y BEAUTY mantienen sus reglas, schedulers y presupuestos.

## Activación técnica (no autorizada por esta entrega)

| Variable | Condición |
|---|---|
| `PET_RECURRENCE_ENABLED` | Solo string exacto `true`; ausente u otro valor = apagado. |
| `PET_RECURRENCE_PILOT_LOCAL_IDS` | CSV explícito de IDs INT positivos; vacío = cero actividad. Máximo 100 entradas. Un valor inválido invalida toda la lista. |
| `FRONTEND_URL` | Base existente HTTPS sin credenciales, query ni fragment. No hay dominio alternativo por defecto. |

El registro ocurre desde `server.ts` después de listen, únicamente con configuración
válida. Cron `*/5 10-11 * * *` ART, sin corrida inmediata y con segundo guard de reloj
MySQL UTC. Single-flight por proceso; UNIQUE/CAS coordinan workers y réplicas.
Flag/lista/URL se revalidan durante el ciclo y antes del POST. Cambiar variables de
despliegue requiere reiniciar el proceso; no es un kill switch distribuido instantáneo.

Presupuesto independiente: 20 reclamos ganados por corrida, páginas keyset de 50,
round-robin/rotación entre locales y recuperación de hasta 100 claims por local piloto.
Un local diferido no impide avanzar a otros. No se selecciona ni recupera fuera de la lista.
El transporte delega a las funciones PET existentes `getPetWhatsAppConnectionState`
y `sendPetWhatsAppWithReceipt`, instancia `String(local_id)`.

## Persistencia y seguridad del despacho

Reutiliza `pet_recordatorios` y su UNIQUE
`(local_id,tipo,mascota_id,ultimo_turno_completado_id)`. Requiere previamente el esquema
de recordatorios versionado en `20261030_001`–`003`.
La nueva migración es `migrations/20261119_001_pet_recurrencia_contactos.sql`:

- Aplicada y validada en Docker (`agenda_mysql / agenda_db`, MySQL 8.4.11) y aplicada
  manualmente en Railway (MySQL Community Server 9.7.4, base `railway`), según confirmación
  del usuario. PK/FK/tres CHECK y trigger verificados; 0 filas en Railway.
- Respaldo Railway previo mediante DBeaver/mysqldump, con segunda copia
  `--set-gtid-purged=OFF`; estructura, datos, triggers y fin del dump verificados.
  No se probó restauración. DBeaver requirió ejecutar el bloque `DELIMITER` como script.
  Evidencia operativa y límites en `docs/railway-recurrence-day-30.md`.
- SQL aplicado sin modificaciones. Su encabezado es histórico; no editar ni reejecutar
  una migración aplicada. Verificar el estado real por metadatos antes de cualquier despliegue.
- Tabla por `(local_id,telefono_normalizado)`, CHECKs y FK CASCADE al local.
- Snapshot histórico del ID de responsable, sin FK al cliente: una baja sobrevive a su
  eliminación/recreación y una autorización no se transfiere al nuevo titular/número.
- Trigger impide cambiar identidad o reactivar una baja. No hay reactivación en el piloto.

El archivo utiliza `DELIMITER` para definir el trigger: requiere cliente MySQL compatible
o un runner que separe correctamente las sentencias. No se ejecuta automáticamente al arrancar.

Transacciones cortas READ COMMITTED, sin cambiar el aislamiento de sesión del pool:
local X → turno X → mascota X → contexto S → recordatorio X. Revalidan elegibilidad,
vínculos, teléfono, permiso, baja, próxima reserva y reloj antes de autorizar.
`sending → dispatching` atómico es el único derecho al POST, invocado tras commit,
sin locks durante HTTP. Antes del POST se comprueban otra vez propiedad y reloj.

Recovery después de **más de 180 segundos**: `sending` puede revalidar para pending/skipped;
`dispatching` solo puede terminar unknown. Timeout, respuesta ambigua, commit perdido o
fallo al persistir aceptación no habilitan reenvío. Sent significa aceptación, no entrega.
Una baja/reserva posterior a la autorización puede coincidir con el despacho autorizado.
Ante duda se evita repetir, aceptando posibles omisiones. La base es la fuente de verdad;
los logs de transición no sustituyen la confirmación de commit/estado persistido.

## Autorizaciones y bajas: operación local

No se infiere autorización de una relación comercial o de haber enviado mensajes antes.
La cohorte requiere evidencia verificable para esta finalidad; guardar referencias,
no conversaciones. La aplicación valida estructura, identidad y fecha, no el contenido
de la evidencia. Ausencia de permiso o baja = no enviar.

`pet-recurrencia:contactos:local` admite un JSON de 1–100 operaciones, sin repetir teléfono:

- Autorización: `tipo: "autorizacion"`, `clienteId`, `telefonoCanonical`, `verificadaAt`
  (ISO UTC con milisegundos, no futura), `referenciaVerificacion` (1–255 caracteres).
- Baja: `tipo: "baja"`, `telefonoCanonical`, `referenciaBaja` (1–255 caracteres).

El local se da únicamente en el comando. No versionar lotes con datos personales.

```bash
npm run pet-recurrencia:contactos:local -- --local-id ID --archivo "RUTA_AL_LOTE.json"
npm run simulate:pet-recurrencia:local -- --local-id ID --frontend-url URL_HTTPS
```

Por defecto la operación es READ ONLY. `--aplicar` al final permite escribir el lote
completo en una transacción, solo con autorización operativa. Una baja nunca se pisa;
reintentos son idempotentes; teléfono cambiado o titular distinto no heredan permiso.
Estos CLI **solo aceptan el Docker local protegido**; no son herramientas productivas.
No ofrecen `--force`, override de reloj, auto-consentimiento ni acceso a Railway.

## Verificaciones

```bash
npx tsc --noEmit
npm run test:pet-recurrencia
npm run test:pet-recurrencia:integration
npm run test:pet-recurrencia:processing
npm run test:pet-recurrencia:scheduler
npm run test:pet-recurrencia:e2e
```

Las integraciones escriben únicamente fixtures en el Docker protegido y verifican su
limpieza; requieren autorización local. No apuntarlas a producción. El E2E incluye el
preloader test-only que bloquea red/cron reales y la carga de archivos mediante dotenv,
sin bypass horario productivo.
Para ejecutar la suite completa protegida desde Bash:

```bash
npm_config_update_notifier=false NODE_OPTIONS="--require ts-node/register/transpile-only --require ./src/features/pet/recordatorios/recurrencia.e2e.setup.ts" npm test
```

Evidencia local del 2026-11-19: tipos PASS; E2E 10/10 sin omisiones; suite completa
1374 + pretest 11 + posttest 55 PASS; suites 51/11/34/24 y regresión de avisos 36 PASS.
Reloj de prueba coherente hasta poscommit, mensaje exacto, slug público local 200,
rechazo con reloj real 14:01 ART. Hashes de 25 tablas/417 filas previas preservados;
cero residuos. AUTO_INCREMENT avanza por fixtures, sin reiniciarlo. Sin HTTP externo.

## Pendientes antes de producción

Confirmar migraciones previas requeridas por el backend antes de publicarlo. La migración
de contactos Railway está aplicada, pero no acredita la publicación del backend. Obtener
aprobación separada para el despliegue. Definir/verificar cohorte, IDs piloto, evidencia y responsable de bajas;
aprobar la operación productiva (los CLI actuales son solo locales). Validar URL/instancia
Evolution y entrega bajo autorización. Después evaluar activación explícita de flag/lista.
No hay panel ni procesamiento automático de respuestas de baja.
Para detener trabajo nuevo se deshabilita la función y se reinician los procesos afectados;
no borrar tablas, dedupe ni bajas, ni reabrir unknown para reintentar automáticamente.
