import { createMachine } from 'xstate';

export const PROBABILITY_SCALE = 1_000_000;
export const states = ['intake', 'screening', 'admitted', 'resolved'] as const;
export const actions = ['hold', 'advance', 'close'] as const;
export const observations = ['insufficient', 'ready', 'final'] as const;
export type ModelState = (typeof states)[number];
export type ModelAction = (typeof actions)[number];

type Distribution = Partial<Record<ModelState, number>>;
type ObservationDistribution = Partial<Record<(typeof observations)[number], number>>;
type PairRow<T> = { state: ModelState; action: ModelAction; probabilitiesPpm: T };

const transitionByState: Record<ModelState, Record<ModelAction, Distribution>> = {
  intake: {
    hold: { intake: PROBABILITY_SCALE },
    advance: { intake: 200_000, screening: 800_000 },
    close: { resolved: PROBABILITY_SCALE },
  },
  screening: {
    hold: { intake: 300_000, screening: 700_000 },
    advance: { screening: 150_000, admitted: 850_000 },
    close: { resolved: PROBABILITY_SCALE },
  },
  admitted: {
    hold: { admitted: PROBABILITY_SCALE },
    advance: { resolved: PROBABILITY_SCALE },
    close: { resolved: PROBABILITY_SCALE },
  },
  resolved: {
    hold: { resolved: PROBABILITY_SCALE },
    advance: { resolved: PROBABILITY_SCALE },
    close: { resolved: PROBABILITY_SCALE },
  },
};

const observationByState: Record<ModelState, ObservationDistribution> = {
  intake: { insufficient: 800_000, ready: 200_000 },
  screening: { insufficient: 250_000, ready: 700_000, final: 50_000 },
  admitted: { insufficient: 50_000, ready: 850_000, final: 100_000 },
  resolved: { final: PROBABILITY_SCALE },
};

const rewardByState: Record<ModelState, Record<ModelAction, number>> = {
  intake: { hold: -1, advance: 2, close: -8 },
  screening: { hold: -2, advance: 4, close: -6 },
  admitted: { hold: -3, advance: 5, close: -2 },
  resolved: { hold: 0, advance: 0, close: 0 },
};

export const finitePomdp = {
  modelId: 'usacc.case-flow.pomdp.v1',
  states,
  actions,
  observations,
  terminalStates: ['resolved'] as const,
  initialBeliefPpm: { intake: PROBABILITY_SCALE, screening: 0, admitted: 0, resolved: 0 },
  transitions: states.flatMap((state) =>
    actions.map((action) => ({ state, action, probabilitiesPpm: transitionByState[state][action] })),
  ) satisfies PairRow<Distribution>[],
  observationModel: states.flatMap((state) =>
    actions.map((action) => ({ state, action, probabilitiesPpm: observationByState[state] })),
  ) satisfies PairRow<ObservationDistribution>[],
  rewards: states.flatMap((state) =>
    actions.map((action) => ({ state, action, value: rewardByState[state][action] })),
  ),
};

export type CompletenessReport = {
  complete: boolean;
  checkedStateActionPairs: number;
  errors: string[];
};

const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0);

export function verifyPomdpCompleteness(): CompletenessReport {
  const errors: string[] = [];
  const expected = new Set(states.flatMap((state) => actions.map((action) => `${state}/${action}`)));
  const verifyRows = (name: string, rows: PairRow<Record<string, number>>[], outcomes: Set<string>) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const pair = `${row.state}/${row.action}`;
      if (seen.has(pair) || !expected.has(pair)) errors.push(`invalid or duplicate ${name} ${pair}`);
      seen.add(pair);
      const entries = Object.entries(row.probabilitiesPpm);
      if (
        entries.length === 0 ||
        entries.some(([outcome, probability]) => !outcomes.has(outcome) || probability < 0) ||
        sum(entries.map(([, probability]) => probability)) !== PROBABILITY_SCALE
      ) {
        errors.push(`non-normalized ${name} ${pair}`);
      }
    }
    if (seen.size !== expected.size || [...expected].some((pair) => !seen.has(pair))) {
      errors.push(`${name} relation is not total`);
    }
  };
  verifyRows('transition', finitePomdp.transitions, new Set(states));
  verifyRows('observation', finitePomdp.observationModel, new Set(observations));
  if (
    finitePomdp.rewards.length !== expected.size ||
    finitePomdp.rewards.some(({ value }) => !Number.isFinite(value))
  ) {
    errors.push('reward function is not total and finite');
  }
  if (sum(Object.values(finitePomdp.initialBeliefPpm)) !== PROBABILITY_SCALE) {
    errors.push('initial belief is not normalized');
  }
  for (const action of actions) {
    const row = transitionByState.resolved[action];
    if (Object.keys(row).length !== 1 || row.resolved !== PROBABILITY_SCALE) {
      errors.push(`resolved/${action} is not absorbing`);
    }
  }
  return { complete: errors.length === 0, checkedStateActionPairs: expected.size, errors };
}

export type AuthnOutcome = 'anonymous' | 'unauthenticated' | 'degraded' | 'authenticated';
export type AuthorizationContext = {
  modelComplete: boolean;
  proofEvidenceComplete: boolean;
  authn: AuthnOutcome;
  productAuthorization: 'deny' | 'allow';
};

export const makeLifecycleMachine = (context: AuthorizationContext) =>
  createMachine({
    id: 'usacc-adaptive-control',
    initial: 'draft',
    context,
    states: {
      draft: { on: { validate: { target: 'validated', guard: ({ context }) => context.modelComplete }, retire: 'retired' } },
      validated: {
        on: {
          authorize: {
            target: 'authorized',
            guard: ({ context }) =>
              context.modelComplete &&
              context.authn === 'authenticated' &&
              context.productAuthorization === 'allow',
          },
          retire: 'retired',
        },
      },
      authorized: { on: { start_shadow: 'shadow', retire: 'retired' } },
      shadow: {
        on: {
          promote_canary: { target: 'canary', guard: ({ context }) => context.proofEvidenceComplete },
          retire: 'retired',
        },
      },
      canary: {
        on: {
          activate: {
            target: 'active',
            guard: ({ context }) => context.modelComplete && context.proofEvidenceComplete,
          },
          retire: 'retired',
        },
      },
      active: { on: { suspend: 'suspended', retire: 'retired' } },
      suspended: {
        on: {
          remediate: { target: 'canary', guard: ({ context }) => context.proofEvidenceComplete },
          retire: 'retired',
        },
      },
      retired: { type: 'final' },
    },
  });

export function acceptOptoSyncEnvelope(envelope: { protocol: string; modelRevision: string }): boolean {
  return envelope.protocol === 'fm.adapter.stream.v1' && envelope.modelRevision === finitePomdp.modelId;
}

export function transitionTelemetry(input: {
  from: string;
  event: string;
  to: string;
  allowed: boolean;
}): Record<string, string | boolean> {
  return {
    schema: 'next-loggers/v1',
    event_name: 'usacc.adaptive_control.transition',
    from: input.from,
    event: input.event,
    to: input.to,
    allowed: input.allowed,
  };
}
