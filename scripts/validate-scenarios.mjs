// Validación EN VIVO de los escenarios del challenge contra servidores reales (npm run validate:live).
//
// Levanta varios "pods" (procesos de Node independientes sobre la misma base de datos), ejecuta
// cada escenario del documento y comprueba el resultado directamente en PostgreSQL.
// Requisitos: `npm run db:up && npm run db:migrate` (usa la base de desarrollo de `.env`).
//
// Nota: la pasarela simulada vive en memoria de cada proceso, mientras que en la realidad es
// compartida. Por eso solo el pod A ejecuta el reconciliador de forma periódica.
import { spawn, execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

process.loadEnvFile('.env');

const POD_A = 3101; // reconciliador activo cada segundo
const POD_B = 3102; // reconciliador solo al arrancar
const POD_CRASH = 3103; // se mata a mitad de un cobro
const ONE_HOUR_MS = '3600000';
const STALE_AFTER_MS = 3000;
const POLL_INTERVAL_MS = 300;
const WAIT_TIMEOUT_MS = 20_000;

const db = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
// Igual que en la app: el escenario de "BD caída" corta las conexiones inactivas; sin este
// manejador, el propio script moriría con "Unhandled 'error' event".
db.on('error', () => undefined);

const ensureDatabaseUp = () =>
  execFileSync('docker', ['compose', 'up', '-d', '--wait', 'postgres'], { stdio: 'ignore' });

// ---------- pods ----------

const pods = new Map();

const startPod = async (port, { reconcileIntervalMs }) => {
  const child = spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: 'error',
      RECONCILE_INTERVAL_MS: reconcileIntervalMs,
      RECONCILE_AFTER_MS: String(STALE_AFTER_MS),
    },
    stdio: 'ignore',
  });
  pods.set(port, child);
  await waitUntil(async () => (await fetch(`http://localhost:${port}/health`)).ok, `pod ${port}`);
  return child;
};

const killPod = (port) => {
  pods.get(port)?.kill('SIGKILL');
  pods.delete(port);
};

// ---------- helpers HTTP y BD ----------

