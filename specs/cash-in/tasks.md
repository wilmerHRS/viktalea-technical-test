# Tasks: Wallet Cash-In

> Spec 3 de 3. Implementa `design.md` para cumplir `requirements.md`.

## Instrucciones para el agente que implementa

1. Lee `AGENTS.md`, `requirements.md` y `design.md` **antes** de escribir código.
2. Haz **una tarea a la vez**, en orden. Cada una termina cuando cumple sus criterios de aceptación y pasan `npm run typecheck` y `npm test`.
3. Haz **un commit por tarea** con el formato `feat(cash-in): T<n> <resumen>`.
4. **No cambies el spec en silencio.** Si algo del spec es incorrecto, ambiguo o imposible, detente y anótalo en la sección *Dudas del implementador* al final de este archivo en lugar de improvisar.
5. **Prohibido**:
   - guardar estado de idempotencia en memoria;
   - reintentar cobros automáticamente;
   - leer el saldo, sumar en JS y escribirlo;
   - con Drizzle: `findFirst` seguido de `insert`/`update` para idempotencia, transiciones o saldo, y llamar a la pasarela dentro de `db.transaction` (design §6.5);
   - leer `process.env` fuera de `env.ts`.
6. Marca cada tarea con `[x]` al terminarla.

## Tareas

- [x] **T1. Infraestructura de base de datos (Drizzle ORM)**: R8, NFR2, NFR3, NFR5
  - **Ya hecho (no rehacer):**
    - `docker-compose.yml` con `postgres:17-alpine`, usuario `cashin` y contraseña `cashin_local` definidos directamente en el archivo.
    - `docker/postgres/init/01-create-test-db.sh`, que crea `cashin_test`.
    - Scripts `db:up`, `db:down`, `db:reset`, `db:logs` y `db:psql`.
    - Variables `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` y `DB_NAME` en `.env` y `.env.example`.
  - **Pendiente:**
    - Dependencias: `drizzle-orm` y `pg` (+ dev: `drizzle-kit`, `@types/pg`).
    - `env.ts`: añadir las variables de design §9, entre ellas `DB_*`, con el mismo estilo simple del esquema actual.
    - `shared/infrastructure/db/client.ts` (`createDb` con `Pool({ host, port, user, password, database })` + `drizzle(pool, { schema })` y tipos `Db` / `Tx`), `shared/infrastructure/db/schema.ts` y `migrate.ts` (migrator de `drizzle-orm`).
    - `modules/cash-in/infrastructure/persistence/schema.ts` con las 4 tablas de design §3: checks, `unique` e índice parcial incluidos.
    - `drizzle.config.ts` y la primera migración generada en `drizzle/`. Revisar que el SQL generado coincida con design §3.
    - Crear `.env.test`, igual que `.env` pero con `DB_NAME=cashin_test` (versionado; ajustar `.gitignore` con `!.env.test`).
    - Scripts: `db:generate` (`drizzle-kit generate`), `db:migrate` (carga `.env`) y `db:migrate:test` (carga `.env.test`). El script `test` carga `.env.test`.
  - **Acepta cuando**: `npm run db:up && npm run db:migrate` crea las 4 tablas con sus restricciones (`\d operations` muestra el `UNIQUE` de `idempotency_key` y los `CHECK`), y un test de humo hace `select 1` con Drizzle contra `cashin_test`.

- [x] **T2. Limpieza y observabilidad**: R1.1, R9
  - Eliminar el módulo `users` y sus tests.
  - `app.ts`: montar los módulos en la raíz (sin `/api/v1`).
  - Logger `pino` en `shared/infrastructure/logging/logger.ts` con el nivel `LOG_LEVEL`.
  - Middleware `requestId`: usa `X-Request-Id` si viene o genera un UUID, lo devuelve en la respuesta y lo pone a disposición del logger de la request.
  - **Acepta cuando**: `GET /health` responde con el header `X-Request-Id` (eco si se envía uno), y los logs salen en JSON con `requestId`.

