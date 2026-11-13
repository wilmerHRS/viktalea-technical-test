# Design: Wallet Cash-In

> Spec 2 de 3. Implementa `requirements.md`. Respeta la arquitectura y las convenciones de `AGENTS.md`.
> Principio rector: **la base de datos es la que garantiza la exactitud**. El código nunca decide "esto ya se procesó" a partir de algo guardado en memoria.

## 1. Vista general

```
Cliente ──POST /cash-in──▶ API (N pods) ──charge(op_id)──▶ Pasarela (fake)
                              │                                │
                              │◀──────POST /webhooks/payment───┘
                              ▼
                        PostgreSQL  (operations · wallets · ledger_entries · webhook_events)
                              ▲
              Reconciler (en cada pod, reserva con lease) ──getChargeStatus(op_id)──▶ Pasarela
```

Las tres vías que pueden finalizar una operación (respuesta de la pasarela, webhook y reconciliador) llaman a **la misma función `settle()`**. Por eso es imposible acreditar dos veces.

## 2. Estructura de código

```
src/
├── main.ts                         # crea db, provider y módulos; arranca server + reconciler
├── app.ts                          # createApp(modules): sin prefijo /api/v1 (R1.1)
├── config/env.ts                   # + DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, WEBHOOK_SECRET, PROVIDER_TIMEOUT_MS, RECONCILE_*, LOG_LEVEL
├── shared/
│   └── infrastructure/
│       ├── db/
│       │   ├── client.ts           # createDb(config) → { db: drizzle(pool, { schema }), pool }  + tipos Db / Tx
│       │   ├── schema.ts           # re-exporta los esquemas Drizzle de todos los módulos (lo usan drizzle-kit y client)
│       │   └── migrate.ts          # aplica las migraciones de /drizzle con el migrator de drizzle-orm (npm run db:migrate)
│       ├── logging/logger.ts       # pino
│       └── http/
│           ├── httpStatus.ts       # HttpStatus (constantes de códigos HTTP)
│           ├── errorStatusMap.ts   # código de error de dominio → HttpStatus (los errores de dominio no conocen HTTP)
│           └── middlewares/
│               ├── requestId.ts    # X-Request-Id (R9.1)
│               ├── errorHandler.ts # usa errorStatusMap + mapea errores de conexión a BD a 503 (R8.1)
│               └── notFound.ts
└── modules/cash-in/
    ├── index.ts                    # createCashInModule({ db, provider, webhookSecret, ... }): HttpModule
    ├── domain/                     # SOLO conceptos de negocio: sin HTTP, sin SQL, sin Drizzle, sin detalles de infraestructura
    │   ├── entities/
    │   │   └── Operation.ts        # entidad (sin campos de infraestructura como el lease del reconciliador)
    │   ├── value-objects/
    │   │   ├── OperationStatus.ts  # "enum" + tabla de transiciones + SETTLEABLE_STATUSES / FINAL_STATUSES + toApiStatus()
    │   │   ├── Money.ts            # CENTS_PER_UNIT, toCents(), fromCents()
    │   │   ├── Currency.ts         # "enum" Currency (PEN) + SUPPORTED_CURRENCIES
    │   │   ├── WebhookEventResult.ts # "enum" + classifyWebhookResult() (regla de R5.4, función pura)
    │   │   ├── SettleOutcome.ts    # resultado con el que se liquida (COMPLETED + chargeId | FAILED + motivo)
    │   │   └── PaymentWebhookEvent.ts # evento validado + toSettleOutcome()
    │   ├── repositories/           # puertos de persistencia: una sentencia atómica por método, SIN lógica
    │   │   ├── OperationRepository.ts   # insertIfKeyIsNew, findById, findByIdempotencyKey, changeStatus, leasePendingBatch
    │   │   ├── WalletRepository.ts      # ensureExists, credit (balance = balance + x)
    │   │   ├── LedgerRepository.ts      # append
    │   │   └── WebhookEventRepository.ts # insertIfNew, saveResult
    │   └── gateways/
    │       └── PaymentProvider.ts  # puerto hacia el sistema externo + "enums" ChargeOutcome / ProviderChargeStatus
    ├── application/                # AQUÍ está la lógica: cada caso de uso se lee paso a paso
    │   ├── ports/UnitOfWork.ts     # ejecuta varios repositorios en UNA transacción (§5.1)
    │   ├── services/settleOperation.ts # liquidar: cambiar estado → acreditar → ledger (única vía, §6.2)
    │   ├── use-cases/
    │   │   ├── ClaimOperation.ts        # registrar la operación de una idempotency key (R2) ✅
    │   │   ├── SettleOperation.ts       # liquidar en su propia transacción ✅
    │   │   ├── MarkOperationUnknown.ts  # PROCESSING → UNKNOWN tras un timeout (R4.4) ✅
    │   │   ├── HandlePaymentWebhook.ts  # deduplicar + liquidar + clasificar (R5) ✅ (falta la capa HTTP, T8)
    │   │   ├── CreateCashIn.ts          # flujo completo de POST /cash-in (T6): usa Claim/Settle/MarkUnknown
    │   │   └── ReconcileOperations.ts   # flujo de R7 (T9)
    │   ├── requestHash.ts          # sha256 del payload canónico
    │   └── CashInResponse.ts       # Operation → { httpStatus, body } (R1.5–R1.7, R3.5)
    └── infrastructure/
        ├── persistence/
        │   ├── schema.ts           # tablas Drizzle del módulo (pgTable): wallets, operations, ledger_entries, webhook_events
        │   ├── Drizzle{Operation,Wallet,Ledger,WebhookEvent}Repository.ts # consultas, construidas sobre un DbExecutor
        │   └── DrizzleUnitOfWork.ts # db.transaction + repositorios sobre ese tx
        ├── provider/FakePaymentProvider.ts
        ├── http/CashInController.ts, WebhookController.ts, cashInRoutes.ts, verifySignature.ts
        └── jobs/startReconciler.ts # setInterval + ejecución al arrancar
drizzle/                            # migraciones SQL generadas por drizzle-kit (versionadas, se revisan en el PR)
drizzle.config.ts                   # drizzle-kit: dialect postgresql, schema y out ./drizzle (solo para `generate`)
```