const cashIn = async (port, key, body) => {
  const response = await fetch(`http://localhost:${port}/cash-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
};

const webhook = async (port, payload, secret = process.env.WEBHOOK_SECRET) => {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  const response = await fetch(`http://localhost:${port}/webhooks/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
};

const newUser = () => `usr_live_${randomUUID().slice(0, 8)}`;
const body = (userId, paymentMethod = 'card_xyz', amount = 100) => ({
  user_id: userId,
  amount,
  currency: 'PEN',
  payment_method: paymentMethod,
});

const scalar = async (query, params) => (await db.query(query, params)).rows[0];
const ledgerCount = async (userId) =>
  Number((await scalar('SELECT count(*) AS n FROM ledger_entries WHERE user_id = $1', [userId])).n);
const operationCount = async (userId) =>
  Number((await scalar('SELECT count(*) AS n FROM operations WHERE user_id = $1', [userId])).n);
const balanceCents = async (userId) =>
  Number((await scalar('SELECT balance_cents FROM wallets WHERE user_id = $1', [userId]))?.balance_cents ?? 0);
const operationByKey = async (key) =>
  scalar('SELECT id, status FROM operations WHERE idempotency_key = $1', [key]);

async function waitUntil(condition, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // todavía no está listo
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Tiempo agotado esperando: ${label}`);
}

const expect = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

// ---------- escenarios del documento ----------

const scenarios = [
  [
    'Doble click del usuario',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const [a, b] = await Promise.all([cashIn(POD_A, key, body(userId)), cashIn(POD_A, key, body(userId))]);
      expect(a.body.operation_id === b.body.operation_id, 'dos operation_id distintos');
      expect(await operationCount(userId) === 1, 'más de una operación');
      expect(await ledgerCount(userId) === 1, 'se acreditó más de una vez');
      return `2 clicks → 1 operación, 1 abono (HTTP ${a.status}/${b.status})`;
    },
  ],
  [
    'Retry automático de la app',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const responses = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        responses.push(await cashIn(POD_A, key, body(userId)));
      }
      const bodies = new Set(responses.map((response) => JSON.stringify(response.body)));
      expect(bodies.size === 1, 'los reintentos devolvieron respuestas distintas');
      expect(await ledgerCount(userId) === 1, 'se acreditó más de una vez');
      return `3 intentos → misma respuesta (new_balance=${responses[0].body.new_balance}), 1 abono`;
    },
  ],
  [
    'Múltiples pods concurrentes',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) => cashIn(index % 2 ? POD_B : POD_A, key, body(userId))),
      );
      const ids = new Set(responses.map((response) => response.body.operation_id));
      expect(ids.size === 1, 'los pods crearon operaciones distintas');
      expect(await operationCount(userId) === 1, 'más de una operación');
      expect(await ledgerCount(userId) === 1, 'se acreditó más de una vez');
      const statuses = responses.map((response) => response.status).join(',');
      return `10 requests en 2 pods → 1 operación, 1 abono (HTTP ${statuses})`;
    },
  ],
  [
    'Timeout del proveedor (pregunta central)',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const request = body(userId, 'card_timeout_after_charge', 100);
      const first = await cashIn(POD_A, key, request);
      expect(first.status === 202, `esperaba 202 y llegó ${first.status}`);
      expect(first.headers.get('retry-after') === '2', 'falta Retry-After');
      const retry = await cashIn(POD_A, key, request);
      expect([200, 202].includes(retry.status), `reintento inesperado ${retry.status}`);
      let final;
      await waitUntil(async () => {
        final = await cashIn(POD_A, key, request);
        return final.status === 200;
      }, 'que el reconciliador resuelva la operación');
      expect(await ledgerCount(userId) === 1, 'se acreditó más de una vez');
      return `202 pending → reintento sin recobrar → reconciliador → 200 (new_balance=${final.body.new_balance})`;
    },
  ],
  [
    'Webhook duplicado',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const pending = await cashIn(POD_A, key, body(userId, 'card_timeout'));
      const payload = {
        event_id: `evt_${randomUUID()}`,
        operation_id: pending.body.operation_id,
        status: 'approved',
        provider_charge_id: 'ch_live',
      };
      const [first, second] = await Promise.all([webhook(POD_A, payload), webhook(POD_B, payload)]);
      const duplicates = [first, second].filter((response) => response.body.duplicate).length;
      expect(duplicates === 1, 'esperaba exactamente un duplicado');
      expect(await ledgerCount(userId) === 1, 'se acreditó más de una vez');
      return 'mismo evento a 2 pods a la vez → 1 aplicado + 1 duplicate, 1 abono';
    },
  ],
  [
    'Webhook fuera de orden',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const completed = await cashIn(POD_A, key, body(userId));
      const late = await webhook(POD_A, {
        event_id: `evt_${randomUUID()}`,
        operation_id: completed.body.operation_id,
        status: 'declined',
      });
      expect(late.body.result === 'conflict', `esperaba conflict y llegó ${JSON.stringify(late.body)}`);
      expect((await operationByKey(key)).status === 'COMPLETED', 'el estado final cambió');
      expect(await balanceCents(userId) === 10000, 'el saldo cambió');
      return 'declined tras COMPLETED → conflict, estado y saldo intactos';
    },
  ],
  [
    'Webhook antes que la respuesta del API',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      const slowRequest = cashIn(POD_A, key, body(userId, 'card_slow'));
      let operation;
      await waitUntil(async () => (operation = await operationByKey(key)), 'que exista la operación');
      const early = await webhook(POD_B, {
        event_id: `evt_${randomUUID()}`,
        operation_id: operation.id,
        status: 'approved',
        provider_charge_id: 'ch_early',
      });
      const response = await slowRequest;
      expect(early.body.result === 'applied', 'el webhook no se aplicó');
      expect(response.status === 200, `la API respondió ${response.status}`);
      expect(await ledgerCount(userId) === 1, 'se acreditó más de una vez');
      return 'webhook liquida mientras la API espera a la pasarela → API 200, 1 abono';
    },
  ],
  [
    'Fallo temporal de DB',
    async () => {
      const userId = newUser();
      execFileSync('docker', ['compose', 'stop', 'postgres'], { stdio: 'ignore' });
      let duringOutage;
      try {
        duringOutage = await cashIn(POD_A, randomUUID(), body(userId));
      } finally {
        ensureDatabaseUp();
      }
      expect(duringOutage.status === 503, `esperaba 503 y llegó ${duringOutage.status}`);
      for (const port of [POD_A, POD_B]) {
        expect((await fetch(`http://localhost:${port}/health`)).ok, `el pod ${port} se cayó`);
      }
      let afterOutage;
      await waitUntil(async () => {
        afterOutage = await cashIn(POD_A, randomUUID(), body(userId));
        return afterOutage.status === 200;
      }, 'que la API vuelva a funcionar');
      return `BD caída → 503 ${duringOutage.body.error.code}; pods vivos; al volver → 200`;
    },
  ],
  [
    'Reinicio del servicio durante la operación',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      await startPod(POD_CRASH, { reconcileIntervalMs: ONE_HOUR_MS });
      cashIn(POD_CRASH, key, body(userId, 'card_slow')).catch(() => undefined);
      await waitUntil(async () => await operationByKey(key), 'que exista la operación');
      killPod(POD_CRASH); // el pod muere mientras espera a la pasarela
      expect((await operationByKey(key)).status === 'PROCESSING', 'debía quedar en PROCESSING');
      await waitUntil(
        async () => (await operationByKey(key)).status === 'FAILED',
        'que el reconciliador resuelva la operación atascada',
      );
      const retry = await cashIn(POD_A, key, body(userId, 'card_slow'));
      expect(retry.status === 402, `el reintento respondió ${retry.status}`);
      expect(await ledgerCount(userId) === 0, 'no debía acreditarse');
      return 'pod muerto a mitad del cobro → PROCESSING → reconciliador → FAILED (no se cobró), sin abono';
    },
  ],
  [
    'Race condition sobre el saldo',
    async () => {
      const userId = newUser();
      const amounts = Array.from({ length: 20 }, (_, index) => index + 1);
      await Promise.all(
        amounts.map((amount, index) =>
          cashIn(index % 2 ? POD_B : POD_A, randomUUID(), body(userId, 'card_xyz', amount)),
        ),
      );
      const expectedCents = amounts.reduce((sum, amount) => sum + amount, 0) * 100;
      expect(await balanceCents(userId) === expectedCents, 'el saldo no cuadra');
      expect(await ledgerCount(userId) === 20, 'faltan movimientos');
      return `20 recargas distintas en paralelo en 2 pods → saldo exacto ${expectedCents / 100}`;
    },
  ],
  [
    'Validaciones del contrato',
    async () => {
      const userId = newUser();
      const key = randomUUID();
      await cashIn(POD_A, key, body(userId));
      const reused = await cashIn(POD_A, key, body(userId, 'card_xyz', 50));
      const invalidKey = await cashIn(POD_A, 'not-a-uuid', body(userId));
      const badSignature = await webhook(POD_A, { event_id: 'x', operation_id: 'y', status: 'declined' }, 'wrong');
      expect(reused.status === 422, 'misma key con otro payload debía dar 422');
      expect(invalidKey.status === 400, 'key inválida debía dar 400');
      expect(badSignature.status === 401, 'firma inválida debía dar 401');
      return 'key reutilizada → 422 · key inválida → 400 · firma inválida → 401';
    },
  ],
];

// ---------- ejecución ----------

const results = [];
try {
  ensureDatabaseUp();
  await startPod(POD_A, { reconcileIntervalMs: '1000' });
  await startPod(POD_B, { reconcileIntervalMs: ONE_HOUR_MS });
  for (const [name, run] of scenarios) {
    try {
      results.push({ name, ok: true, detail: await run() });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
    }
    console.log(`${results.at(-1).ok ? '✔' : '✖'} ${name}: ${results.at(-1).detail}`);
  }
} finally {
  for (const port of [...pods.keys()]) {
    killPod(port);
  }
  ensureDatabaseUp(); // nunca dejar la base detenida, aunque un escenario falle
  await db.end();
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} escenarios correctos`);
process.exitCode = failed > 0 ? 1 : 0;
