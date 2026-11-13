import { Router } from 'express';
import type { CashInController } from './cash-in.controller.ts';
import type { PaymentWebhookController } from './payment-webhook.controller.ts';

export const CashInPath = {
  CASH_IN: '/cash-in',
  PAYMENT_WEBHOOK: '/webhooks/payment',
} as const;

interface CashInRouterControllers {
  cashIn: CashInController;
  paymentWebhook: PaymentWebhookController;
}

/** Rutas del contrato del challenge, sin prefijo de versión (R1.1). */
export const buildCashInRouter = ({ cashIn, paymentWebhook }: CashInRouterControllers): Router => {
  const router = Router();
  router.post(CashInPath.CASH_IN, cashIn.create);
  router.post(CashInPath.PAYMENT_WEBHOOK, paymentWebhook.receive);
  return router;
};