Decisiones:
- **Drizzle ORM** [decisión humana]: se integra para demostrar su uso (esquema tipado, migraciones, cliente, transacciones y query builder), y se recurre a SQL crudo con `` sql`…` `` donde sea mejor opción. Las garantías de concurrencia se escriben de forma explícita (§6). El esquema Drizzle vive en la **infraestructura** del módulo: el dominio no conoce el ORM, y el repositorio mapea filas a entidades.
- **Migraciones**: `drizzle-kit generate` crea el SQL a partir de `schema.ts`, y el SQL generado se revisa y se versiona. Para aplicarlas, `src/shared/infrastructure/db/migrate.ts` usa `migrate()` de `drizzle-orm/node-postgres/migrator`. Así se aplican con la misma configuración validada de `env.ts`, sin que `drizzle-kit` necesite conectarse.
- **El módulo `users` se elimina**: era solo un ejemplo.
- **Estructura de `domain/`** [decisión humana, revisión de T1–T4]: se separa por tipo de concepto (`entities/`, `value-objects/`, `repositories/`, `gateways/`), igual que la convención de `AGENTS.md`. La primera versión de este spec lo dejaba plano y mezclaba entidades, reglas y puertos.
- **Las wallets viven dentro del módulo `cash-in`**. Acreditar exige una transacción que abarca operación, ledger y wallet. Partirlo en dos módulos obligaría a una transacción entre módulos o a una saga, algo injustificado para este alcance. Si el dominio de wallet crece, se extrae a su propio módulo con un puerto `WalletLedger` que acepte una transacción.

### 2.1 Constantes, "enums" y valores en duro [decisión humana, revisión de T1–T4]

1. **Ningún literal de negocio repetido.** Estados, monedas, resultados de webhook, resultados de la pasarela, prefijos de IDs, tamaños de lote, códigos HTTP y tiempos se definen **una vez** como constante con nombre y se importan. Esto incluye el esquema de Drizzle: los `CHECK` y el índice parcial se construyen a partir de las constantes (por ejemplo, `sqlInList(Object.values(OperationStatus))`), no con strings copiados.
2. **Patrón de "enum": objeto `as const` más un tipo derivado.** No se usa `enum` de TypeScript:
   ```ts
   export const OperationStatus = { PROCESSING: 'PROCESSING', UNKNOWN: 'UNKNOWN', COMPLETED: 'COMPLETED', FAILED: 'FAILED' } as const;
   export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus];
   ```
   Motivos: es JavaScript puro (compatible con el *type stripping* nativo de Node y con `erasableSyntaxOnly`, que no admiten `enum`), no tiene las rarezas de `enum` (mapeo inverso en los numéricos, tipado nominal), sus valores son strings legibles en la BD y en los logs, y permite derivar listas (`Object.values`) para los `CHECK` y las validaciones.
