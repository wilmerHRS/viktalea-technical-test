# Requirements: Wallet Cash-In

> Spec 1 de 3 (`requirements.md` → `design.md` → `tasks.md`).
> Fuente: *Challenge Técnico, Senior Backend Developer* (Ligo Tech, B2C, agosto 2026).
> Cada requisito tiene un ID (`R<n>.<m>`) que referencian `design.md`, `tasks.md` y los tests.
> Etiquetas: **[DOC]** sale del documento del challenge · **[ASUMIDO]** es una decisión nuestra que el documento no define.

## 1. Objetivo

Servicio de **recarga de saldo (Cash-In)**: cobra un monto a través de una pasarela de pagos externa y lo acredita en la wallet del usuario **exactamente una vez**, aunque haya reintentos, varios pods, timeouts o webhooks duplicados o desordenados. [DOC]

Pregunta central que la solución debe responder [DOC]:
> *La pasarela cobra S/100. Antes de responder ocurre un timeout. No sabes si el cobro se realizó. El cliente reintenta. ¿Cómo evitas cobrar dos veces?*

## 2. Glosario

| Término | Significado |
|---|---|
| Operación | Un intento de cash-in identificado por `operation_id`. Es la unidad de idempotencia. |
| Idempotency-Key | UUID que envía el cliente. La misma key significa la misma operación. |
| Pasarela (provider) | Servicio externo que cobra. Aquí se simula con un adaptador falso. |
| Liquidar (settle) | Llevar una operación a un estado final (`COMPLETED` o `FAILED`) y, si es `COMPLETED`, acreditar el saldo. |
| Ledger | Registro inmutable de movimientos de saldo: un movimiento por operación completada. |

## 3. Requisitos funcionales

### R1. Endpoint `POST /cash-in` [DOC]

- **R1.1** El sistema DEBE exponer `POST /cash-in`, sin prefijo de versión, con el header obligatorio `Idempotency-Key`.
- **R1.2** SI falta `Idempotency-Key` o no es un UUID válido, ENTONCES DEBE responder `400` con `code: "INVALID_IDEMPOTENCY_KEY"`.
- **R1.3** El body DEBE tener esta forma:
  ```json
  { "user_id": "usr_abc123", "amount": 100.00, "currency": "PEN", "payment_method": "card_xyz" }
  ```
  - `user_id`: string no vacío.
  - `amount`: número mayor que 0 con un máximo de 2 decimales.
  - `currency`: solo `"PEN"` [ASUMIDO a partir del ejemplo del documento].
  - `payment_method`: string no vacío.

  SI el body es inválido, ENTONCES DEBE responder `400` con `code: "VALIDATION_ERROR"` y el detalle por campo.
- **R1.4** SI el usuario no tiene wallet, ENTONCES el sistema DEBE crearla con saldo 0 en la primera recarga. [ASUMIDO: el documento no define cómo nacen las wallets]
- **R1.5** CUANDO el cobro es aprobado, el sistema DEBE responder `200` con:
  ```json
  { "operation_id": "op_…", "status": "completed", "amount": 100.00, "new_balance": 350.00 }
  ```
  `new_balance` es el saldo justo después de acreditar **esta** operación.
- **R1.6** CUANDO la pasarela rechaza el cobro, el sistema DEBE responder `402` con `{ operation_id, status: "failed", amount, failure_reason }` y NO DEBE modificar el saldo. [ASUMIDO: código 402]
- **R1.7** CUANDO no se puede determinar el resultado del cobro (timeout o error de red con la pasarela), el sistema DEBE responder `202` con `{ operation_id, status: "pending", amount }` y el header `Retry-After`. NO DEBE reintentar el cobro por su cuenta (ver R4).

### R2. Idempotencia [DOC: "Idempotencia real (multi-pod)"]

- **R2.1** CUANDO llegan varias requests con la misma `Idempotency-Key` y el mismo payload (doble click o retry de la app), el sistema DEBE crear **una sola** operación, cobrar **una sola** vez y acreditar **una sola** vez.
- **R2.2** CUANDO se repite una key cuya operación ya terminó, el sistema DEBE devolver la **misma respuesta** (mismo código y mismo body, incluido el mismo `new_balance`) sin llamar a la pasarela.
- **R2.3** CUANDO se repite una key cuya operación sigue en curso o está sin resolver, el sistema DEBE responder `202 pending` con `Retry-After`, sin volver a cobrar.
- **R2.4** CUANDO se repite una key con un payload **distinto**, el sistema DEBE responder `422` con `code: "IDEMPOTENCY_KEY_REUSED"` y NO DEBE crear ni modificar operaciones.
- **R2.5** La garantía DEBE cumplirse con **N pods concurrentes**: la exclusión la da la base de datos compartida, NUNCA el estado en memoria del proceso. [DOC: red flag "idempotencia solo con variable en memoria" y "no considera múltiples pods"]
- **R2.6** La `Idempotency-Key` es única a nivel global, no por usuario. [ASUMIDO]

