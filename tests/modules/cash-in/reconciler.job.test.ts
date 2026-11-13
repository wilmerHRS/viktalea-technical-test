import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { pino } from 'pino';
import { startReconcilerJob } from '../../../src/modules/cash-in/infrastructure/jobs/reconciler.job.ts';

const silentLogger = pino({ level: 'silent' });
const EMPTY_SUMMARY = { reserved: 0, completed: 0, failed: 0, stillPending: 0, errors: 0 };

it('ejecuta un ciclo al arrancar, repite en cada intervalo y se detiene', async () => {
  let cycles = 0;
  const job = startReconcilerJob({
    reconcileOperations: {
      execute: async () => {
        cycles++;
        return EMPTY_SUMMARY;
      },
    },
    intervalMs: 50,
    logger: silentLogger,
  });

  await sleep(10);
  assert.equal(cycles, 1, 'debe ejecutarse al arrancar (reinicio, R8.2)');
  await sleep(120);
  job.stop();
  const cyclesWhenStopped = cycles;
  assert.ok(cyclesWhenStopped >= 2);
  await sleep(120);
  assert.equal(cycles, cyclesWhenStopped, 'no debe ejecutarse tras stop()');
});

it('nunca solapa dos ciclos y sobrevive a un ciclo que falla', async () => {
  let running = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const job = startReconcilerJob({
    reconcileOperations: {
      execute: async () => {
        calls++;
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await sleep(80);
        running--;
        if (calls === 1) {
          throw new Error('BD caída');
        }
        return EMPTY_SUMMARY;
      },
    },
    intervalMs: 20,
    logger: silentLogger,
  });

  await sleep(250);
  job.stop();
  assert.equal(maxConcurrent, 1);
  assert.ok(calls >= 2, 'tras un fallo debe seguir ejecutando ciclos');
});