3. **Sin un archivo global de constantes.** Cada constante vive junto al concepto al que pertenece: las de dominio en `domain/value-objects`, las de un puerto en su puerto, las de HTTP en `shared/infrastructure/http/httpStatus.ts` y las de configuración en `env.ts`. Un `constants.ts` global acopla módulos que no tienen relación y termina siendo un cajón de sastre.
4. **Las reglas derivadas salen de su fuente.** La lista de estados liquidables (`SETTLEABLE_STATUSES = ['PROCESSING','UNKNOWN']`) se deriva de la tabla de transiciones de `OperationStatus`, y el repositorio la usa en su `WHERE status IN (…)`. Así la máquina de estados del dominio y el SQL no pueden divergir.
5. **Los errores de dominio no conocen HTTP.** `AppError` y sus subclases llevan un `code` (`VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, …) pero **no** un `statusCode`. La traducción a HTTP la hace `shared/infrastructure/http/errorStatusMap.ts` en el `errorHandler`.

### 2.2 Legibilidad y formato [decisión humana, revisión de T4.1]

1. **El formato lo impone una herramienta, no la buena voluntad.**
   - Prettier (`printWidth: 100`, `singleQuote: true`, `trailingComma: 'all'`) para el formato.
   - ESLint con `typescript-eslint` (reglas `recommended`), más `max-statements-per-line: 1`, `curly: all`, `no-nested-ternary` y `max-depth: 3`.
   - Scripts `npm run format`, `npm run format:check` y `npm run lint`. Una tarea no está terminada si `lint` o `format:check` fallan.
2. **Una idea por línea; valores con nombre.**
   - Si una expresión mezcla varias decisiones (por ejemplo `or(eq(…), and(eq(…), lt(…)))` o una condición de varias partes), cada parte va a una constante con nombre que diga **qué significa**: `isUnknown`, `isStaleProcessing`, `isLeaseFree`.
   - No se pasan literales sin nombre como argumentos posicionales cuando su significado no es obvio en el sitio de la llamada.
3. **Tipos con nombre en las firmas públicas.** Los puertos y los métodos públicos no declaran tipos de objeto anónimos en línea (`Promise<{ created: boolean; operation: Operation }>`). Se declaran con nombre: `ClaimResult`, `SettleResult`, `ChargeRequest`, `ChargeStatusResult`, etc.
4. **Qué contiene cada archivo de puerto** (`repositories/*.ts`, `gateways/*.ts`):
   - La `interface` y los tipos de **su propio contrato** (parámetros y resultados).
   - Los conceptos de dominio que el puerto usa pero no le pertenecen (`SettleOutcome`, `PaymentWebhookEvent`) viven en `value-objects/` y se importan desde ahí.
   - Sin reexportaciones (`export type { X } from …`): cada tipo se importa desde el archivo que lo define.
5. **Los adaptadores solo traducen.**
   - Un repositorio no decide reglas de negocio ni valida la entrada. Por ejemplo: "un evento `approved` liquida como `COMPLETED`" es una función de dominio (`toSettleOutcome(event)` en `value-objects/`), y "`provider_charge_id` es obligatorio si `approved`" se valida en la capa HTTP o de aplicación (T8).
   - Dentro del adaptador, las consultas repetidas se extraen a métodos privados con nombre (por ejemplo `selectOperationWithBalance`), y las expresiones SQL repetidas a helpers (`millisecondsAgo(ms)`).
   - Los métodos que abren una transacción no se llaman a sí mismos para reutilizarla: método público que abre la transacción y método privado `…InTransaction(tx, …)` con la lógica.

## 3. Modelo de datos

Se define en `modules/cash-in/infrastructure/persistence/schema.ts` con `pgTable`, usando `check()`, `unique()` e índices parciales con `.where(sql\`…\`)`. Usa `bigint('…', { mode: 'number' })` para los céntimos y `timestamp('…', { withTimezone: true })`. La migración generada por `drizzle-kit` **debe producir este esquema**; si difiere, se corrige el `schema.ts`, no el SQL a mano:

```sql
CREATE TABLE wallets (
  user_id        TEXT PRIMARY KEY,
  currency       CHAR(3)     NOT NULL DEFAULT 'PEN',
  balance_cents  BIGINT      NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE operations (
  id                  TEXT PRIMARY KEY,                    -- 'op_' + uuid v4 sin guiones
  idempotency_key     UUID        NOT NULL UNIQUE,         -- R2.1 / R2.5: el árbitro entre pods
  request_hash        TEXT        NOT NULL,                -- R2.4
  user_id             TEXT        NOT NULL REFERENCES wallets(user_id),
  amount_cents        BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency            CHAR(3)     NOT NULL,
  payment_method      TEXT        NOT NULL,
  status              TEXT        NOT NULL CHECK (status IN ('PROCESSING','UNKNOWN','COMPLETED','FAILED')),
  provider_charge_id  TEXT,
  failure_reason      TEXT,
  reconcile_locked_until TIMESTAMPTZ,                      -- R7.3: reserva (lease) del reconciliador, §6.4
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operations_pending_idx ON operations (status, updated_at)
  WHERE status IN ('PROCESSING','UNKNOWN');                 -- para el reconciliador

CREATE TABLE ledger_entries (
  id                   BIGSERIAL PRIMARY KEY,
  operation_id         TEXT        NOT NULL UNIQUE REFERENCES operations(id),  -- R6.2
  user_id              TEXT        NOT NULL REFERENCES wallets(user_id),
  amount_cents         BIGINT      NOT NULL,
  balance_after_cents  BIGINT      NOT NULL,               -- para responder siempre el mismo new_balance (R2.2)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  event_id      TEXT PRIMARY KEY,                          -- R5.3: deduplicación
  operation_id  TEXT        NOT NULL,
  status        TEXT        NOT NULL,
  result        TEXT        NOT NULL CHECK (result IN ('applied','ignored','conflict')),
  payload       JSONB       NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- El dinero se guarda en `BIGINT` de céntimos (R6.4). La API convierte con `Money`.
- La respuesta idempotente **no se almacena**: se reconstruye a partir de `operations` más `ledger_entries.balance_after_cents`. Esto es determinista y evita que la respuesta guardada y el estado real diverjan.

## 4. Máquina de estados (R3)

```
              approved            ┌──────────────┐
   ┌──────────────────────────────▶│  COMPLETED   │ (final)
   │                               └──────────────┘
┌──┴─────────┐ timeout/red ┌─────────┐ approved / reconcile
│ PROCESSING ├────────────▶│ UNKNOWN ├────────────▶ COMPLETED
└──┬─────────┘             └────┬────┘
   │ declined                   │ declined / not_found
   └──────────────▶ FAILED ◀────┘ (final)
```

`OperationStatus.ts` exporta `canTransition(from, to)`, la tabla de transiciones y las listas derivadas `SETTLEABLE_STATUSES` (estados desde los que se puede llegar a uno final) y `FINAL_STATUSES`. En la base de datos, cada transición es un `UPDATE … WHERE id = $1 AND status = ANY($allowedFrom)`, donde `$allowedFrom` **sale de esas listas** (§2.1.4). Si devuelve 0 filas, otra vía ganó y se trata como no-op (R3.4).

## 5. Puertos

```ts
// domain/gateways/PaymentProvider.ts
export const ChargeOutcome = { APPROVED: 'approved', DECLINED: 'declined' } as const;
export const ProviderChargeStatus = { APPROVED: 'approved', DECLINED: 'declined', PENDING: 'pending', NOT_FOUND: 'not_found' } as const;
// + tipos derivados ChargeOutcome / ProviderChargeStatus (§2.1.2)
export type ChargeResult =
  | { outcome: typeof ChargeOutcome.APPROVED; providerChargeId: string }
  | { outcome: typeof ChargeOutcome.DECLINED; reason: string };

export interface PaymentProvider {
  /** idempotencyKey = operation.id (R4.1). Lanza ProviderTimeoutError / ProviderUnavailableError. */
  charge(req: { idempotencyKey: string; amountCents: number; currency: Currency; paymentMethod: string }): Promise<ChargeResult>;
  getChargeStatus(idempotencyKey: string): Promise<{ status: ProviderChargeStatus; providerChargeId?: string; reason?: string }>;
}

