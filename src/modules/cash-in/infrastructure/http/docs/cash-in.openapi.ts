import { ErrorCode } from '../../../../../shared/domain/errors/app.errors.ts';
import { HttpErrorCode } from '../../../../../shared/infrastructure/http/constants/error-status.constants.ts';
import type { OpenApiDocumentation } from '../../../../../shared/infrastructure/http/interfaces/openapi-documentation.interface.ts';
import { toOpenApiSchema } from '../../../../../shared/infrastructure/http/utils/openapi-schema.util.ts';
import { FakePaymentMethod } from '../../providers/fake-payment.provider.ts';
import { PENDING_RETRY_AFTER_SECONDS } from '../response/cash-in-response.presenter.ts';
import { cashInBodySchema } from '../request/cash-in-request.validator.ts';
import { paymentWebhookBodySchema } from '../request/payment-webhook-request.validator.ts';
import { CashInPath } from '../routes/cash-in.routes.ts';

const TAG_CASH_IN = 'Cash-In';
const TAG_WEBHOOKS = 'Webhooks';
const SIGNATURE_SCHEME = 'WebhookSignature';

const ref = (schemaName: string) => ({ $ref: `#/components/schemas/${schemaName}` });
const jsonContent = (schemaName: string, example: unknown) => ({
  'application/json': { schema: ref(schemaName), example },
});
const errorResponse = (description: string, code: string, message: string) => ({
  description,
  content: jsonContent('Error', { error: { code, message } }),
});

const OPERATION_ID_EXAMPLE = 'op_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

const retryAfterHeader = (seconds: number) => ({
  description: `Segundos recomendados antes de reintentar con la MISMA Idempotency-Key (${seconds}).`,
  schema: { type: 'integer', example: seconds },
});

const requestIdHeader = {
  name: 'X-Request-Id',
  in: 'header',
  required: false,
  description:
    'Correlation ID opcional ([A-Za-z0-9._-], hasta 128). Si falta o no es válido se genera uno; ' +
    'siempre vuelve en la respuesta y aparece en los logs.',
  schema: { type: 'string' },
};

const cashInPath = {
  post: {
    tags: [TAG_CASH_IN],
    summary: 'Recargar saldo (cobra en la pasarela y acredita una sola vez)',
    description: [
      'Idempotente por `Idempotency-Key`: repetir la request (doble click, retry de la app, otro pod)',
      'NUNCA vuelve a cobrar; devuelve el estado actual de la operación.',
      '',
      'Si la pasarela no responde (timeout), la operación queda **pending** y NO se reintenta el',
      'cobro: la resuelve el webhook de la pasarela o el reconciliador.',
      '',
      '**Pasarela simulada** — el resultado depende de `payment_method`:',
      `\`${FakePaymentMethod.DECLINED}\` rechaza · \`${FakePaymentMethod.TIMEOUT}\` no cobra y no`,
      `responde · \`${FakePaymentMethod.TIMEOUT_AFTER_CHARGE}\` cobra pero la respuesta se pierde ·`,
      `\`${FakePaymentMethod.SLOW}\` aprueba tras unos segundos · \`${FakePaymentMethod.UNAVAILABLE}\``,
      'error de red · cualquier otro valor aprueba.',
    ].join('\n'),
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description: 'UUID generado por el cliente. La misma key identifica la misma operación.',
        schema: { type: 'string', format: 'uuid' },
        example: '6e06706c-711f-4f34-9d55-a16796f62d56',
      },
      requestIdHeader,
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: toOpenApiSchema(cashInBodySchema),
          example: {
            user_id: 'usr_abc123',
            amount: 100.0,
            currency: 'PEN',
            payment_method: 'card_xyz',
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Cobro aprobado y saldo acreditado (también en un replay de la misma key).',
        content: jsonContent('CashInCompleted', {
          operation_id: OPERATION_ID_EXAMPLE,
          status: 'completed',
          amount: 100.0,
          new_balance: 350.0,
        }),
      },
      202: {
        description:
          'Resultado aún desconocido (timeout de la pasarela) o en curso en otro pod. ' +
          'Reintentar con la misma key.',
        headers: { 'Retry-After': retryAfterHeader(PENDING_RETRY_AFTER_SECONDS) },
        content: jsonContent('CashInPending', {
          operation_id: OPERATION_ID_EXAMPLE,
          status: 'pending',
          amount: 100.0,
        }),
      },
      400: errorResponse(
        'Idempotency-Key ausente o inválida, o body inválido.',
        ErrorCode.VALIDATION_ERROR,
        'Invalid cash-in request',
      ),
      402: {
        description: 'La pasarela rechazó el cobro. El saldo no cambia.',
        content: jsonContent('CashInFailed', {
          operation_id: OPERATION_ID_EXAMPLE,
          status: 'failed',
          amount: 100.0,
          failure_reason: 'Payment declined',
        }),
      },
      422: errorResponse(
        'La Idempotency-Key ya se usó con un payload distinto.',
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Idempotency-Key was already used with a different payload',
      ),
      503: {
        ...errorResponse(
          'Base de datos no disponible. Reintentar con la misma key es seguro.',
          HttpErrorCode.SERVICE_UNAVAILABLE,
          'Service temporarily unavailable, retry with the same key',
        ),
        headers: { 'Retry-After': retryAfterHeader(5) },
      },
    },
  },
};