- [x] **T3. Dominio**: R3, R6.4, R1.3
  - `OperationStatus.ts` (`canTransition`, `toApiStatus`), `Operation.ts`, `Money.ts` (`toCents`, `fromCents` y rechazo de más de 2 decimales).
  - Puertos `OperationRepository.ts` y `PaymentProvider.ts` exactamente como en design §5.
  - **Acepta cuando**: hay tests unitarios de todas las transiciones válidas e inválidas (R3.2, R3.3) y de `Money` (100.00 ↔ 10000, 0.1 + 0.2, 1.005 rechazado).

- [x] **T4. Repositorio con Drizzle**: R2.1, R2.5, R3.4, R6.1–R6.3, NFR3
  - `DrizzleOperationRepository`: `claim`, `findById`, `markUnknown`, `settle(…, tx?)`, `leasePendingBatch`, `recordWebhookEvent(…, tx?)` según design §6, escritos con las construcciones de design §6.5. Mapea las filas de Drizzle a la entidad `Operation`: el dominio no importa nada de Drizzle.
  - **Acepta cuando** hay tests de integración que demuestran:
    - (a) dos `claim` concurrentes con la misma key crean una sola fila;
    - (b) dos `settle(COMPLETED)` concurrentes acreditan una sola vez;
    - (c) `settle` sobre una operación final devuelve `applied: false`;
    - (d) 20 `settle` concurrentes de operaciones distintas del mismo usuario dejan el saldo igual a la suma exacta (R6.3);
    - (e) dos `leasePendingBatch` concurrentes nunca devuelven la misma operación, y una operación con la reserva vencida vuelve a poder reservarse (R7.3).

- [x] **T4.1. Correcciones de la revisión de T1–T4** (hacer antes de T5): R8, R5.3, R5.4, design §2, §2.1, §5, §6.3
  > Origen: revisión humana y del agente A sobre T1–T4 (ver `docs/ai-log.md`, Fase 2). Cada punto se corrige **sin cambiar el comportamiento** que ya cubren los tests de T1–T4; los tests existentes deben seguir pasando, adaptando solo los imports y los nombres.
  1. **🔴 Pool sin manejador de errores (R8).** En `createDb`, registrar `pool.on('error', …)` que registre el error con el logger y **no** tumbe el proceso. Test: terminar una conexión inactiva del pool con `pg_terminate_backend` desde otra sesión; el proceso sigue vivo y la siguiente consulta funciona. Antes de este arreglo, esto mataba el proceso con `Unhandled 'error' event` (código `57P01`).
  2. **Estructura de `domain/` (design §2).** Mover a `entities/Operation.ts`, `value-objects/{OperationStatus,Money,Currency,WebhookEventResult}.ts`, `repositories/OperationRepository.ts` y `gateways/PaymentProvider.ts`. Actualizar los imports.
  3. **Constantes y "enums" (design §2.1).** Eliminar los literales repetidos:
     - Estados: `'PROCESSING'`/`'UNKNOWN'`/… en el repositorio y el esquema se reemplazan por `OperationStatus.*` y por `SETTLEABLE_STATUSES` derivado de la tabla de transiciones.
     - Moneda: `'PEN'` en `Operation.create` y en el default del esquema se reemplaza por `Currency.PEN`.
     - Resultados de webhook y de la pasarela: `WebhookEventResult`, `ChargeOutcome` y `ProviderChargeStatus` como objetos `as const`.
     - Números: `CENTS_PER_UNIT` en `Money`, `DB_CONNECTION_TIMEOUT_MS` en `client.ts` y códigos HTTP vía `HttpStatus`.
     - `CHECK` e índice parcial del esquema construidos desde las constantes. `npm run db:generate` **no debe producir una migración nueva**: el SQL resultante es idéntico al actual.
     - Patrón `as const` + tipo derivado. **No** usar `enum` de TypeScript ni un `constants.ts` global.
  4. **Errores de dominio sin HTTP (design §2.1.5).** Quitar `statusCode` de `AppError` y sus subclases. Crear `shared/infrastructure/http/httpStatus.ts` y `errorStatusMap.ts` (código → HttpStatus), y usarlos en `errorHandler` y `notFound`. Las respuestas HTTP actuales no cambian.
  5. **Entidad sin detalles de infraestructura.** Quitar `reconcileLockedUntil` de `Operation`: el lease lo gestiona solo el adaptador. El test (e) verifica la reserva consultando la tabla.
  6. **Puerto del webhook atómico (design §5, §6.3).** Reemplazar `recordWebhookEvent` por `applyWebhookEvent(event)`, que en una sola transacción del adaptador hace: insertar el evento deduplicando, liquidar con `settle` y guardar el resultado de `classifyWebhookResult()`. Quitar `tx` de la firma del puerto (el adaptador puede seguir usándolo internamente). Tests:
     - unitarios de `classifyWebhookResult`: `applied`, `ignored` (coincide con el final) y `conflict` (lo contradice);
     - integración: evento duplicado entre dos pools, un solo efecto y `duplicate: true` en el segundo;
     - integración: si falla a mitad de la transacción, no queda ni el evento ni el efecto;
     - integración: `declined` sobre una operación `COMPLETED` queda como `conflict` sin cambiar el estado.
  7. **Menores:**
     - El comentario de cabecera de `.env.test` dice "NO se sube a git", pero sí se versiona: corregirlo.
     - `X-Request-Id` entrante: aceptarlo solo si cumple `^[A-Za-z0-9._-]{1,128}$`; si no, generar un UUID nuevo. Añadir un test.
  - **Acepta cuando**: `npm run typecheck` y `npm test` pasan; el grep `grep -rnE "'(PROCESSING|UNKNOWN|COMPLETED|FAILED|PEN|applied|ignored|conflict)'" src` solo encuentra las **definiciones** de las constantes; `domain/` no importa nada de `infrastructure/`, de Drizzle ni de Express; y `npm run db:generate` informa que no hay cambios.