// domain/repositories/*  — persistencia SIN lógica: cada método es una sentencia atómica
interface OperationRepository {
  insertIfKeyIsNew(op: NewOperation): Promise<Operation | null>; // INSERT … ON CONFLICT DO NOTHING; null = key tomada
  findById(id: string): Promise<Operation | null>;                // + saldo del ledger (LEFT JOIN)
  findByIdempotencyKey(key: string): Promise<Operation | null>;
  changeStatus(id: string, change: StatusChange): Promise<Operation | null>; // UPDATE … WHERE status IN (change.from)
  leasePendingBatch(criteria: LeaseCriteria): Promise<Operation[]>;          // reserva del reconciliador (§6.4)
}
interface WalletRepository { ensureExists(userId): Promise<void>; credit(userId, amountCents): Promise<number> }
interface LedgerRepository { append(entry: NewLedgerEntry): Promise<void> }
interface WebhookEventRepository {
  insertIfNew(event: PaymentWebhookEvent): Promise<boolean>; // false = eventId repetido
  saveResult(eventId: string, result: WebhookEventResult): Promise<void>;
}
```

- **Los repositorios no deciden nada.** Qué estados son válidos (`change.from`), qué pasa después de acreditar o cómo se clasifica un webhook lo decide la capa de aplicación (§5.1 y §6). Las garantías de concurrencia (`ON CONFLICT`, `WHERE status IN`, `balance + x`, `SKIP LOCKED`) siguen en SQL porque deben ser atómicas, pero los **parámetros** (qué estados, qué monto) los pasa el caso de uso.
- `Operation` incluye `newBalanceCents: number | null`, que se obtiene con un `LEFT JOIN ledger_entries`. **No** incluye `reconcileLockedUntil`, porque es un detalle de persistencia del reconciliador.
- `SettleOutcome` y `PaymentWebhookEvent` (con `toSettleOutcome`) viven en `value-objects/`.

### 5.1 Unit of Work: transacciones sin lógica en el repositorio [decisión humana, revisión de T4.2]

```ts
// application/ports/UnitOfWork.ts
interface CashInRepositories { operations; wallets; ledger; webhookEvents }
interface UnitOfWork { run<T>(work: (repositories: CashInRepositories) => Promise<T>): Promise<T> }
```

- Un caso de uso que necesita varios pasos atómicos los escribe **en orden y legibles** dentro de `unitOfWork.run(...)`. Todo lo que hace con esos repositorios se confirma junto o se revierte junto.
- `DrizzleUnitOfWork` implementa `run` con `db.transaction(tx => work(createCashInRepositories(tx)))`. Los repositorios se construyen sobre un `DbExecutor` (el cliente o el `tx`), así que el puerto nunca expone `tx` ni tipos de Drizzle.
- **Nunca** se llama a la pasarela dentro de `run` (§6.5).
- Motivo: la versión anterior (`claim`, `settle` y `applyWebhookEvent` en el repositorio) metía la orquestación de negocio en el adaptador, porque era el único que tenía la transacción. La revisión humana lo detectó: "los repositorios solo se comunican con la BD; la lógica va en los casos de uso".

## 6. Flujos

> Los flujos se muestran en SQL para que se vea qué garantiza cada paso. En código se escriben con Drizzle **conservando exactamente esa semántica** (§6.5).

### 6.1 `POST /cash-in` (CreateCashIn)

```
1. Validar header (UUID) y body (R1.2, R1.3) → requestHash = sha256(JSON canónico de user_id, amount_cents, currency, payment_method)
2. claimOperation.execute(newOp)   (ya implementado)  ── en UNA transacción:
                    wallets.ensureExists(userId)                     -- INSERT … ON CONFLICT DO NOTHING (R1.4)
                    operations.insertIfKeyIsNew(newOp)               -- INSERT … ON CONFLICT (idempotency_key) DO NOTHING
                    si null → operations.findByIdempotencyKey(key)   -- la otra request ya la registró
