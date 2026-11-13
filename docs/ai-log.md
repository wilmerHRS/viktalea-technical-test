# Registro de pilotaje del agente IA

> Qué se le pidió al agente (specs y prompts), qué propuso, qué se corrigió y por qué.
> Es la "sección clave" que pide el challenge. Cada entrada debe ser **real**: si no hubo corrección, no se inventa.

## Forma de trabajo

1. **Agente A (autor del spec)** redacta `specs/cash-in/{requirements,design,tasks}.md` a partir del PDF del challenge.
2. **Revisión humana** del spec: ajustes y decisiones que se anotan abajo.
3. **Agente B (implementador)**, en otro chat, implementa `tasks.md` tarea por tarea, con un commit por tarea. Si detecta problemas en el spec, los anota en *Dudas del implementador*.
4. **Agente A (revisor)** contrasta cada tarea con `requirements.md` y `design.md`. Los hallazgos se corrigen y se registran aquí.

## Fase 0: scaffold del proyecto (antes del challenge)

| # | Qué propuso el agente | Corrección humana | Por qué |
|---|---|---|---|
| 0.1 | Proyecto en JavaScript (ESM + JSDoc). | "Hazlo con TypeScript". | Tipado estático para contratos (puertos, DTOs). |
| 0.2 | Repositorio como clase abstracta. | Pregunta: "¿aplicas interfaces para los repositorios?". Se confirmó el uso de `interface` + `implements`. | Los puertos de Clean Architecture deben ser contratos verificados en compilación. |
| 0.3 | Imports relativos con extensión `.js` (requisito de `nodenext`). | "Las importaciones hacen referencia a archivos js". Se cambió a `.ts` con `rewriteRelativeImportExtensions`. | Legibilidad: el import debe apuntar al archivo real. |
| 0.4 | `env.ts` con validación extensa (reglas de CORS por entorno, validación de URL, `superRefine` con `when`). | "Tiene muchas validaciones que no hacen entendible el archivo". Se simplificó a un esquema zod de ~35 líneas. | La validación de configuración debe ser legible. Las reglas condicionales se quitaron por complejidad sin valor real. |
| 0.5 | El agente dejó un archivo vacío `{}` en la raíz (efecto secundario de un comando de shell mal escapado). | "¿Para qué creaste este archivo?". Se eliminó. | Basura accidental: revisar siempre el árbol de archivos antes de hacer commit. |
| 0.6 | Registro de módulos escondido (`createApp({ modules })` + `src/modules/index.ts`). | "No entiendo de dónde sale `modules`". Ahora `main.ts` crea los módulos y los pasa a `createApp([...])`. | La composición debe ser explícita en el entry point. |

## Fase 1: spec del Cash-In

| # | Qué se pidió | Resultado / decisión | Revisión humana |
|---|---|---|---|
| 1.1 | "Genera los specs a partir del PDF del challenge" | `requirements.md` (requisitos verificables R1–R9 con fuente [DOC]/[ASUMIDO]), `design.md` (PostgreSQL como fuente de verdad, `settle()` único, máquina de estados, reconciliación con `SKIP LOCKED`) y `tasks.md` (T1–T10 con criterios de aceptación). | Ver 1.3–1.6. |
| 1.3 | Docker compose de PostgreSQL con usuario y contraseña. | El agente puso las credenciales como defaults de interpolación (`${POSTGRES_USER:-cashin}`) y después las movió a `.env` con `${VAR:?}`. | "No veo la configuración del usuario y contraseña" y "colócalo de forma directa en el compose". Las credenciales se escribieron literalmente en `environment:`, y el healthcheck y el init las usan como variables del contenedor (`$${POSTGRES_USER}`). |
| 1.4 | Conexión de la app a la BD. | El agente propuso `DATABASE_URL` en una sola línea (convención twelve-factor). | "Separa la configuración de la BD porque no es entendible en URL". Se cambió a `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` y `DB_NAME` (requisito NFR5). |
| 1.5 | Acceso a datos. | El spec original decía "sin ORM, SQL explícito con `pg`", para no esconder las primitivas de concurrencia. | "Lo mejor es un ORM para demostrar que sabes usarlo". Se adoptó **Drizzle ORM**: soporta `onConflictDoNothing`, `.for('update', { skipLocked: true })` e incrementos con `` sql`` ``. Se descartó Prisma porque no soporta `SKIP LOCKED` y obligaría a escribir SQL crudo. Se añadió design §6.5, que lista las construcciones obligatorias y las prohibidas (`findFirst` + `insert`, sumar en JS, llamar a la pasarela dentro de una transacción). |
| 1.6 | Alcance del ORM. | Tras 1.5, el agente dejó el uso del query builder como **obligatorio** para todas las garantías. | "El ORM es para que sepan que sé integrarlo; si hace falta SQL crudo y es lo mejor, hay que usarlo". NFR3 y design §6.5 ahora fijan la **semántica** (operaciones atómicas en la BD) y dejan libre la sintaxis: builder por defecto y `` sql`…` `` donde convenga. |
| 1.2 | (autocorrección del agente durante la redacción) | En design §6.3, el flujo del webhook registraba el evento *después* de `settle`, lo que contradecía la deduplicación atómica. Se reescribió: INSERT del evento → `settle` → UPDATE del `result`, todo en una sola transacción. | |

## Fase 2: implementación (agente B)

| Tarea | Qué hizo el agente | Problema detectado en la revisión | Corrección |
|---|---|---|---|
| Antes de T1 | El agente implementador (B) leyó el spec y **se detuvo antes de escribir código**. | B detectó una contradicción en el spec que escribió el agente A: design §6.4 llamaba a `getChargeStatus()` dentro de la transacción con `FOR UPDATE SKIP LOCKED`, y §6.5 prohíbe llamar a la pasarela dentro de una transacción. Propuso dos opciones: (1) una excepción para consultas o (2) una reserva persistente con vencimiento. | Decisión humana: **opción 2**. La opción 1 mantendría hasta 10 o 50 locks y una conexión durante llamadas externas (minutos), y bloquearía los webhooks. Clave del razonamiento: la exclusión del reconciliador solo evita trabajo duplicado, porque la exactitud ya la da el `settle()` condicional; basta con un lease (`reconcile_locked_until`) reservado en una transacción corta. Se corrigieron R7.3, design §3, §5, §6.4, §6.5 y §9, y T4 y T9. |

## Riesgos típicos de un agente que se vigilan en la revisión

- Idempotencia con `Map`/`Set` en memoria o con un "check-then-insert" sin restricción `UNIQUE` (falla con varios pods).
- Leer el saldo, sumarlo en JS y escribirlo (lost update).
- Reintentar `charge()` tras un timeout (doble cobro).
- Procesar webhooks sin deduplicar o permitir que un estado final cambie.
- Llamar a la pasarela dentro de una transacción abierta (bloquea filas durante I/O externo).
- Tests que mockean la base de datos y por eso no prueban la concurrencia real.
`n### T1 — Infraestructura`nSe integraron Drizzle y pg, las cuatro tablas con la columna de lease, migraciones generadas y configuración validada. Se comprobó el SQL generado y las restricciones en PostgreSQL real. typecheck y 40 tests pasan. RECONCILE_LEASE_MS se declara desde T1 junto a las demás variables de §9; su relación con el timeout se comprobará al componer el reconciliador en T9 para mantener simple envSchema. El reexport de esquemas en shared sigue el diseño explícito de T1, como registro técnico de esquemas. Sin cambios en Docker ni en requirements/design.
