---
name: new-module
description: Crea un módulo de negocio nuevo en src/modules/ siguiendo la Clean Architecture modular del proyecto en TypeScript (domain / application / infrastructure), lo registra en la app y le añade tests. Usar cuando se pida un nuevo recurso, feature, entidad o endpoint CRUD.
argument-hint: <nombre-del-módulo-en-plural> [campos de la entidad]
---

# Crear un módulo nuevo

Argumentos: `$ARGUMENTS` (nombre del módulo en plural, p. ej. `products`, y opcionalmente los campos de la entidad).

Antes de empezar, lee `AGENTS.md` (regla de dependencias y convenciones) y usa `src/modules/users/` como plantilla de referencia.

Recordatorios de TypeScript:
- Los imports relativos llevan la extensión real `.ts` (`from './Product.ts'`); `tsc` los reescribe a `.js` en el build.
- Los imports que solo son tipos usan `import type` o `type` inline (está activo `verbatimModuleSyntax`).
- Nada de `any`; los datos de entrada sin validar son `unknown`.

## Pasos

Sea `<module>` el nombre en plural (`products`) y `<Entity>` el singular en PascalCase (`Product`).

1. **Dominio**: `src/modules/<module>/domain/`
   - `entities/<Entity>.ts`: interface `<Entity>Props`; clase con propiedades `readonly`, constructor `private`, `static create(props)` que valida invariantes y lanza `ValidationError` (de `shared/domain/errors`) con `FieldError[]`, y `static restore(props)` para rehidratar desde persistencia.
   - `repositories/<Entity>Repository.ts`: `export interface <Entity>Repository { ... }` con métodos que devuelven `Promise<...>`.
   - Sin imports de `express`, `infrastructure/` ni `application/`.

2. **Aplicación**: `src/modules/<module>/application/`
   - `dtos/<Entity>Dto.ts`: interfaces `<Entity>Dto` y `Create<Entity>Input` (campos `unknown`), y la función `to<Entity>Dto(entity): <Entity>Dto`.
   - `use-cases/<Verb><Entity>.ts`: una clase por caso de uso (`Create<Entity>`, `Get<Entity>ById`, `List<Entity>s`, …). Recibe las dependencias tipadas por constructor (`private readonly`) y expone `async execute(input): Promise<Dto>`. Usar `NotFoundError` / `ConflictError` cuando aplique.

3. **Infraestructura**: `src/modules/<module>/infrastructure/`
   - `persistence/InMemory<Entity>Repository.ts`: `implements <Entity>Repository`, usa un `readonly #items = new Map<string, <Entity>>()`.
   - `http/<Entity>Controller.ts`: métodos arrow tipados con `Request`/`Response` de express (`list`, `getById`, `create`, …) que responden `{ data }`. Sin `try/catch`, porque Express 5 propaga los errores async.
   - `http/<entity>Routes.ts`: `build<Entity>Router(controller): Router`.

4. **Composition root**: `src/modules/<module>/index.ts`
   - Exportar `interface <Module>ModuleOverrides { <entity>Repository?: <Entity>Repository }`.
   - Exportar `create<Module>Module({ <entity>Repository = new InMemory<Entity>Repository() }: <Module>ModuleOverrides = {}): HttpModule`, que devuelva `{ basePath: '/<module>', router }`.

5. **Registro**: `src/main.ts`
   - Importar `create<Module>Module` y añadirlo a la lista que se pasa a `createApp([...])`.

6. **Tests**: `tests/modules/<module>/<module>.test.ts`
   - Unitarios de los casos de uso, con el repositorio en memoria e `idGenerator` fijo.
   - Integración HTTP con `createApp([create<Module>Module({ <entity>Repository: new InMemory<Entity>Repository() })])` + supertest: caso feliz, 400 de validación y 404.

7. **Verificación**
   - `npm run typecheck && npm test` deben pasar.
   - Comprobar con grep que `domain/` y `application/` del nuevo módulo no importan `express` ni `infrastructure/`.

## Checklist final

- [ ] Las dependencias apuntan hacia adentro (infrastructure → application → domain).
- [ ] El módulo no importa archivos internos de otros módulos.
- [ ] Los casos de uso devuelven DTOs, no entidades.
- [ ] Los errores son subclases de `AppError`.
- [ ] Sin `any`; los retornos públicos están tipados.
- [ ] El módulo está registrado en `src/main.ts` y responde en `/api/v1/<module>`.
- [ ] `npm run typecheck` y `npm test` en verde.