3. Si created = false:
     hash distinto → 422 IDEMPOTENCY_KEY_REUSED (R2.4)
     si no         → return CashInResponse(operation)  (sin llamar a la pasarela: R2.2, R2.3)
4. Llamar provider.charge({ idempotencyKey: op.id, ... }) con timeout PROVIDER_TIMEOUT_MS  (FUERA de cualquier transacción)
     approved   → settleOperation.execute(op.id, COMPLETED)
     declined   → settleOperation.execute(op.id, FAILED)
     timeout/red→ markOperationUnknown.execute(op.id)   -- NO reintentar (R4.4)
5. op = findById(op.id) → return CashInResponse(op)
```

Puntos clave:
- **El INSERT se confirma antes de llamar a la pasarela.** Así, si el pod se cae durante el paso 4, la operación queda persistida en `PROCESSING` y el reconciliador la retoma (R8.2). Además, un webhook que llegue antes siempre encuentra la operación (R5.5).
- En el paso 5 se **relee** la operación en lugar de usar el resultado local, porque un webhook pudo haberla liquidado antes (R5.5). `settle` y `markUnknown` son condicionales, así que la vía que pierde no pisa a la que ganó.

### 6.2 `settleOperation()`, la única forma de finalizar (R3.4, R6.1, R6.2)

Vive en `application/services/settleOperation.ts` y se ejecuta dentro de un `UnitOfWork`. La usan `SettleOperation`, `HandlePaymentWebhook` y (en T9) el reconciliador. Pasos: `operations.changeStatus(id, { from: SETTLEABLE_STATUSES, to })` → si `null`, devolver la existente con `applied: false` → si `FAILED`, terminar → `wallets.credit` → `ledger.append`. El SQL equivalente:

```sql
BEGIN;
UPDATE operations
   SET status = $target, provider_charge_id = $chargeId, failure_reason = $reason, updated_at = now()
 WHERE id = $id AND status IN ('PROCESSING','UNKNOWN')
