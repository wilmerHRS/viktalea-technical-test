import { eq, sql } from 'drizzle-orm';
import { NotFoundError } from '../../../../shared/domain/errors/index.ts';
import type { DbExecutor } from '../../../../shared/infrastructure/db/client.ts';
import { NOW } from '../../../../shared/infrastructure/db/sqlTime.ts';
import type { WalletRepository } from '../../domain/repositories/WalletRepository.ts';
import { wallets } from './schema.ts';

export class DrizzleWalletRepository implements WalletRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async ensureExists(userId: string): Promise<void> {
    await this.db.insert(wallets).values({ userId }).onConflictDoNothing();
  }

  async credit(userId: string, amountCents: number): Promise<number> {
    // La suma la hace la base de datos, nunca "leer, sumar en JS y escribir": los abonos
    // concurrentes a la misma wallet se serializan con el lock de la fila y ninguno se pierde
    // (R6.3).
    const incrementedBalance = sql`${wallets.balanceCents} + ${amountCents}`;
    const [wallet] = await this.db
      .update(wallets)
      .set({ balanceCents: incrementedBalance, updatedAt: NOW })
      .where(eq(wallets.userId, userId))
      .returning({ balanceCents: wallets.balanceCents });
    if (!wallet) {
      throw new NotFoundError(`Wallet of user ${userId} not found`);
    }
    return wallet.balanceCents;
  }
}
