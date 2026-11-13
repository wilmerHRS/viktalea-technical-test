import type { LedgerRepository } from '../../domain/repositories/LedgerRepository.ts';
import type { OperationRepository } from '../../domain/repositories/OperationRepository.ts';
import type { WalletRepository } from '../../domain/repositories/WalletRepository.ts';
import type { WebhookEventRepository } from '../../domain/repositories/WebhookEventRepository.ts';

/** Los repositorios que un caso de uso puede usar dentro de una unidad de trabajo. */
export interface CashInRepositories {
  operations: OperationRepository;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  webhookEvents: WebhookEventRepository;
}

/**
 * Ejecuta `work` en UNA transacción de base de datos: todo lo que se haga con los repositorios
 * recibidos se confirma junto, o se revierte junto si `work` lanza un error.
 *
 * Así un caso de uso puede escribir varios pasos (finalizar la operación, acreditar la wallet,
 * escribir el ledger) en orden y de forma atómica, sin saber nada de SQL.
 *
 * Nunca llames a la pasarela de pagos dentro de `work`: mantendría locks durante una llamada
 * externa.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: CashInRepositories) => Promise<T>): Promise<T>;
}