- [ ] **T4.2. Legibilidad, formato y contratos con nombre** (hacer antes de T5): design §2.2
  > Origen: revisión humana de T4.1. Hay 101 líneas de más de 100 caracteres (hasta 146) en 19 archivos, condiciones SQL anidadas en una sola expresión, tipos anónimos en las firmas de los puertos y lógica de negocio en el repositorio. Causa raíz: el proyecto no tiene formatter ni linter. **No cambia el comportamiento**: los 106 tests existentes deben seguir pasando.
  1. **Herramientas.**
     - Instalar y configurar Prettier y ESLint (`typescript-eslint`, flat config `eslint.config.js`) según design §2.2.1.
     - Añadir los scripts `format`, `format:check` y `lint`, y un `.prettierignore` (`drizzle/`, `dist/`, `node_modules/`, `package-lock.json`).
     - Ejecutar `npm run format` sobre `src/` y `tests/`, en un **commit aparte, solo de formato**, para que el diff de lógica quede limpio.
  2. **Puertos** (design §2.2.3 y §2.2.4):
     - Mover `SettleOutcome` y `PaymentWebhookEvent` a `domain/value-objects/` (por ejemplo `SettleOutcome.ts` y `PaymentWebhookEvent.ts`).
     - Declarar con nombre los resultados del puerto: `ClaimResult`, `SettleResult` y `ApplyWebhookEventResult` en `OperationRepository.ts`; `ChargeRequest` y `ChargeStatusResult` en `PaymentProvider.ts`.
     - Eliminar `export type { NewOperation } from …`: se importa desde `entities/Operation.ts`.
  3. **`DrizzleOperationRepository`** (design §2.2.2 y §2.2.5):
     - Condiciones SQL del lease como constantes con nombre: `isUnknown`, `isStaleProcessing`, `isLeaseFree`. Helpers `millisecondsAgo(ms)` y `millisecondsFromNow(ms)` para las expresiones de intervalo.
     - Extraer la consulta repetida "operación + saldo" a un método privado `selectOperationWithBalance(executor)`.
     - `settle` público que abre la transacción y `settleInTransaction(tx, …)` privado con la lógica; `applyWebhookEvent` usa el privado. Se elimina la llamada recursiva.
     - Renombrar `restore` del adaptador a `toOperation(row, newBalanceCents)`.
     - Sacar la lógica de negocio: la conversión evento → `SettleOutcome` pasa a una función de dominio `toSettleOutcome(event)` en `value-objects/`, con test unitario. La validación "`provider_charge_id` obligatorio si `approved`" sale del repositorio y queda anotada para T8 (capa HTTP o de aplicación). El repositorio deja de lanzar `ValidationError`.
     - Tipo de retorno de `applyWebhookEvent` con su nombre (`ApplyWebhookEventResult`), no con `ReturnType<…>`.
  4. **Resto del proyecto**: aplicar §2.2.2 (valores con nombre) donde el formatter no basta. Por ejemplo, los mensajes de error largos de `Money.ts` y `errorHandler.ts` pasan a constantes con nombre, y los tests extraen sus fixtures y valores esperados a variables descriptivas en lugar de literales en línea.
  - **Acepta cuando**: `npm run typecheck`, `npm run lint`, `npm run format:check` y `npm test` pasan; `awk 'length > 100'` sobre `src/` y `tests/` no devuelve líneas, salvo URLs o strings que no se pueden partir (justificar cada una en el reporte); `domain/repositories/` y `domain/gateways/` no contienen tipos de objeto anónimos en las firmas ni reexportaciones; `DrizzleOperationRepository` no importa `ValidationError`.

