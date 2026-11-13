/** Fragmento OpenAPI 3.1 que aporta cada módulo: sus rutas, esquemas y etiquetas. */
export interface OpenApiDocumentation {
  tags?: OpenApiTag[];
  /** Objeto `paths` de OpenAPI: ruta → método → operación. */
  paths: Record<string, Record<string, unknown>>;
  /** Esquemas reutilizables (`components.schemas`), referenciados con `#/components/schemas/…`. */
  schemas?: Record<string, unknown>;
  /** Esquemas de seguridad (`components.securitySchemes`). */
  securitySchemes?: Record<string, unknown>;
}

export interface OpenApiTag {
  name: string;
  description: string;
}