const paymentWebhookPath = {
  post: {
    tags: [TAG_WEBHOOKS],
    summary: 'Notificación de la pasarela con el resultado de un cobro',
    description: [
      'Firmado con HMAC-SHA256 del body crudo y `WEBHOOK_SECRET`, en el header `X-Signature` (hex).',
      'Deduplicado por `event_id` y aplicado en UNA transacción. Un evento que contradice un estado',
      'final (p. ej. `declined` tras `completed`) no cambia nada y se registra como `conflict`.',
      'Responde 200 a todo lo procesado para que la pasarela deje de reintentar.',
    ].join('\n'),
    security: [{ [SIGNATURE_SCHEME]: [] }],
    parameters: [requestIdHeader],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: toOpenApiSchema(paymentWebhookBodySchema),
          example: {
            event_id: 'evt_123',
            operation_id: OPERATION_ID_EXAMPLE,
            status: 'approved',
            provider_charge_id: 'ch_456',
            occurred_at: '2026-08-01T10:00:00Z',
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Evento procesado (aplicado, ignorado o en conflicto) o duplicado.',
        content: {
          'application/json': {
            schema: { oneOf: [ref('WebhookProcessed'), ref('WebhookDuplicate')] },
            examples: {
              applied: { value: { received: true, result: 'applied' } },
              conflict: { value: { received: true, result: 'conflict' } },
              duplicate: { value: { received: true, duplicate: true } },
            },
          },
        },
      },
      400: errorResponse(
        'Body inválido (p. ej. `approved` sin `provider_charge_id`).',
        ErrorCode.VALIDATION_ERROR,
        'Invalid payment webhook',
      ),
      401: errorResponse(
        'Firma ausente o inválida.',
        HttpErrorCode.INVALID_SIGNATURE,
        'Invalid or missing webhook signature',
      ),
      404: errorResponse(
        'La operación no existe.',
        ErrorCode.NOT_FOUND,
        'Cash-in operation op_… not found',
      ),
    },
  },
};

const schemas = {
  CashInCompleted: {
    type: 'object',
    required: ['operation_id', 'status', 'amount', 'new_balance'],
    properties: {
      operation_id: { type: 'string' },
      status: { const: 'completed' },
      amount: { type: 'number' },
      new_balance: {
        type: 'number',
        description: 'Saldo justo después de acreditar ESTA operación (igual en cada replay).',
      },
    },
  },
  CashInPending: {
    type: 'object',
    required: ['operation_id', 'status', 'amount'],
    properties: {
      operation_id: { type: 'string' },
      status: { const: 'pending' },
      amount: { type: 'number' },
    },
  },
  CashInFailed: {
    type: 'object',
    required: ['operation_id', 'status', 'amount', 'failure_reason'],
    properties: {
      operation_id: { type: 'string' },
      status: { const: 'failed' },
      amount: { type: 'number' },
      failure_reason: { type: 'string' },
    },
  },
  WebhookProcessed: {
    type: 'object',
    required: ['received', 'result'],
    properties: {
      received: { const: true },
      result: { enum: ['applied', 'ignored', 'conflict'] },
    },
  },
  WebhookDuplicate: {
    type: 'object',
    required: ['received', 'duplicate'],
    properties: { received: { const: true }, duplicate: { const: true } },
  },
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: { field: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

/** Documentación OpenAPI del módulo cash-in (se publica en /docs). */
export const cashInOpenApi: OpenApiDocumentation = {
  tags: [
    { name: TAG_CASH_IN, description: 'Recarga de saldo idempotente.' },
    { name: TAG_WEBHOOKS, description: 'Notificaciones de la pasarela de pagos.' },
  ],
  paths: {
    [CashInPath.CASH_IN]: cashInPath,
    [CashInPath.PAYMENT_WEBHOOK]: paymentWebhookPath,
  },
  schemas,
  securitySchemes: {
    [SIGNATURE_SCHEME]: {
      type: 'apiKey',
      in: 'header',
      name: 'X-Signature',
      description: 'HMAC-SHA256 (hex) del body crudo con WEBHOOK_SECRET.',
    },
  },
};