- [ ] **T5. Pasarela falsa**: R4
  - `FakePaymentProvider` según design §8: idempotente por key, `nextOutcome`, `chargeCount`, `setDelay` y el mapeo de `payment_method` para runtime.
  - Errores `ProviderTimeoutError` y `ProviderUnavailableError`. El timeout lo aplica `CreateCashIn` con `PROVIDER_TIMEOUT_MS` (`AbortSignal.timeout` o `Promise.race`).
  - **Acepta cuando**: hay tests unitarios del fake, incluido que `timeout_after_charge` deja `getChargeStatus = approved`.

- [ ] **T6. `POST /cash-in`**: R1, R2, R4
  - `requestHash.ts`, `CashInResponse.ts` (tabla de design §7), `CreateCashIn.ts` (flujo de design §6.1), `CashInController` y la ruta.
  - Módulo `createCashInModule({ db, provider, ... })` registrado en `main.ts`.
  - **Acepta cuando** hay tests HTTP de:
    - éxito: 200 y saldo acreditado;
    - rechazo: 402 y saldo sin cambios;
    - timeout: 202 `pending` y operación `UNKNOWN`;
    - replay de una operación completada: mismo body, `chargeCount = 1`;
    - misma key con otro payload: 422;
    - header ausente o inválido: 400;
    - body inválido: 400.

- [ ] **T7. Concurrencia con varios pods**: R2.1, R2.5
  - Test con 3 instancias de `createApp()`, cada una con su propio `createDb()` (pool independiente) sobre `cashin_test`, y 10 requests en paralelo con la misma key.
  - **Acepta cuando**: hay 1 fila en `operations`, 1 en `ledger_entries`, `chargeCount = 1`, y todas las respuestas son 200 con el mismo `operation_id` y `new_balance`, o 202 `pending` con el mismo `operation_id`.

- [ ] **T8. `POST /webhooks/payment`**: R5
  - `verifySignature.ts` (HMAC-SHA256 del body crudo con `timingSafeEqual`), `HandlePaymentWebhook.ts` (design §6.3, usando `repo.applyWebhookEvent` de T4.1, sin abrir transacciones en la capa de aplicación), `WebhookController` y la ruta.
  - **Acepta cuando** hay tests de:
    - firma inválida: 401;
    - webhook `approved` sobre una operación `UNKNOWN`: `COMPLETED` y saldo acreditado;
    - mismo `event_id` dos veces: un solo efecto y `duplicate: true`;
    - `declined` después de `COMPLETED`: el estado no cambia, queda `result = WebhookEventResult.CONFLICT` y se emite un log `warn`;
    - webhook antes que la respuesta: con `setDelay` en el fake, el webhook liquida durante el cobro; el `/cash-in` responde 200 y hay 1 sola entrada en el ledger;
    - `operation_id` inexistente: 404.