RETURNING user_id, amount_cents;
-- 0 filas → ROLLBACK; return { applied: false }      (otra vía ya lo liquidó)
-- si target = 'COMPLETED':
UPDATE wallets SET balance_cents = balance_cents + $amount, updated_at = now()
 WHERE user_id = $user RETURNING balance_cents;       -- incremento atómico (R6.3)
INSERT INTO ledger_entries(operation_id, user_id, amount_cents, balance_after_cents)
VALUES ($id, $user, $amount, $balance);               -- UNIQUE(operation_id): segunda red de seguridad
COMMIT;
```

El `UPDATE … WHERE status IN (…)` toma un lock de fila sobre la operación. Si dos vías liquidan a la vez, la segunda espera a que la primera confirme, vuelve a evaluar el `WHERE`, encuentra el estado final y actualiza 0 filas.

### 6.3 `POST /webhooks/payment` (HandlePaymentWebhook)

```
1. verifySignature(rawBody, X-Signature, WEBHOOK_SECRET) con crypto.timingSafeEqual → si falla, 401 (R5.2)
   (express.json({ verify }) guarda req.rawBody)
2. Validar body → si falla, 400
3. op = repo.findById(operation_id) → si no existe, 404 (R5.6)
4. r = handlePaymentWebhook.execute(event)   (caso de uso ya implementado) ── en UNA unidad de trabajo:
     webhookEvents.insertIfNew(event)           -- INSERT … ON CONFLICT (event_id) DO NOTHING, result = NULL
       false → return { duplicate: true }                                                (R5.3)
     s = settleOperation(repositories, op.id, toSettleOutcome(event))
     result = classifyWebhookResult({ applied: s.applied, eventStatus, finalStatus: s.operation.status })
              → APPLIED | IGNORED (coincide con el final) | CONFLICT (lo contradice)      (R5.4)
     webhookEvents.saveResult(eventId, result)  -- nunca se confirma una fila con result NULL
   COMMIT
5. duplicate → 200 { received: true, duplicate: true }
   CONFLICT  → log warn con operationId, eventId y los dos estados; 200 { received: true }
   otro      → 200 { received: true }
```

- `classifyWebhookResult()` es una **función pura de dominio** (`value-objects/WebhookEventResult.ts`) que se testea sin BD.
- La orquestación está en el caso de uso y la atomicidad la da el `UnitOfWork` (§5.1). Si falla cualquier paso, no queda ni el evento ni el efecto, y la pasarela reintenta el webhook (R5.7).
- `webhook_events.result` es nullable (migración `0001`): se inserta sin resultado para deduplicar y se completa antes del commit. Así se evita guardar un valor de relleno engañoso.

### 6.4 Reconciliador (R7)

Se hace en tres fases. **Ninguna llamada a la pasarela ocurre con una transacción abierta** (§6.5).

```
cada RECONCILE_INTERVAL_MS (y una vez al arrancar):

1. RESERVAR: repo.leasePendingBatch(RECONCILE_AFTER_MS, RECONCILE_LEASE_MS, 10)
   transacción corta, se confirma de inmediato:
     UPDATE operations SET reconcile_locked_until = now() + $lease
      WHERE id IN (
        SELECT id FROM operations
         WHERE (status = 'UNKNOWN' OR (status = 'PROCESSING' AND updated_at < now() - $olderThan))
           AND (reconcile_locked_until IS NULL OR reconcile_locked_until < now())
         ORDER BY updated_at
         LIMIT $batch
         FOR UPDATE SKIP LOCKED)                          -- cada pod reserva filas distintas
     RETURNING *;

2. CONSULTAR (sin transacción): para cada op, s = provider.getChargeStatus(op.id)

3. LIQUIDAR (una transacción corta por operación, la de settle):
     approved → settle(COMPLETED) · declined / not_found → settle(FAILED) · pending / error → nada
