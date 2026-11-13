# AGENTS.md

Guía para agentes de IA (y humanos) que trabajen en este repositorio.

## Trabajo guiado por specs

Las features se especifican en `specs/<feature>/` antes de implementarse:

1. `requirements.md`: qué debe pasar (requisitos con ID `R<n>.<m>`).
2. `design.md`: cómo se construye (modelo de datos, flujos, decisiones).
3. `tasks.md`: pasos de implementación con criterios de aceptación.

Si te piden implementar una feature que tiene spec: lee los tres archivos, sigue `tasks.md` **una tarea a la vez** y no cambies el spec en silencio. Si algo es incorrecto o ambiguo, anótalo en la sección *Dudas del implementador* de `tasks.md`. Las decisiones y correcciones del pilotaje de IA se registran en `docs/ai-log.md`.

Spec activo: [`specs/cash-in/`](specs/cash-in/) (challenge Wallet Cash-In).

## Stack

- **Node.js ≥ 20** + **TypeScript** (`strict`, `module: nodenext`) con **ES Modules** (`"type": "module"`).
  - Los imports relativos se escriben con la extensión real **`.ts`** (`import { User } from './User.ts'`). `tsc` los reescribe a `.js` al compilar a `dist/` (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`). No uses imports sin extensión ni con `.js`.
  - `verbatimModuleSyntax` está activo: los imports que solo son tipos van con `import type { ... }` o `type` inline (`import { toUserDto, type UserDto }`).
- **Express 5**: los errores de los handlers `async` llegan solos al `errorHandler`, así que no hace falta `try/catch` ni `asyncHandler`.
- `helmet` + `cors` como middlewares de seguridad.
- **tsx** para desarrollo y tests (ejecuta TS sin compilar); **tsc** solo para typecheck y build a `dist/`.
- Tests con el runner nativo **`node:test`** + `node:assert/strict` + **supertest**.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | `tsx watch` sobre `src/main.ts`, carga `.env` si existe |
| `npm run typecheck` | `tsc --noEmit` sobre `src/` y `tests/` |
| `npm run lint` | ESLint (`typescript-eslint`) sobre `src/` y `tests/` |
| `npm run format` / `npm run format:check` | Prettier: formatea / verifica el formato (ancho máximo 100) |
| `npm test` | Ejecuta `tests/**/*.test.ts` con `tsx --test` |
| `npm run build` | Compila `src/` a `dist/` (`tsconfig.build.json`) |
| `npm start` | Ejecuta `dist/main.js` (requiere `build` previo) |
| `npm run db:up` | Levanta PostgreSQL 17 (`docker-compose.yml`) y espera a que esté sano |
| `npm run db:down` | Detiene el contenedor (conserva los datos) |
| `npm run db:reset` | Borra el volumen y recrea la BD desde cero (vuelve a ejecutar `docker/postgres/init`) |
| `npm run db:logs` / `npm run db:psql` | Logs del contenedor / consola `psql` dentro del contenedor |

Base de datos local: las credenciales están directamente en `docker-compose.yml` (usuario `cashin`, contraseña `cashin_local`, bases `cashin` y `cashin_test`, puerto 5432). La app se conecta con `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` y `DB_NAME` de `.env`, que deben coincidir con esos valores. Postgres aplica las credenciales **solo al crear el volumen**: si las cambias en el compose, ejecuta `npm run db:reset` (borra los datos) y actualiza `.env`.

Acceso a datos: **Drizzle ORM** (`drizzle-orm` + `pg`, migraciones con `drizzle-kit`). El esquema Drizzle vive en `modules/<module>/infrastructure/persistence/schema.ts`; el dominio nunca importa Drizzle. Usa el query builder por defecto y SQL crudo (`` sql`…` ``, `db.execute`) cuando sea más claro o correcto. Para idempotencia, transiciones de estado y saldo se usan siempre operaciones atómicas en la BD (`onConflictDoNothing`, `UPDATE … WHERE status IN`, `` sql`col + x` ``, `.for('update', { skipLocked: true })`), nunca "leer, comprobar y escribir".

Antes de dar una tarea por terminada: `npm run typecheck && npm run lint && npm run format:check && npm test`.

Variables de entorno: ver `.env.example` (`NODE_ENV`, `PORT`, `CORS_ORIGIN`). Se leen **solo** en `src/config/env.ts`, que las valida con un esquema **zod** al arrancar. Si alguna es inválida, la app no inicia y muestra cuál falla. El resto del código importa `env` (tipado, p. ej. `env.PORT`). Para añadir una variable: agrégala al `envSchema` (con `.default()` si es opcional), a `.env.example` y a `tests/config/env.test.ts`. Mantén el esquema simple, sin reglas condicionales.

## Arquitectura: Clean Architecture modular

El código se organiza **por módulo de negocio** (feature) y, dentro de cada módulo, **por capa**.

```
src/
├── main.ts                    # Entry point: crea los módulos, se los pasa a createApp() y levanta el servidor
├── app.ts                     # createApp(modules): middlewares globales + monta los módulos recibidos en /api/v1
├── config/
│   └── env.ts                 # Única fuente de configuración (process.env), tipada
├── shared/                    # Código transversal, sin lógica de negocio de un módulo
│   ├── domain/
│   │   └── errors/            # AppError, ValidationError, NotFoundError, ConflictError, FieldError
│   └── infrastructure/
│       └── http/
│           ├── HttpModule.ts  # Interface { basePath, router } que expone cada módulo
│           └── middlewares/   # errorHandler, notFound
└── modules/
    └── <module>/              # p. ej. users/
        ├── index.ts           # Composition root del módulo (inyección de dependencias manual)
        ├── domain/            # Núcleo: SOLO conceptos de negocio (sin HTTP, SQL, ORM ni detalles de infraestructura)
        │   ├── entities/      # Entidades con invariantes y factorías (Entity.create / Entity.restore)
        │   ├── value-objects/ # Valores y reglas puras: "enums" as const, máquina de estados, Money…
        │   ├── repositories/  # Puertos de persistencia (interfaces TS) que la infraestructura implementa
        │   └── gateways/      # Puertos hacia sistemas externos (p. ej. la pasarela de pagos)
        ├── application/       # TODA la lógica de orquestación: se lee paso a paso
        │   ├── ports/         # Puertos de la aplicación (p. ej. UnitOfWork: varias escrituras en una transacción)
        │   ├── services/      # Pasos reutilizados por varios casos de uso (p. ej. settleOperation)
        │   ├── use-cases/     # Una clase por caso de uso con método execute()
        │   └── dtos/          # Tipos de entrada/salida + mapeo entidad → DTO
        └── infrastructure/    # Adaptadores: detalles técnicos intercambiables
            ├── persistence/   # Implementaciones de los repositorios (InMemory, Postgres, …)
            └── http/          # Controller + router de Express
tests/
└── modules/<module>/          # Tests unitarios (casos de uso) e integración HTTP (supertest)
dist/                          # Salida de `npm run build` (ignorada por git)
```

### Regla de dependencias (obligatoria)

Las dependencias apuntan **siempre hacia adentro**:

```
infrastructure  →  application  →  domain
```

- `domain/` **no importa** de `application/`, `infrastructure/`, `express` ni ninguna librería de I/O. Solo puede importar de `shared/domain`.
- `application/` importa de `domain/` y `shared/domain`. **Nunca** de `infrastructure/` ni de `express`. Recibe los repositorios por constructor (tipados contra el puerto del dominio).
- `infrastructure/` puede importar de todas las capas y de librerías externas.
- Un módulo **no importa archivos internos de otro módulo**. Si dos módulos necesitan colaborar, se expone un caso de uso/puerto desde el `index.ts` del módulo proveedor y se inyecta en el composition root.
- `shared/` no importa nada de `modules/`.

### Convenciones

- **Nombres de archivo**: clases e interfaces en `PascalCase.ts` (`CreateUser.ts`, `UserRepository.ts`); funciones/fábricas en `camelCase.ts` (`userRoutes.ts`, `errorHandler.ts`).
- **Tipado**: nada de `any`; para datos externos sin validar usa `unknown` y valida en la entidad. Tipa explícitamente los retornos de funciones públicas. Los puertos son `interface` y los adaptadores usan `implements`.
- **Idioma**: los **comentarios y la documentación van en español**; los identificadores (variables, funciones, clases, archivos) y los mensajes de la API, en inglés.
- **Helpers y utilidades**: nunca sueltos entre el código de una clase o servicio. Si los usa una sola clase, van como **métodos privados** de esa clase. Si los usan varios archivos, van en **un archivo propio** con nombre descriptivo (p. ej. `shared/utils/withTimeout.ts`, `shared/infrastructure/db/sqlTime.ts`, `infrastructure/persistence/operationMapper.ts`).
- **Legibilidad**:
  - Una idea por línea. Si una expresión combina varias decisiones (condiciones compuestas, consultas con `and`/`or` anidados, cálculos), cada parte va a una constante con nombre que diga qué significa.
  - Las firmas públicas usan **tipos con nombre**, no objetos anónimos en línea.
  - El formato lo imponen Prettier y ESLint; no se discute a mano.
- **Archivos de puertos** (`repositories/`, `gateways/`): contienen la `interface` y los tipos de **su** contrato (parámetros y resultados). Los conceptos de dominio que usan viven en `value-objects/` o `entities/`. Sin reexportaciones (`export type { X } from …`).
- **Adaptadores**: solo traducen entre el dominio y la tecnología. Nada de reglas de negocio ni validación de entrada dentro de un repositorio o gateway.
- **Repositorios vs. casos de uso**:
  - Un método de repositorio es **una sentencia atómica** con un nombre que dice qué hace (`insertIfKeyIsNew`, `changeStatus`, `credit`). No abre transacciones ni combina varias tablas para cumplir una regla de negocio.
  - Cuando un caso de uso necesita varios pasos atómicos, los escribe en orden dentro de `unitOfWork.run(async (repositories) => { … })`.
  - Las garantías de concurrencia sí van en SQL (`ON CONFLICT`, `WHERE status IN`, `balance + x`, `SKIP LOCKED`), pero los valores que deciden (qué estados, qué monto) los pasa el caso de uso.
  - Nunca se llama a un sistema externo dentro de `run`.
- **Casos de uso**: una clase por caso, constructor con objeto de dependencias tipado `{ userRepository, ... }` (campos `private readonly`), único método público `async execute(input): Promise<Dto>`. Devuelven DTOs, nunca entidades.
- **Entidades**: constructor `private`; `static create(...)` valida invariantes y lanza `ValidationError` con `details: FieldError[]`; `static restore(...)` rehidrata desde persistencia sin validar. Propiedades `readonly`.
- **Errores**: lanzar subclases de `AppError` (en `shared/domain/errors`). Llevan un `code`, **no** un código HTTP: el `errorHandler` traduce `code` → HTTP con `shared/infrastructure/http/errorStatusMap.ts`. No construir respuestas de error a mano en los controllers.
- **Constantes y "enums"**: ningún literal de negocio repetido (estados, monedas, resultados, prefijos, tamaños de lote, códigos HTTP, tiempos). Se define una vez como constante con nombre, **junto al concepto que describe** (no en un `constants.ts` global), y se importa. Para conjuntos cerrados se usa un objeto `as const` más un tipo derivado, no `enum` de TypeScript:
  ```ts
  export const Currency = { PEN: 'PEN' } as const;
  export type Currency = (typeof Currency)[keyof typeof Currency];
  ```
  Las listas derivadas (p. ej. los estados liquidables) se calculan desde su fuente, y el SQL y los `CHECK` del esquema se construyen a partir de las constantes.
- **Controllers**: delgados. Solo extraen datos del `req`, llaman al caso de uso y responden. Métodos como arrow functions de instancia (para poder pasarlos al router sin `bind`).
- **Formato de respuesta**:
  - Éxito: `{ "data": ... }`
  - Error: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }`
- **Rutas**: todos los módulos se montan bajo `/api/v1/<basePath>`. `/health` queda fuera del prefijo.
- **IDs**: `crypto.randomUUID()` inyectado como `idGenerator` para poder fijarlo en tests.
- **Config**: no leer `process.env` fuera de `src/config/env.ts`.

### Testing

- Casos de uso: tests unitarios instanciando el caso de uso con un repositorio en memoria o un fake.
- HTTP: `createApp([create<Module>Module({ <dep>: fake })])` + supertest. No levantar el servidor real (`main.ts`).
- Cada test crea su propia instancia de app/repositorio (sin estado compartido entre tests).

## Cómo añadir un módulo nuevo

Usar la skill **`/new-module`** (`.claude/skills/new-module/SKILL.md`) o seguir estos pasos:

1. Crear `src/modules/<module>/` con las carpetas `domain/`, `application/`, `infrastructure/`.
2. Definir en `domain/` las entidades (`entities/`), los value objects y "enums" (`value-objects/`), los puertos de persistencia (`repositories/`) y, si hay sistemas externos, sus puertos (`gateways/`).
3. Implementar casos de uso en `application/use-cases/` + tipos/DTO en `application/dtos/`.
4. Implementar adaptadores en `infrastructure/persistence/` e `infrastructure/http/` (controller + router).
5. Cablear todo en `src/modules/<module>/index.ts` exportando `create<Module>Module(overrides): HttpModule` y su tipo `<Module>ModuleOverrides`.
6. Registrar el módulo en la lista que `src/main.ts` pasa a `createApp([...])`.
7. Añadir tests en `tests/modules/<module>/` y ejecutar `npm run typecheck && npm test`.

El módulo `users` es la implementación de referencia: cópialo como plantilla.