- [ ] **T9. Reconciliador y resiliencia**: R7, R8
  - `ReconcileOperations.ts` con las tres fases de design §6.4 (reservar, consultar fuera de cualquier transacción, liquidar) y `startReconciler.ts` (al arrancar, con intervalo y parada en el shutdown de `main.ts`). Añadir `RECONCILE_LEASE_MS` a `env.ts` y a `.env.example`.
  - `errorHandler`: los errores de conexión de `pg` se traducen a 503.
  - **Acepta cuando** hay tests de:
    - `timeout_after_charge` seguido de `execute()`: `COMPLETED`;
    - una operación `PROCESSING` antigua y `not_found`: `FAILED` (simula un reinicio antes de cobrar);
    - dos `execute()` en paralelo no liquidan dos veces y no consultan la misma operación a la pasarela;
    - durante `getChargeStatus()` no hay ninguna transacción abierta (por ejemplo, un webhook liquida la misma operación mientras la consulta está en curso, sin quedarse bloqueado);
    - una app con un pool apuntando a un puerto cerrado: `POST /cash-in` responde 503.

- [ ] **T10. Documentación**: entregables del README [DOC]
  - `README.md` con estas secciones:
    - cómo ejecutar el proyecto;
    - arquitectura propuesta (con diagrama);
    - estrategia de idempotencia;
    - manejo de concurrencia;
    - estrategia de retry;
    - manejo de webhooks;
    - respuesta a la pregunta central;
    - Redis vs base de datos;
    - qué cambiaría con 1 millón de operaciones al día;
    - una sección **"Pilotaje del agente IA"** que enlace a `docs/ai-log.md`.
  - Actualizar `AGENTS.md` si la estructura cambió.
  - **Acepta cuando**: un tercero puede clonar el repo, ejecutar `npm run db:up && npm run db:migrate && npm test`, y entender cada decisión.

## Dudas del implementador

> El agente que implementa anota aquí lo que encuentre incorrecto o ambiguo en el spec, con la tarea afectada y qué decidió (o si se detuvo).

- **T3 / T4 / T4.1 — Transacción del webhook y frontera del puerto. RESUELTA por la revisión humana.** En T3/T4 se dejó `tx` solo en el adaptador, aunque la descripción anterior de design §6.3 lo requería para orquestar el webhook desde aplicación. La afirmación anterior de "sin desviaciones" fue incorrecta: esta discrepancia debía registrarse aquí. El spec actualizado §5/§6.3 la resuelve con `applyWebhookEvent`: la transacción y su `tx` son internos al adaptador; el puerto solo expone tipos de dominio.

- **T4.1 — Datos auxiliares del webhook.** `PaymentWebhookEvent` no incluye un motivo de rechazo y declara `providerChargeId` opcional. Se usa `DEFAULT_DECLINE_REASON` (`Payment declined`) para el rechazo; para un evento aprobado se exige un identificador no vacío, coherente con `SettleOutcome` y el contrato de R5.1. Si falta, se lanza `ValidationError` y se revierte también el evento. Los duplicados por `eventId` se devuelven antes de esa validación y no se reprocesan. No se inventa un identificador de cobro.

- **T4 / T9 — Reconciliación y llamadas externas dentro de transacciones. ✅ RESUELTA (decisión humana: opción 2, reserva con vencimiento).** El spec se corrigió:
  - R7.3 aclarado;
  - design §3: columna `reconcile_locked_until`;
  - design §5: `withPendingBatch` se reemplaza por `leasePendingBatch`;
  - design §6.4: tres fases (reservar, consultar sin transacción, liquidar);
  - design §6.5 y §9: `RECONCILE_LEASE_MS`;
  - T4 (criterio e) y T9.

  La prohibición de llamar a la pasarela dentro de una transacción se mantiene sin excepciones.

  _Duda original:_ design §6.4 exige mantener `FOR UPDATE SKIP LOCKED` y ejecutar `provider.getChargeStatus()` dentro de la misma transacción; design §6.5 y las instrucciones del usuario prohíben llamar a la pasarela dentro de una transacción. `withPendingBatch` de §5 también vincula el callback a esa transacción. Esto afecta a la exclusión entre pods (R7.3). Se detuvo la implementación para consultar si la prohibición admite una excepción solo para consultar el estado (nunca para cobrar), o si se autoriza diseñar un mecanismo de reserva persistente que permita consultar fuera de la transacción. No se ha elegido ni implementado ninguna alternativa.