```

Reglas:
- **Qué garantiza cada pieza.** La exactitud (no acreditar dos veces) la da `settle()`, que es condicional. La reserva solo evita trabajo duplicado entre pods (R7.3). Si una reserva vence durante una consulta lenta y otro pod consulta la misma operación, el único coste es una consulta repetida.
- **Caída de un pod.** La reserva vence (`reconcile_locked_until < now()`) y otro pod retoma la operación en el siguiente ciclo. No hace falta liberarla de forma explícita: `settle` deja la operación en un estado final y ya no vuelve a seleccionarse.
- **La reserva no toca `updated_at`**, porque `updated_at` mide la antigüedad de una operación en `PROCESSING`.
- **Tamaño de la reserva:** `RECONCILE_LEASE_MS ≥ batch × PROVIDER_TIMEOUT_MS`. Con un lote de 10 y 5 s por consulta da 50 s, y el valor por defecto es 60 s. Las consultas del lote se hacen secuencialmente.
- El job debe ser cancelable en el shutdown (`clearInterval`).
- En los tests se invoca `ReconcileOperations.execute()` directamente, sin timers.

### 6.5 Cómo se escribe con Drizzle

Se usa el query builder por defecto. Si una consulta queda más clara o más correcta en SQL crudo, se escribe con `` sql`…` `` o `tx.execute(sql`…`)`, dentro del mismo cliente y la misma transacción de Drizzle. Por ejemplo: el lote del reconciliador con la condición `OR` y el intervalo, o un `UPDATE … RETURNING` complejo. Lo obligatorio es **la semántica** de la columna izquierda, no la sintaxis de la derecha.

| Garantía | Con el query builder (referencia) |
|---|---|
| Reclamar la key (R2.1) | `tx.insert(operations).values(v).onConflictDoNothing({ target: operations.idempotencyKey }).returning()` |
| Crear la wallet si no existe (R1.4) | `tx.insert(wallets).values({ userId }).onConflictDoNothing()` |
| Transición condicionada (R3.4) | `tx.update(operations).set({ status, … }).where(and(eq(operations.id, id), inArray(operations.status, ['PROCESSING','UNKNOWN']))).returning()` |
| Incremento atómico del saldo (R6.3) | `` tx.update(wallets).set({ balanceCents: sql`${wallets.balanceCents} + ${amount}` }).where(eq(wallets.userId, userId)).returning() `` |
| Deduplicar el webhook (R5.3) | `tx.insert(webhookEvents).values(e).onConflictDoNothing({ target: webhookEvents.eventId }).returning()` |
| Reserva del lote del reconciliador (R7.3) | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *` de §6.4. Es un buen candidato para SQL crudo (`` db.execute(sql`…`) ``); con el builder, la subconsulta usa `.for('update', { skipLocked: true })`. |
| Transacción (R6.1) | Desde la aplicación: `unitOfWork.run(async (repositories) => { … })` (§5.1). Dentro, `DrizzleUnitOfWork` usa `db.transaction` y construye los repositorios sobre el `tx`. Ningún repositorio abre transacciones por su cuenta. |
| Lista de estados en SQL | Siempre desde las constantes: `inArray(operations.status, [...SETTLEABLE_STATUSES])`, `eq(operations.status, OperationStatus.PROCESSING)`; nunca `'PROCESSING'` escrito a mano (§2.1). |

**Prohibido** en idempotencia, transiciones y saldo, se use el builder o SQL crudo:
- `db.query.x.findFirst()` seguido de `insert`/`update` (condición de carrera entre pods);
- leer `balanceCents`, sumar en JS y hacer `set({ balanceCents: nuevo })` (lost update);
- llamar a la pasarela dentro de `db.transaction` (mantiene locks durante una llamada externa).

## 7. Respuestas HTTP (`CashInResponse`)

| Estado | HTTP | Body |
|---|---|---|
| `COMPLETED` | 200 | `{ operation_id, status: "completed", amount, new_balance }` |
| `FAILED` | 402 | `{ operation_id, status: "failed", amount, failure_reason }` |
| `PROCESSING` / `UNKNOWN` | 202 + `Retry-After: 2` | `{ operation_id, status: "pending", amount }` |
| key con otro payload | 422 | `{ error: { code: "IDEMPOTENCY_KEY_REUSED", … } }` |
| validación | 400 | `{ error: { code: "VALIDATION_ERROR" \| "INVALID_IDEMPOTENCY_KEY", … } }` |
| BD caída | 503 | `{ error: { code: "SERVICE_UNAVAILABLE", … } }` |

Los errores siguen el formato existente (`AppError` + `errorHandler`). El `errorHandler` traduce los errores de conexión de `pg` (`ECONNREFUSED`, `57P01`, `08xxx`, timeout del pool) a 503.

## 8. Pasarela falsa (`FakePaymentProvider`)

