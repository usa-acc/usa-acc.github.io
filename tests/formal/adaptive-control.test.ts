import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getShortestPaths } from '@xstate/graph';
import fc from 'fast-check';
import { createActor } from 'xstate';

import {
  actions,
  acceptOptoSyncEnvelope,
  finitePomdp,
  makeLifecycleMachine,
  states,
  transitionTelemetry,
  verifyPomdpCompleteness,
  type AuthnOutcome,
} from '../../src/lib/adaptiveControl.ts';

const completeContext = {
  modelComplete: true,
  proofEvidenceComplete: true,
  authn: 'authenticated' as const,
  productAuthorization: 'allow' as const,
};

test('finite POMDP is complete and normalized', () => {
  assert.deepEqual(verifyPomdpCompleteness(), {
    complete: true,
    checkedStateActionPairs: states.length * actions.length,
    errors: [],
  });
});

test('XState graph reaches every declared lifecycle state', () => {
  const paths = getShortestPaths(makeLifecycleMachine(completeContext));
  const reached = new Set(paths.map((path) => String(path.state.value)));
  assert.deepEqual(
    reached,
    new Set(['draft', 'validated', 'authorized', 'shadow', 'canary', 'active', 'suspended', 'retired']),
  );
});

test('XState refuses degraded authentication even when product authorization says allow', () => {
  const actor = createActor(
    makeLifecycleMachine({ ...completeContext, authn: 'degraded' }),
  ).start();
  actor.send({ type: 'validate' });
  actor.send({ type: 'authorize' });
  assert.equal(actor.getSnapshot().value, 'validated');
});

test('fast-check proves every generated finite distribution is normalized', () => {
  const rows = [...finitePomdp.transitions, ...finitePomdp.observationModel];
  fc.assert(
    fc.property(fc.integer({ min: 0, max: rows.length - 1 }), (index) => {
      const total = Object.values(rows[index].probabilitiesPpm).reduce((sum, value) => sum + value, 0);
      assert.equal(total, 1_000_000);
    }),
  );
});

test('fast-check proves non-authenticated identity outcomes never authorize', () => {
  const nonAuthenticated: AuthnOutcome[] = ['anonymous', 'unauthenticated', 'degraded'];
  fc.assert(
    fc.property(fc.constantFrom(...nonAuthenticated), (authn) => {
      const actor = createActor(makeLifecycleMachine({ ...completeContext, authn })).start();
      actor.send({ type: 'validate' });
      actor.send({ type: 'authorize' });
      assert.equal(actor.getSnapshot().value, 'validated');
    }),
  );
});

test('ecosystem adapters reject divergent sync and emit only bounded telemetry', () => {
  assert.equal(
    acceptOptoSyncEnvelope({ protocol: 'fm.adapter.stream.v1', modelRevision: finitePomdp.modelId }),
    true,
  );
  assert.equal(
    acceptOptoSyncEnvelope({ protocol: 'fm.adapter.stream.v1', modelRevision: 'divergent' }),
    false,
  );
  assert.deepEqual(Object.keys(transitionTelemetry({ from: 'canary', event: 'activate', to: 'active', allowed: true })).sort(), [
    'allowed',
    'event',
    'event_name',
    'from',
    'schema',
    'to',
  ]);
});