### R3. Máquina de estados de la operación [DOC]

- **R3.1** Una operación DEBE estar siempre en uno de estos estados: `PROCESSING`, `UNKNOWN`, `COMPLETED` o `FAILED`.
- **R3.2** Las únicas transiciones válidas son:
  - `PROCESSING → COMPLETED | FAILED | UNKNOWN`
  - `UNKNOWN → COMPLETED | FAILED`
- **R3.3** `COMPLETED` y `FAILED` son **finales**: ningún evento posterior puede cambiarlos.
- **R3.4** Toda transición DEBE aplicarse de forma atómica y condicionada al estado actual. Si el estado ya cambió, la transición NO se aplica y no da error: es un no-op.
- **R3.5** Mapeo hacia la API: `PROCESSING` y `UNKNOWN` se exponen como `"pending"`, `COMPLETED` como `"completed"` y `FAILED` como `"failed"`.

### R4. Integración con la pasarela [DOC: "timeout del proveedor", red flag "retry indiscriminado"]

- **R4.1** El sistema DEBE enviar a la pasarela el `operation_id` como **clave de idempotencia del cobro**, para que la pasarela nunca cobre dos veces la misma operación.
- **R4.2** La llamada a la pasarela DEBE tener un timeout configurable (`PROVIDER_TIMEOUT_MS`).
- **R4.3** SI la pasarela responde "aprobado", la operación pasa a `COMPLETED`. SI responde "rechazado", pasa a `FAILED`.
- **R4.4** SI hay timeout o error de red, la operación DEBE pasar a `UNKNOWN`. El sistema NO DEBE reintentar el cobro automáticamente. La resolución llega por webhook (R5) o por reconciliación (R7).

### R5. Endpoint `POST /webhooks/payment` [DOC]

- **R5.1** El sistema DEBE exponer `POST /webhooks/payment` con este body [ASUMIDO: el documento no define el contrato]:
  ```json
  { "event_id": "evt_123", "operation_id": "op_…", "status": "approved", "provider_charge_id": "ch_456", "occurred_at": "2026-08-01T10:00:00Z" }
  ```
  `status` puede ser `"approved"` o `"declined"`.
- **R5.2** El sistema DEBE verificar la firma `X-Signature`, que es un HMAC-SHA256 en hex del body crudo con `WEBHOOK_SECRET`. SI la firma es inválida o falta, ENTONCES DEBE responder `401` y no procesar nada. [ASUMIDO]
- **R5.3** **Duplicados**: CUANDO llega un `event_id` ya recibido, el sistema DEBE responder `200` sin reprocesarlo. [DOC]
- **R5.4** **Fuera de orden**: CUANDO un evento intenta cambiar una operación ya finalizada, el sistema NO DEBE modificarla. DEBE registrar el evento y, si contradice el estado final (por ejemplo, `approved` sobre `FAILED`), DEBE registrarlo como `conflict` en los logs para revisión manual. Responde `200`. [DOC]
- **R5.5** **Webhook antes que la respuesta de la API**: SI el webhook liquida la operación mientras la request de `/cash-in` sigue esperando a la pasarela, ENTONCES esa request DEBE devolver el resultado final sin volver a acreditar. [DOC]
- **R5.6** SI `operation_id` no existe, ENTONCES el sistema DEBE responder `404`.
- **R5.7** SI ocurre un error interno, por ejemplo con la base de datos, ENTONCES el sistema DEBE responder `5xx` para que la pasarela reintente el webhook.

### R6. Saldo y ledger [DOC: "race condition sobre el saldo"]

- **R6.1** Pasar una operación a `COMPLETED`, registrar su movimiento en el ledger e incrementar el saldo DEBE ocurrir en **una única transacción**.
- **R6.2** Cada operación DEBE generar como máximo **un** movimiento en el ledger. La base de datos lo garantiza con una restricción de unicidad.
- **R6.3** Recargas concurrentes del mismo usuario con keys distintas DEBEN sumarse sin perder ninguna actualización (no se permite leer, sumar en memoria y escribir).
- **R6.4** Los montos se almacenan como enteros en céntimos. La API los expone como número decimal de 2 decimales.

### R7. Reconciliación [DOC: "timeout del proveedor", "reinicio del servicio durante la operación"]