Es un adaptador en memoria que simula al sistema **externo**. La idempotencia del servicio no depende de él.
- `charge` es idempotente por `idempotencyKey`, como lo sería una pasarela real.
- Su comportamiento se configura por instancia, para tests:
  ```ts
  provider.nextOutcome('approved' | 'declined' | 'timeout' | 'timeout_after_charge' | 'unavailable');
  provider.chargeCount(key)   // para afirmar "se cobró una sola vez"
  provider.setDelay(ms)       // para simular el escenario "webhook antes que la respuesta"
  ```
  `timeout_after_charge` registra el cobro como aprobado y aun así lanza `ProviderTimeoutError`. Es la pregunta central del challenge.
- En runtime (`npm run dev`), el resultado depende de `payment_method`: `card_declined` es rechazado, `card_timeout` es `timeout_after_charge` y cualquier otro valor es aprobado.

## 9. Configuración (`env.ts`, se mantiene el esquema simple)

| Variable | Regla | Default |
|---|---|---|
| `DB_HOST` | string | `localhost` |
| `DB_PORT` | entero 1–65535 | `5432` |
| `DB_USER` | string obligatorio | none |
| `DB_PASSWORD` | string obligatorio | none |
| `DB_NAME` | string obligatorio | none |
| `WEBHOOK_SECRET` | string obligatorio, mínimo 16 caracteres | none |
| `PROVIDER_TIMEOUT_MS` | entero > 0 | 5000 |
| `RECONCILE_INTERVAL_MS` | entero > 0 | 30000 |
| `RECONCILE_AFTER_MS` | entero > 0 | 30000 |
| `RECONCILE_LEASE_MS` | entero > 0 (≥ 10 × `PROVIDER_TIMEOUT_MS`, §6.4) | 60000 |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug` o `trace` | `info` |

`docker-compose.yml` levanta `postgres:17-alpine` con las credenciales escritas en el archivo, y crea las bases `cashin` y `cashin_test`. `.env.test` (versionado, solo con valores locales) repite la configuración de `.env` con `DB_NAME=cashin_test`. `client.ts` construye el `Pool` de `pg` con `{ host, port, user, password, database }` a partir de esas variables.

## 10. Cómo se cubre cada escenario del challenge

| Escenario | Mecanismo |
|---|---|
| Doble click / retry de la app | `UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING`. El segundo request lee la operación existente. |
| Varios pods concurrentes | La restricción vive en PostgreSQL, compartido por todos los pods. No hay estado en memoria. |
| Timeout de la pasarela | `UNKNOWN`, sin reintento. Se resuelve por webhook o reconciliación. La pasarela recibe `op.id` como su clave de idempotencia. |
| Webhook duplicado | `webhook_events.event_id` como PK, en la misma transacción que `settle`. |
| Webhook fuera de orden | Transiciones condicionadas y estados finales inmutables. Las contradicciones se registran como `conflict`. |
| Webhook antes que la respuesta | La operación se persiste antes de cobrar. La request relee el estado al final. |
| Fallo temporal de la BD | 503. El reintento con la misma key es seguro. No hay reintentos internos de operaciones no idempotentes. |
| Reinicio durante la operación | La operación queda en `PROCESSING` en la BD y el reconciliador la retoma después de `RECONCILE_AFTER_MS`. |
| Race condition sobre el saldo | `balance = balance + x` atómico dentro de la transacción de `settle`, más `UNIQUE(operation_id)` en el ledger. |

## 11. Por qué PostgreSQL y no Redis para la idempotencia

- La clave de idempotencia, el estado de la operación y el saldo tienen que ser **consistentes entre sí**. Con todo en la misma base de datos se consigue con una transacción ACID. Con Redis más PostgreSQL habría dos fuentes de verdad, y hace falta resolver qué pasa si una escribe y la otra no.
- Redis tendría sentido como **capa delante** de la BD con un volumen muy alto (por ejemplo, un `SET NX` para rechazar duplicados baratos antes de llegar a PostgreSQL), pero nunca como única garantía, por los riesgos de expiración, failover y pérdida de datos. Este tema se discute en el README (pregunta de la defensa técnica).

## 12. Estrategia de tests

- **Unitarios**: `canTransition`, `Money`, `requestHash`, `CashInResponse`.
- **Integración HTTP contra PostgreSQL real** (`cashin_test`), con supertest y `FakePaymentProvider`. Se hace `TRUNCATE` entre tests.
- **Varios pods**: se crean 3 instancias de `createApp()` con pools distintos sobre la misma BD y se disparan 10 requests en paralelo con la misma key. Se verifica que haya 1 operación, 1 cobro, 1 movimiento en el ledger y respuestas coherentes.
- **BD caída**: un pool apuntando a un puerto cerrado debe responder 503.
- Los tests obligatorios de `requirements.md` §5 deben poder ejecutarse con `npm test`, con la BD levantada (`npm run db:up && npm run db:migrate:test`).
