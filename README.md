# Wallet Cash-In · Idempotencia, concurrencia y webhooks

Servicio de **recarga de saldo (cash-in)**: cobra un monto en una pasarela de pagos externa y lo acredita en la wallet del usuario **exactamente una vez**, aunque haya doble click, reintentos de la app, varios pods, timeouts de la pasarela, webhooks duplicados o fuera de orden, fallos de la base de datos o reinicios a mitad de la operación.

> Challenge técnico *Senior Backend Developer* (Ligo Tech, B2C). Se construyó **guiado por specs y pilotando agentes de IA**: ver [Pilotaje del agente IA](#pilotaje-del-agente-ia).

**Stack:** Node.js 24 · TypeScript (strict) · Express 5 · PostgreSQL 17 · Drizzle ORM · zod · pino · `node:test` + supertest.

---

## Índice

1. [Cómo ejecutarlo](#cómo-ejecutarlo)
2. [API](#api)
3. [Arquitectura](#arquitectura)
4. [Estrategia de idempotencia](#estrategia-de-idempotencia)
5. [Manejo de concurrencia](#manejo-de-concurrencia)
6. [Estrategia de retry](#estrategia-de-retry)
7. [Manejo de webhooks](#manejo-de-webhooks)
8. [La pregunta central: timeout sin saber si se cobró](#la-pregunta-central-timeout-sin-saber-si-se-cobró)
9. [Escenarios del challenge → mecanismo → test](#escenarios-del-challenge--mecanismo--test)
10. [Redis vs base de datos para la idempotencia](#redis-vs-base-de-datos-para-la-idempotencia)
11. [¿Qué cambiaría con 1 millón de operaciones al día?](#qué-cambiaría-con-1-millón-de-operaciones-al-día)
12. [Observabilidad](#observabilidad)
13. [Limitaciones conocidas](#limitaciones-conocidas)
14. [Pilotaje del agente IA](#pilotaje-del-agente-ia)

---

## Cómo ejecutarlo

Requisitos: Node.js ≥ 20 y Docker.

```bash
npm install
cp .env.example .env            # configuración local (ya trae valores válidos)
npm run db:up                   # PostgreSQL 17 en Docker (crea las bases cashin y cashin_test)
npm run db:migrate              # migraciones en la base de la app
npm run db:migrate:test         # migraciones en la base de tests
npm run dev                     # http://localhost:3000
```

Calidad:

```bash
npm test                # 133 tests contra PostgreSQL real (unitarios, integración, HTTP, multi-pod)
npm run typecheck && npm run lint && npm run format:check
```

### Probarlo a mano

La pasarela es **simulada** (`fake-payment.provider.ts`) y su comportamiento se elige con `payment_method`:

| `payment_method` | Comportamiento |
|---|---|
| cualquier otro (p. ej. `card_xyz`) | aprueba |
| `card_declined` | rechaza |
| `card_timeout` | no cobra y no responde a tiempo |
| `card_timeout_after_charge` | **cobra, pero la respuesta se pierde** (la pregunta central) |
| `card_unavailable` | error de red |

```bash
curl -X POST localhost:3000/cash-in \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(node -p 'crypto.randomUUID()')" \
  -d '{"user_id":"usr_abc123","amount":100.00,"currency":"PEN","payment_method":"card_xyz"}'
# 200 {"operation_id":"op_…","status":"completed","amount":100,"new_balance":100}
```

Los webhooks se firman con HMAC-SHA256 del body y `WEBHOOK_SECRET` en el header `X-Signature`:

```bash
BODY='{"event_id":"evt_1","operation_id":"op_…","status":"approved","provider_charge_id":"ch_1"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "local_webhook_secret_change_me" | sed 's/^.*= //')
curl -X POST localhost:3000/webhooks/payment -H "Content-Type: application/json" -H "X-Signature: $SIG" -d "$BODY"
```

---

## API

### `POST /cash-in`

Header obligatorio `Idempotency-Key` (UUID). Body: `{ user_id, amount, currency: "PEN", payment_method }`.

| Situación | HTTP | Body |
|---|---|---|
| Cobro aprobado | `200` | `{ operation_id, status: "completed", amount, new_balance }` |
| Cobro rechazado | `402` | `{ operation_id, status: "failed", amount, failure_reason }` |
| Resultado desconocido (timeout, red) o en curso en otro pod | `202` + `Retry-After: 2` | `{ operation_id, status: "pending", amount }` |
| Misma key con **otro** payload | `422` | `IDEMPOTENCY_KEY_REUSED` |
| Key ausente o no UUID / body inválido | `400` | `INVALID_IDEMPOTENCY_KEY` / `VALIDATION_ERROR` con detalle por campo |
| Base de datos no disponible | `503` + `Retry-After: 5` | `SERVICE_UNAVAILABLE` (reintentar con la misma key es seguro) |

`new_balance` es el saldo **justo después de acreditar esa operación**, así que un replay devuelve siempre la misma respuesta.

### `POST /webhooks/payment`

Body: `{ event_id, operation_id, status: "approved" | "declined", provider_charge_id?, occurred_at? }`. Firma en `X-Signature`.

| Situación | HTTP | Body |
|---|---|---|
| Aplicado / ignorado / en conflicto | `200` | `{ received: true, result: "applied" \| "ignored" \| "conflict" }` |
| `event_id` ya recibido | `200` | `{ received: true, duplicate: true }` |
| Firma inválida o ausente | `401` | `INVALID_SIGNATURE` |
| Body inválido (p. ej. `approved` sin `provider_charge_id`) | `400` | `VALIDATION_ERROR` |
| `operation_id` inexistente | `404` | `NOT_FOUND` |
| Error interno o BD caída | `5xx` | la pasarela reintenta |

---

## Arquitectura

```
                 POST /cash-in                         POST /webhooks/payment
App ───────────────────▶ API (N pods) ◀──────────────────────── Pasarela de pagos
                          │    │  charge(op.id) / getChargeStatus(op.id)  ▲
                          │    └──────────────────────────────────────────┘
                          ▼
                     PostgreSQL ── única fuente de verdad:
                     operations · wallets · ledger_entries · webhook_events
                          ▲
       Reconciliador (en cada pod, reserva por lease) ── resuelve UNKNOWN y PROCESSING atascadas
```

**Clean Architecture modular** (detalle completo en [AGENTS.md](AGENTS.md) y [design §2](specs/cash-in/design.md)):

```
src/modules/cash-in/
├── domain/          entidades, value objects ("enums" as const, máquina de estados, Money) y puertos
│                    (repositorios y gateway de la pasarela). Sin HTTP, SQL ni Drizzle.
├── application/     TODA la lógica, legible paso a paso: casos de uso + Unit of Work
│   ├── use-cases/   create-cash-in, claim-operation, settle-operation, mark-operation-unknown,
│   │                handle-payment-webhook, reconcile-operations
│   ├── services/    settle-operation (la ÚNICA forma de finalizar una operación)
│   └── ports/       unit-of-work (varios repositorios en UNA transacción)
└── infrastructure/  adaptadores: repositorios Drizzle (una sentencia atómica por método),
                     controllers HTTP, validación zod, pasarela simulada y job del reconciliador
```

Decisiones principales:

- **PostgreSQL como única fuente de verdad.** Idempotencia, estado y saldo tienen que ser consistentes entre sí, y eso solo lo garantiza una transacción en la misma base.
- **Los repositorios no tienen lógica.** Cada método es una sentencia atómica (`insertIfKeyIsNew`, `changeStatus`, `credit`…). Cuando hay varios pasos que deben ir juntos, el caso de uso los escribe en orden dentro de `unitOfWork.run(...)`.
- **Una sola vía para finalizar.** La respuesta de la pasarela, el webhook y el reconciliador llaman a `settleOperation`. Imposible acreditar dos veces por caminos distintos.
- **Nunca se llama a la pasarela con una transacción abierta.** Se mantendrían locks durante I/O externo (y los webhooks quedarían bloqueados).
- **Dinero en céntimos (`BIGINT`).** Sin errores de coma flotante; la API acepta/devuelve decimales.

### Máquina de estados

```
PROCESSING ──approved──▶ COMPLETED (final)
    │  └──declined──▶ FAILED (final)
    └──timeout / red──▶ UNKNOWN ──approved──▶ COMPLETED
                              └──declined / not_found──▶ FAILED
```

Cada transición es un `UPDATE … WHERE id = $1 AND status IN (estados permitidos)`. Si devuelve 0 filas, otra vía ganó y se trata como no-op. Los estados finales nunca cambian. La lista de estados permitidos se **deriva** de la tabla de transiciones del dominio, así el SQL y el dominio no pueden divergir.

---

## Estrategia de idempotencia

1. La operación se identifica por la `Idempotency-Key` del cliente, con `UNIQUE(idempotency_key)` en `operations`.
2. Se **reclama** con `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`, y se confirma **antes** de llamar a la pasarela. Así, si el pod se cae o llega un webhook temprano, la operación ya existe.
3. Si la key ya existía:
   - mismo payload (comparado por `sha256` de `user_id`, `amount_cents`, `currency` y `payment_method`) → se devuelve el **estado actual** sin volver a cobrar: `200`, `402` o `202`;
   - otro payload → `422 IDEMPOTENCY_KEY_REUSED`.
4. La respuesta no se guarda: se **reconstruye** desde `operations` + `ledger_entries.balance_after_cents`, así nunca diverge del estado real.
5. **Hacia la pasarela**, la clave de idempotencia es `operation.id`: si alguna vez se repitiera el cobro de la misma operación, la pasarela devolvería el resultado del primero.

## Manejo de concurrencia

| Riesgo | Mecanismo |
|---|---|
| Misma key en N pods a la vez | `UNIQUE` + `ON CONFLICT DO NOTHING`: PostgreSQL deja insertar a uno; el resto espera su commit y lee la operación existente. |
| Dos vías finalizando la misma operación | `UPDATE … WHERE status IN (…)`: el segundo encuentra el estado final tras el lock de fila y actualiza 0 filas. |
| Race condition sobre el saldo | `balance_cents = balance_cents + x` en la base, dentro de la misma transacción que el cambio de estado y el ledger. Nunca "leer, sumar en JS y escribir". |
| Doble movimiento en el ledger | `UNIQUE(operation_id)` en `ledger_entries` como última red de seguridad (revierte toda la transacción). |
| Varios reconciliadores | Reserva por lease con `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`: cada pod toma filas distintas; si un pod muere, su reserva vence. |

Probado con **pods reales**: varias apps con pools de conexiones independientes sobre la misma base (`cash-in.http.test.ts`, `cash-in.integration.test.ts`, `reconcile.integration.test.ts`).

## Estrategia de retry

| Quién | Qué reintenta | Por qué es seguro |
|---|---|---|
| **El servicio → pasarela** | **Nada.** Ante timeout o error de red la operación pasa a `UNKNOWN`. | Reintentar a ciegas un cobro es la *red flag* del challenge. La resolución llega por webhook o reconciliador. |
| **El cliente → API** | Reintenta con la **misma** `Idempotency-Key` ante `202`, `503` o un corte de red. | La key garantiza que no se cree otra operación ni se cobre otra vez. |
| **La pasarela → webhook** | Reintenta si recibe `5xx`. | El webhook es idempotente por `event_id` y transaccional: si falla, no queda ni el evento ni su efecto. |
| **Reconciliador** | Consulta `getChargeStatus` (lectura idempotente) cada `RECONCILE_INTERVAL_MS`, y al arrancar. | Si la consulta falla o sigue `pending`, la operación se vuelve a tomar cuando vence su lease. |
| **Base de datos caída** | No hay reintentos internos de escrituras: se responde `503` + `Retry-After`. | El cliente reintenta con la misma key; el pool descarta conexiones caídas sin tumbar el proceso. |

## Manejo de webhooks

1. **Firma** HMAC-SHA256 sobre el **body crudo** (no el JSON re-serializado), comparada con `timingSafeEqual` → `401` si no coincide.
2. **Validación** con zod: un `approved` sin `provider_charge_id` → `400` antes de tocar la base.
3. **En una sola transacción** (caso de uso `HandlePaymentWebhook`):
   1. `INSERT INTO webhook_events … ON CONFLICT (event_id) DO NOTHING` → si no inserta, es **duplicado** (`200 duplicate: true`);
   2. `settleOperation` → si la operación ya era final, **no cambia nada**;
   3. se clasifica el evento: `applied`, `ignored` (coincide con el estado final) o **`conflict`** (lo contradice, p. ej. `declined` tras `COMPLETED`) → se registra y se emite un log `warn` para revisión manual.
4. **Webhook antes que la respuesta de la API:** la operación ya existe (se confirmó antes de cobrar). El webhook la liquida; cuando la pasarela responde a la API, `settleOperation` no aplica nada y la API devuelve el resultado ya liquidado. Una sola acreditación.

## La pregunta central: timeout sin saber si se cobró

> *El proveedor cobra S/100. Antes de responder, ocurre un timeout. No sabes si el cobro se realizó. El cliente reintenta. ¿Cómo evitas cobrar dos veces?*

1. Antes de cobrar, la operación ya está registrada (`PROCESSING`) bajo la `Idempotency-Key`.
2. Timeout → la operación pasa a **`UNKNOWN`** y la API responde `202 pending`. **No se reintenta el cobro.**
3. El cliente reintenta con la **misma key** → encuentra la operación existente y recibe su estado actual. No se crea otra ni se cobra otra vez.
4. El resultado real llega por **dos caminos independientes**, ambos idempotentes:
   - el **webhook** de la pasarela;
   - el **reconciliador**, que consulta `getChargeStatus(operation.id)` (también al arrancar, por si el pod murió).
5. Ambos liquidan con `settleOperation`, que acredita **una sola vez** aunque los dos lleguen a la vez.
6. Y si por error se repitiera la llamada `charge`, la pasarela recibe la misma clave (`operation.id`) y no cobra de nuevo.

Cubierto de punta a punta en `cash-in.http.test.ts` ("pregunta central") y `reconcile.integration.test.ts`.

## Escenarios del challenge → mecanismo → test

| Escenario | Mecanismo | Test |
|---|---|---|
| Doble click / retry de la app | `UNIQUE` + `ON CONFLICT`; replay devuelve el estado actual | `cash-in.http.test.ts` (replay), `cash-in.integration.test.ts` (ClaimOperation) |
| Múltiples pods concurrentes | La exclusión vive en PostgreSQL, no en memoria | "10 requests con la misma key repartidas en 3 pods" |
| Timeout del proveedor | `UNKNOWN` sin reintento + webhook / reconciliador | "pregunta central", `reconcile.integration.test.ts` |
| Webhook duplicado | `webhook_events.event_id` PK, en la transacción del efecto | "evento duplicado" (HTTP e integración, 2 pods) |
| Webhook fuera de orden | Estados finales inmutables + clasificación `conflict` | "fuera de orden: declined tras COMPLETED" |
| Webhook antes que la respuesta | Operación persistida antes de cobrar; `settle` condicional | "webhook antes que la respuesta de la API" |
| Fallo temporal de DB | `503` + `Retry-After`; el pool sobrevive a conexiones caídas | "base de datos caída", `pool-recovery.test.ts` |
| Reinicio durante la operación | `PROCESSING` persistida; el reconciliador la retoma al arrancar | "pod reiniciado antes de cobrar" |
| Race condition sobre el saldo | `balance + x` atómico + `UNIQUE(operation_id)` en el ledger | "20 concurrent credits to one wallet keep the exact sum" |

## Redis vs base de datos para la idempotencia

**Base de datos** (lo elegido), porque:
- La idempotencia de un cash-in no es solo "¿vi esta key?": la key, el estado de la operación y el saldo tienen que cambiar **juntos**. Eso es una transacción ACID en una sola base; con Redis + PostgreSQL habría dos fuentes de verdad y casos sin solución limpia (Redis marcó la key, el pod murió antes de acreditar).
- La garantía la da una **restricción** (`UNIQUE`), no un lock que puede expirar.
- Durabilidad: en Redis una key puede perderse por TTL, por expulsión de memoria o en un failover (la réplica es asíncrona). En dinero, perder una key = cobrar dos veces.

**Redis sí**, como **capa delante** y nunca como única garantía: un `SET key NX EX 60` para cortar duplicados masivos antes de tocar la base, locks cortos para evitar trabajo duplicado caro, o caché de respuestas finales. Si Redis falla, PostgreSQL sigue garantizando la exactitud. Para operaciones no críticas (notificaciones, analítica) Redis solo sí puede bastar.

## ¿Qué cambiaría con 1 millón de operaciones al día?

1 M/día son ~12 operaciones/s de media (picos de 100–200/s). PostgreSQL lo soporta sin cambios de diseño; lo que sí haría:

- **Pasarela real y asíncrona:** cobrar desde un worker (cola tipo SQS/Kafka con *outbox pattern*) y responder `202` siempre; el cliente consulta o recibe la notificación. Desacopla la latencia de la pasarela de la API.
- **Particionado y retención:** particionar `operations` y `webhook_events` por fecha; archivar y expirar las idempotency keys (p. ej. 24–72 h, a acordar con negocio).
- **Saldo sin cuello de botella:** si un mismo usuario concentra mucho volumen, el `UPDATE` de su wallet serializa; se puede pasar a un ledger *append-only* con saldo materializado por lotes.
- **Redis como filtro previo** de duplicados (ver arriba) y **pool de conexiones** con PgBouncer.
- **Reconciliador dedicado** (no en cada pod), con métricas de antigüedad de `UNKNOWN`.
- **Observabilidad:** métricas (tasa de `UNKNOWN`, `conflict`, latencia de la pasarela) y alertas; trazas distribuidas (OpenTelemetry) con el `X-Request-Id`.

## Observabilidad

- **Correlation ID:** `X-Request-Id` se acepta (si es seguro) o se genera, se devuelve en la respuesta y viaja en todos los logs de la request.
- **Logs estructurados** (pino, JSON) con `requestId`, `operationId`, transición de estado, resultados del reconciliador y `warn` en webhooks en conflicto.
- Los errores nunca exponen stack traces al cliente.

## Limitaciones conocidas

- **La pasarela es simulada y vive en memoria.** Si el servidor se reinicia, "olvida" sus cobros: el reconciliador consultaría `not_found` y marcaría `FAILED` una operación que en realidad sí se cobró. Con una pasarela real (que persiste sus cobros) no ocurre; en producción `not_found` solo debería confiarse pasado un margen acordado con la pasarela.
- Sin autenticación de usuarios (fuera del alcance del challenge); `user_id` se toma tal cual llega.
- Las idempotency keys no expiran (pregunta abierta para negocio).
- Los webhooks en `conflict` solo se registran y se loguean; no hay alerta ni cola de revisión manual.

---

## Pilotaje del agente IA

Esta es la sección clave del challenge: **qué se le pidió al agente y qué hubo que corregir**. El registro completo, con cada propuesta del agente, la corrección humana y el porqué, está en **[docs/ai-log.md](docs/ai-log.md)**.

### Forma de trabajo: guiada por specs

1. **Agente A** redactó el spec a partir del PDF del challenge: [requirements](specs/cash-in/requirements.md) (requisitos verificables, marcando qué sale del documento y qué es una suposición), [design](specs/cash-in/design.md) y [tasks](specs/cash-in/tasks.md) (tareas con criterios de aceptación y puntos de control).
2. **Revisión humana** del spec antes de implementar.
3. **Agente B**, en otro chat, implementó tarea por tarea con un commit por tarea, con la regla de **no cambiar el spec en silencio** y anotar las dudas.
4. **Agente A** revisó cada bloque contra el spec; los hallazgos y las correcciones quedaron en el log.

### Correcciones más relevantes

| Qué propuso el agente | Qué se corrigió | Quién lo detectó |
|---|---|---|
| El reconciliador consultaba la pasarela **dentro** de una transacción con `FOR UPDATE SKIP LOCKED`, contradiciendo otra regla del propio spec. | Reserva por **lease** en una transacción corta; consulta fuera de cualquier transacción. | El agente B se **detuvo** y lo preguntó; decisión humana. |
| `Pool` de `pg` sin manejador de `'error'`. | `pool.on('error')` + test. **Se reprodujo:** cortar una conexión inactiva tumbaba el proceso (un reinicio de la BD habría tumbado todos los pods). | Revisión del agente A. |
| Lógica de negocio dentro del repositorio (liquidar, deduplicar webhooks) porque era el único con la transacción. | **Unit of Work**: la lógica pasa a casos de uso legibles; los repositorios, a una sentencia por método. | Revisión humana: "los repositorios solo deberían hablar con la BD". |
| Literales repetidos (`'PROCESSING'`, `'PEN'`…) y una máquina de estados del dominio que el SQL no usaba (podían divergir). | Constantes `as const` junto a su concepto; la lista de estados del SQL se deriva de la tabla de transiciones. | Revisión humana + validación de A. |
| Errores de dominio con códigos HTTP; entidad con un campo de infraestructura (el lease). | Errores con `code` y traducción a HTTP en la capa web; entidad limpia. | Revisión de A. |
| Código denso (101 líneas > 100 caracteres), sin formatter ni linter. | Prettier + ESLint obligatorios; valores y tipos con nombre. | Revisión humana. |
| "Sin ORM" en el spec / ORM obligatorio para todo. | Drizzle para demostrar su integración, con SQL crudo donde sea mejor; lo obligatorio es la semántica atómica. | Decisión humana. |
| Comentarios en inglés, helpers sueltos, archivos sin sufijo de tipo. | Comentarios en español, helpers en archivos propios o métodos privados, `kebab-case.<tipo>.ts`. | Revisión humana. |

También se registran los errores operativos del propio agente (comandos de shell que dejaron archivos basura en la raíz), porque **revisar el `git status` antes de cada commit** fue parte del control humano.