- **R7.1** El sistema DEBE ejecutar periódicamente (`RECONCILE_INTERVAL_MS`) y al arrancar un proceso que busque operaciones en `UNKNOWN`, o en `PROCESSING` con más antigüedad que `RECONCILE_AFTER_MS`, y consulte su estado en la pasarela.
- **R7.2** Según la respuesta de la pasarela:
  - `approved`: la operación pasa a `COMPLETED` (acredita).
  - `declined`: pasa a `FAILED`.
  - `not_found`: pasa a `FAILED`, porque el cobro nunca llegó a la pasarela.
  - `pending` o error: la operación se deja como está para el siguiente ciclo.
- **R7.3** Varios pods ejecutando la reconciliación a la vez NO DEBEN procesar la misma operación al mismo tiempo.

### R8. Resiliencia [DOC: "fallo temporal de DB", "reinicio del servicio"]

- **R8.1** SI la base de datos no está disponible, ENTONCES la API DEBE responder `503` con `code: "SERVICE_UNAVAILABLE"`. El cliente puede reintentar con la misma key de forma segura.
- **R8.2** Un reinicio en cualquier punto del flujo NO DEBE producir doble cobro ni doble acreditación, y la operación DEBE terminar resolviéndose por webhook o reconciliación.
- **R8.3** Los errores internos NO DEBEN exponer stack traces ni detalles internos en la respuesta.

### R9. Observabilidad [DOC: "trace/correlation ID"]

- **R9.1** Toda request DEBE tener un correlation ID: se toma de `X-Request-Id` si viene o se genera uno, y se devuelve en la respuesta.
- **R9.2** Los logs DEBEN ser estructurados (JSON) e incluir `requestId` y, cuando aplique, `operationId`, `idempotencyKey` y la transición de estado (`from → to`).

## 4. Requisitos no funcionales

- **NFR1** Stack y arquitectura existentes: Node.js + Express 5 + TypeScript, Clean Architecture modular (ver `AGENTS.md`).
- **NFR2** Persistencia en **PostgreSQL**, levantado con `docker compose`. Es la única fuente de verdad para idempotencia, estados y saldo.
- **NFR3** Acceso a datos con **Drizzle ORM** (`drizzle-orm` + driver `pg`, migraciones con `drizzle-kit`): esquema tipado, cliente, transacciones y consultas. Se usa el query builder por defecto, y **SQL crudo** (`` sql`…` ``, `db.execute(sql`…`)`) cuando sea más claro o más correcto que el builder. Lo que importa es la semántica, no la herramienta: las garantías de concurrencia deben ser atómicas en la BD (`ON CONFLICT DO NOTHING`, `UPDATE … WHERE status IN (…)`, `balance = balance + x`, `FOR UPDATE SKIP LOCKED`). Está prohibido "leer, comprobar y escribir" para idempotencia, transiciones o saldo. [decisión humana al revisar el spec: el ORM se adopta para demostrar su integración, no como restricción]
- **NFR5** La conexión a la base de datos se configura con variables separadas (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`), no con una URL. [decisión humana al revisar el spec]
- **NFR4** Alcance acotado a 3–4 horas: *"Preferimos una solución pequeña, bien diseñada y bien explicada"*. [DOC]

## 5. Tests mínimos obligatorios [DOC]

| Escenario del documento | Requisitos |
|---|---|
| Éxito | R1.5, R6.1 |
| Fallo de la pasarela (rechazo) | R1.6 |
| Timeout de la pasarela y resolución posterior | R1.7, R4.4, R7.2 |
| Idempotencia: replay con la misma key | R2.2 |
| Doble click / retry concurrente con la misma key | R2.1 |
| Varios pods (varias instancias de la app sobre la misma BD) | R2.5 |
| Misma key con otro payload | R2.4 |
| Webhook duplicado | R5.3 |
| Webhook fuera de orden | R5.4 |
| Webhook antes que la respuesta de la API | R5.5 |
| Race condition sobre el saldo (keys distintas en paralelo) | R6.3 |
| Reinicio a mitad de la operación (operación en `PROCESSING` resuelta por reconciliación) | R7, R8.2 |
| Fallo temporal de la base de datos | R8.1 |

## 6. Fuera de alcance

- Autenticación de usuarios. `user_id` se toma tal cual llega.
- Varias monedas, retiros, reembolsos y contracargos.
- Integración con una pasarela real (se usa un adaptador falso detrás de un puerto).
- Expiración (TTL) de las Idempotency-Keys.
- Endpoint de consulta `GET /cash-in/:id`: el cliente consulta reintentando con la misma key.
- Métricas, dashboards y despliegue.

## 7. Preguntas abiertas (para resolver en la defensa o con el negocio)

- **Q1**: ¿Las Idempotency-Keys deben expirar? ¿Después de cuánto tiempo? (afecta a R2.6)
- **Q2**: ¿Quién resuelve los webhooks en `conflict`? ¿Hace falta una alerta? (afecta a R5.4)
- **Q3**: ¿Hay un monto máximo por recarga o por día? (afecta a R1.3)
