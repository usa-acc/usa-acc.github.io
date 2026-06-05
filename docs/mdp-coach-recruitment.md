# MDP / Contextual Bandit — Coach Recruitment Intelligence

This document describes how to extend the MDP framework from
[`mdp-for-notifs-and-more.md`](./mdp-for-notifs-and-more.md) to a fifth
decisioning surface: **coach recruitment, hiring, skills-based matching,
and retention prediction.**

It builds on the existing infrastructure:
[`mdp_decisions`](../src/server/databases/neondb/tables/mdp-decisions-table.ts)
(shared decision log — add a new `surface` value),
[`mdp-decision-writer.ts`](../src/server/subroutines/mdp/mdp-decision-writer.ts)
(persistence gate), the executor-layer pattern from
[`mdp-notif-executor.ts`](../src/server/subroutines/mdp/mdp-notif-executor.ts)
(shadow / canary / live), and the embedding-based neighbor blend from
[`mdp-user-embeddings.ts`](../src/server/subroutines/mdp/mdp-user-embeddings.ts).

The public-facing explanation is at [`/mdp3`](../src/pages/mdp3.astro).

---

## 1. Scope

What this doc covers:

- The state/action/reward shape for coach recruitment screening.
- How resume + LinkedIn embeddings drive cold-start matching and
  outcome-conditioned candidate scoring.
- Skills extraction, credential verification, and embedding-based
  skills matching against role requirements.
- Pool-level capacity management (hiring/sizing) as a constrained RL
  problem.
- Onboarding decisions as a downstream MDP surface that feeds back
  into the recruitment reward.
- Supporting data: `coach_candidates`, `coach_candidate_embeddings`,
  `coach_hiring_decisions`, `coach_hiring_outcomes`,
  `coach_skill_requirements`, `coach_pool_snapshots`.
- Staged wiring into the recruiter workflow without making any
  autonomous hiring decisions.

What it does **not** cover:

- Coach assignment to cases/clients — that is the court-flow MDP
  (see [`mdp-corruption-courts.md`](./mdp-corruption-courts.md) §3.2).
- Coach compensation or payment — that is the financial operations
  pipeline.
- Coach avatar generation or marketing assets — that is the coaching
  operations vertical.

---

## 2. Cron surface

New actions on [`/api/cron/mdp`](../src/app/api/cron/mdp/route.ts),
alongside the existing notif / feed / escalation / outbound actions:

| Action | Purpose | Notable params |
| ------ | ------- | -------------- |
| `score-candidates` | score a batch of candidates against open roles | `roleId`, `candidateIds`, `limit` |
| `embed-candidates` | (re)compute embeddings for candidate profiles | `candidateIds`, `limit` |
| `score-pool-health` | compute pool-level skill coverage and capacity metrics | `snapshotId` |
| `train-recruitment` | nightly trainer over logged decisions + outcomes | — |
| `assign-icps-coaches` | (re-)compute ICP-like cluster assignments for candidates | `since`, `candidateIds` |

Status action includes the new surface so the control plane can
confirm it is live before wiring any executor.

---

## 3. MDP formulation

Two subsurfaces; one shared featurizer module
(`src/server/subroutines/mdp/mdp-recruitment-features.ts`, planned) so the
same candidate features can feed both per-candidate screening and
pool-level sizing.

### 3.1 Candidate screening (per-candidate)

#### State (`CoachCandidateState`)

Built per candidate by `buildCandidateState({ candidateId, roleId, now })`:

- **Candidate features**
  - `resumeEmbedding` — Gemini 768-dim embedding of full resume text
  - `linkedinEmbedding` — Gemini 768-dim embedding of LinkedIn profile
    (summary + experience + endorsements)
  - `resumeLinkedinCosineSimilarity` — consistency check between the
    two profiles
  - `yearsExperience` — parsed from resume
  - `credentialVector` — one-hot over verified credentials
    (certifications, degrees, licenses)
  - `skillsMatchScore` — cosine distance between candidate skills
    embedding and role requirement embedding
  - `referralSource` — `direct_application | referral | discovery |
    agency | linkedin_inbound`
  - `priorApplicationCount` — number of previous applications to this
    platform
  - `geographicAvailability` — timezone overlap with expected clients

- **Role features**
  - `roleId`, `requiredSkillVector`
  - `compensationBand` — low / mid / high
  - `urgencyLevel` — normal / elevated / critical
  - `minCredentialFloor` — hard constraint, not a feature for Q
  - `archetypeCoachingDemands` — text embedding of role description

- **Historical outcome features**
  - `nearestSuccessfulHiresCosine` — mean cosine to top-5 nearest
    candidates who retained ≥12 months
  - `nearestEarlyDeparturesCosine` — mean cosine to top-5 nearest
    candidates who left within 6 months
  - `clusterRetentionRate` — 12-month retention rate for the
    candidate's embedding neighborhood
  - `clusterMeanClientSatisfaction` — mean satisfaction score for
    the candidate's embedding neighborhood

- **Pool context features**
  - `currentPoolSize`, `activeCoachCount`
  - `skillCoverageGap` — which required skills are underrepresented
  - `recentAttritionRate30d`, `recentAttritionRate90d`
  - `pendingOnboardingCount`

#### Action set (`CoachScreeningAction`)

```
type CoachScreeningAction =
  | 'reject_below_floor'        // does not meet hard credential floor
  | 'hold_for_more_info'        // request additional materials
  | 'request_references'        // trigger reference check workflow
  | 'admit_to_interview'        // advance to human interview stage
  | 'fast_track_high_match'     // skip to final review (top 5% match)
```

`reject_below_floor` is a **hard-rail action** — it fires when the
credential floor check fails regardless of Q-values. It is not learned.

#### Reward

Composite, heavily delayed, versioned. Computed by
`scoreRecruitmentOutcome(decision, outcome)` in planned
`mdp-recruitment-reward.ts`:

```
reward =
  + 3.0  * retained_at_12_months
  + 1.5  * retained_at_6_months
  + 0.5  * completed_onboarding
  + 1.0  * client_satisfaction_above_threshold
  + 0.5  * credibility_score_growth_positive
  - 2.0  * departed_within_6_months
  - 1.0  * departed_within_3_months
  - 0.5  * client_complaints_during_probation
  - 1.5  * credential_discrepancy_post_hire
  - 0.1  * screening_cost_per_candidate       // amortised recruiter time + system cost
```

Latency handling: the trainer uses truncated returns. Decisions are
partially sealed at 6 months (with `retained_at_6_months` evaluated)
and fully sealed at 12 months. Before the 6-month mark, reward is
`null` and the decision is excluded from training. This prevents the
policy from learning on premature signals.

`retained_at_12_months` is the primary outcome. Everything else is
supporting signal. The policy should not learn to optimize for
`completed_onboarding` if it does not predict retention — that would
be the equivalent of optimizing for email opens instead of replies.

#### Policy

Linear scorer per action with shared state features, same shape as
every other surface:

```
Q(state, a) = w_a · featurize(state)
choose      = argmax_a Q(state, a)   (with ε-greedy override)
```

ε = 0.10 globally; doubled to 0.20 for roles with fewer than 20
historical hires (see cold start, §5.3). Hard-rail actions override
the policy.

### 3.2 Pool management (system-level)

A separate, lighter decision surface. One decision per monthly
pool-health review.

#### State (`CoachPoolState`)

- `currentPoolSize`, `targetPoolSize` (governance-set band)
- `skillCoverageVector` — per-skill gap metric
- `attritionRate30d / 90d / 180d`
- `pendingOnboardingCount`, `pendingCandidateCount`
- `averageCoachCredibilityScore`
- `clientSatisfactionTrend` (slope over 90 days)
- `budgetRemainingForRecruitment`

#### Action set

```
type CoachPoolAction =
  | 'pool_hold_steady'
  | 'pool_recruit_n'              // with n = 5, 10, 20
  | 'pool_activate_reserve'
  | 'pool_reduce_via_attrition'   // stop backfilling departures
  | 'rebalance_skill_coverage'    // recruit specifically for gap skills
```

#### Reward

System-level, monthly cadence:

```
reward =
  + 1.0  * skill_coverage_improved
  + 0.5  * attrition_rate_decreased
  + 0.3  * mean_client_satisfaction_increased
  - 1.0  * critical_skill_gap_persists
  - 0.5  * over_hired_in_saturated_skill
  - 0.3  * budget_overspend
```

### 3.3 Embedding-based candidate scoring

Same architecture as template × ICP fit from
[`mdp-email-outreach.md §3.3`](./mdp-email-outreach.md):

Two complementary scorers, summed:

1. **Shared-parameter affinity** (generalises via embeddings)

   ```
   affinity(candidate, role) =
     cosine(candidate_resume_embedding, role_description_embedding)
   + β_skills    · cosine(candidate_skills_embedding, role_skills_embedding)
   + β_credential · credential_match_fraction
   + β_experience · experience_relevance_score
   ```

2. **Per-cell Q-residual** (captures what embeddings miss)

   ```
   residual(referral_source, role_archetype) =
     learned delta from observed retention
     over (referral_source, role_archetype) cells with ≥10 hires
   ```

   Shrunk toward zero by `n / (n + 10)` — same shrinkage shape as
   the template × ICP residual and the scraping-escalation neighbor
   blend.

The `Q` for an `admit_to_interview` action on candidate C for role R
is then:

```
Q(state, admit_to_interview) = base_handcraft_Q(state, admit_to_interview)
                              + α_affinity · affinity(C, R)
                              + α_residual · residual(C.source, R.archetype)
```

---

## 4. Why embeddings accelerate recruitment learning

Same argument as
[`mdp-for-notifs-and-more.md §4`](./mdp-for-notifs-and-more.md#4-why-similar-users-helps-learning)
for "similar users" — applied to **candidates** and **roles**.

Three generalisation axes:

- **Resume embeddings cluster career patterns.** Two coaches with
  different job titles but similar career trajectories (corporate
  training → coaching certification → client-facing roles) embed
  near each other. If one succeeded, the other starts with that prior.
- **Skills embeddings cluster competencies.** A coach listing
  "executive coaching" and one listing "leadership development"
  cluster together. Keyword matching misses this; embedding distance
  catches it.
- **Outcome-conditioned clustering.** By embedding past hires
  alongside their outcomes, the system builds two clusters: "profiles
  that predicted success" and "profiles that predicted departure."
  New candidates are scored by proximity to each cluster. This is the
  mechanism by which the system learns *which aspects of a resume
  actually matter* rather than which aspects look impressive.

Concretely, this means the very first hire for a brand-new coaching
role is not random — it starts with the prior of embedding-similar
hires across all roles. The alternative — waiting for 50 hires in the
specific role to build per-role statistics — is impractical for a
court that may have 10–15 distinct coaching archetypes.

---

## 5. Reinforcement learning — how this becomes RL

### 5.1 Bandit → delayed-reward MDP

Three stages, same shape as the parent doc:

1. **Contextual bandit (truncated reward).** Per-candidate decision,
   reward partially sealed at 6 months, fully at 12. This is the MVP.
2. **Episodic bandit (onboarding-sequence reward).** One decision per
   onboarding milestone; reward credits the eventual retention to
   the onboarding configuration, not just the screening decision.
3. **Full MDP.** State carries hiring history (`recent_hires`,
   `pool_composition_trajectory`), actions include pool-level sizing
   and skill-rebalancing. γ = 0.95 on a monthly cadence.

### 5.2 Shared parameters and embeddings

Candidate embeddings stored in `coach_candidate_embeddings` —
dedicated table, **not**
[`EntityEmbeddingTable`](../src/server/databases/neondb/tables/entities-tables.ts).
Same reasoning as scraping page embeddings: recruitment-volume churn,
independent retention policies, and re-embedding on every resume update.

Per row:

- `candidate_id`, `embedding_type` (`resume | linkedin | skills |
  outcome_conditioned`), `provider`, `model_name`, `dimensions`,
  `embedding`, `content_hash`, `created_at`

HNSW indexing: separate partial index per `(embedding_type, provider)`.

### 5.3 Cold start

Three layers:

1. **Population prior** in code (`PRIOR_RECRUITMENT_WEIGHTS`).
2. **Cluster prior** — for roles with fewer than 20 hires, shrink
   per-role Q toward population mean with weight `n / (n + 20)`.
3. **Embedding-neighbor prior** — for unseen candidates, blend the
   average outcome of the top-5 nearest resume embeddings.

### 5.4 Off-policy evaluation

Same IPS pattern. Promotion gate:

- IPS-estimated retention-at-12-months strictly > current.
- IPS-estimated early-departure rate not higher by > 2 pp.
- Demographic parity metrics not worsened by > 1 pp.
- Canary on 10% of candidates for ≥2 months before full rollout.

---

## 6. Training loop

### Outcomes pipeline

The trainer reads from `coach_hiring_outcomes` joined on
`coach_hiring_decisions` and `coach_candidates`:

- **Temporal correctness.** The candidate state at *screening time*
  is what the trainer sees, even if the resume was updated later.
  Snapshots in `state_jsonb`.
- **Outcome sealing.** Only tuples with
  `outcome_6m_sealed_at IS NOT NULL` are used for partial training;
  only tuples with `outcome_12m_sealed_at IS NOT NULL` for full
  training.
- **Propensity logging.** Every decision records
  `chosen_action_propensity`.

### Trainer schedule

- `train-recruitment` — nightly for policy weight updates.
- `embed-candidates` — on candidate profile update; batch sweep daily
  for new candidates without embeddings.
- `score-pool-health` — monthly snapshot for pool-level decisions.

---

## 7. Schema (planned)

Mirrors existing conventions. The recruitment surface reuses the
shared `mdp_decisions` table via `surface = 'coach_recruitment'`.

```sql
-- ──────────────────────────────────────────────────
-- Coach candidates
-- ──────────────────────────────────────────────────
create table coach_candidates (
  id                    uuid primary key,
  dd_user_id            uuid,                            -- FK to user if they have a platform account
  full_name             text not null,
  email                 text,
  phone                 text,
  referral_source       text not null default 'direct_application',
  resume_text           text,                            -- parsed resume full text
  resume_url            text,                            -- link to stored resume file
  linkedin_url          text,
  linkedin_profile_text text,                            -- scraped/parsed LinkedIn profile text
  parsed_skills         text[] not null default '{}',    -- extracted skill tags
  parsed_credentials    text[] not null default '{}',    -- degrees, certifications, licenses
  years_experience      real,
  geographic_region     text,
  timezone              text,
  screening_status      text not null default 'pending', -- 'pending' | 'screening' | 'interview' | 'offered' | 'hired' | 'rejected' | 'withdrawn'
  screening_notes       text,
  hired_at              timestamptz,
  departed_at           timestamptz,
  departure_reason      text,
  is_soft_deleted       boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index idx_coach_candidates_status on coach_candidates(screening_status) where is_soft_deleted = false;
create index idx_coach_candidates_dd_user on coach_candidates(dd_user_id) where dd_user_id is not null;

-- ──────────────────────────────────────────────────
-- Candidate embeddings (dedicated store)
-- ──────────────────────────────────────────────────
create table coach_candidate_embeddings (
  id                uuid primary key,
  candidate_id      uuid not null references coach_candidates(id) on delete cascade,
  embedding_type    text not null,                       -- 'resume' | 'linkedin' | 'skills' | 'outcome_conditioned'
  provider          text not null,                       -- 'gemini' | 'openai'
  model_name        text not null,
  dimensions        integer not null,
  embedding         vector,                              -- dimension matches provider
  content_hash      bytea not null,                      -- sha256 of embedded text
  created_at        timestamptz not null default now(),
  unique (candidate_id, embedding_type, provider, model_name, content_hash)
);
create index idx_cce_candidate on coach_candidate_embeddings(candidate_id);
-- HNSW for ANN cosine search per (embedding_type, provider)
create index idx_cce_hnsw_resume_gemini
  on coach_candidate_embeddings using hnsw (embedding vector_cosine_ops)
  where embedding_type = 'resume' and provider = 'gemini';
create index idx_cce_hnsw_linkedin_gemini
  on coach_candidate_embeddings using hnsw (embedding vector_cosine_ops)
  where embedding_type = 'linkedin' and provider = 'gemini';
create index idx_cce_hnsw_skills_gemini
  on coach_candidate_embeddings using hnsw (embedding vector_cosine_ops)
  where embedding_type = 'skills' and provider = 'gemini';

-- ──────────────────────────────────────────────────
-- Skill requirements per coaching role
-- ──────────────────────────────────────────────────
create table coach_skill_requirements (
  id                    uuid primary key,
  role_name             text not null,
  role_description      text not null,
  required_skills       text[] not null default '{}',
  preferred_skills      text[] not null default '{}',
  min_years_experience  real,
  credential_floor      text[] not null default '{}',    -- minimum required credentials
  compensation_band     text not null default 'mid',     -- 'low' | 'mid' | 'high'
  archetype             text,                            -- coaching archetype this role serves
  role_embedding        vector,                          -- embedding of role_description + required_skills
  role_embedding_provider text,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index idx_csr_active on coach_skill_requirements(is_active) where is_active = true;

-- ──────────────────────────────────────────────────
-- Hiring decisions (MDP decision surface)
-- ──────────────────────────────────────────────────
create table coach_hiring_decisions (
  id                        uuid primary key,
  decision_id               uuid,                        -- references mdp_decisions.decision_id (surface='coach_recruitment')
  candidate_id              uuid not null references coach_candidates(id),
  role_id                   uuid references coach_skill_requirements(id),
  policy_version            text not null,
  state_jsonb               jsonb not null,              -- full CoachCandidateState snapshot
  action                    text not null,               -- CoachScreeningAction
  q_values_jsonb            jsonb not null,              -- {action -> q-value} at decision time
  epsilon                   real not null,
  explored                  boolean not null,
  chosen_action_propensity  real not null,               -- for IPS
  affinity_score            real,                        -- embedding affinity at decision time
  residual_score            real,                        -- per-cell Q-residual at decision time
  nearest_success_cosine    real,                        -- mean cosine to top-5 successful hires
  nearest_departure_cosine  real,                        -- mean cosine to top-5 early departures
  candidate_embedding       vector,                      -- denormalised resume embedding at decision time
  recruiter_override        boolean not null default false,
  recruiter_override_action text,                        -- if overridden, what the recruiter chose
  recruiter_override_reason text,
  computed_at               timestamptz not null,
  created_at                timestamptz not null default now()
);
create index idx_chd_candidate on coach_hiring_decisions(candidate_id);
create index idx_chd_role on coach_hiring_decisions(role_id);
create index idx_chd_decision on coach_hiring_decisions(decision_id);
create index idx_chd_action on coach_hiring_decisions(action);

-- ──────────────────────────────────────────────────
-- Hiring outcomes (reward stream)
-- ──────────────────────────────────────────────────
create table coach_hiring_outcomes (
  id                          uuid primary key,
  hiring_decision_id          uuid not null references coach_hiring_decisions(id) on delete cascade,
  candidate_id                uuid not null references coach_candidates(id),
  hired                       boolean not null default false,
  hired_at                    timestamptz,
  onboarding_completed        boolean not null default false,
  onboarding_completed_at     timestamptz,
  retained_at_3_months        boolean,
  retained_at_6_months        boolean,
  retained_at_12_months       boolean,
  departed                    boolean not null default false,
  departed_at                 timestamptz,
  departure_reason            text,
  client_satisfaction_mean    real,                       -- mean client satisfaction over tenure
  client_complaints_count     integer not null default 0,
  session_completion_rate     real,                       -- fraction of scheduled sessions completed
  credibility_score_at_hire   real,
  credibility_score_current   real,
  credential_discrepancy      boolean not null default false,
  reward_6m                   real,                       -- partial reward, sealed at 6 months
  reward_12m                  real,                       -- full reward, sealed at 12 months
  reward_version              text,
  outcome_6m_sealed_at        timestamptz,
  outcome_12m_sealed_at       timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index idx_cho_decision on coach_hiring_outcomes(hiring_decision_id);
create index idx_cho_candidate on coach_hiring_outcomes(candidate_id);
create index idx_cho_sealed_6m on coach_hiring_outcomes(outcome_6m_sealed_at) where outcome_6m_sealed_at is not null;
create index idx_cho_sealed_12m on coach_hiring_outcomes(outcome_12m_sealed_at) where outcome_12m_sealed_at is not null;

-- ──────────────────────────────────────────────────
-- Pool health snapshots (system-level state)
-- ──────────────────────────────────────────────────
create table coach_pool_snapshots (
  id                          uuid primary key,
  snapshot_at                 timestamptz not null,
  total_pool_size             integer not null,
  active_coach_count          integer not null,
  skill_coverage_jsonb        jsonb not null,             -- {skill: coverage_fraction}
  attrition_rate_30d          real,
  attrition_rate_90d          real,
  attrition_rate_180d         real,
  pending_onboarding_count    integer not null default 0,
  pending_candidate_count     integer not null default 0,
  mean_credibility_score      real,
  mean_client_satisfaction    real,
  pool_decision_action        text,                       -- CoachPoolAction taken
  pool_decision_id            uuid,                       -- references mdp_decisions if a pool decision was made
  created_at                  timestamptz not null default now()
);
create index idx_cps_snapshot_at on coach_pool_snapshots(snapshot_at);

-- mdp_policy_weights — shared with every other surface
-- See `mdp-for-notifs-and-more.md §6` for the cross-surface shape.
-- New surface this doc introduces: 'coach_recruitment'
```

---

## 8. Safety rails

- **Credential floor is a hard constraint, not a Q term.** Before
  the per-candidate decision runs, check the credential floor for the
  role. If the candidate does not meet it, `reject_below_floor` fires
  regardless of embedding affinity or Q-values. This mirrors the
  consent/compliance hard-rail pattern from every other surface.

- **Protected characteristics are excluded from features.** The
  featurizer does not include age, gender, race, ethnicity, disability
  status, or any proxy for these. The embedding is generated from
  professional content only (resume text, skills, credentials,
  experience).

- **Fairness audit gates promotion.** Before a new policy version can
  promote from canary to live, the fairness audit runs:
  - Screening recommendation distribution by candidate demographic
    (where voluntarily disclosed), controlling for qualifications.
  - Retention-prediction accuracy parity across demographic groups.
  - Referral-source bias check: does the policy systematically
    prefer one referral channel in a way that proxies demographic
    composition?
  - Any policy version that worsens demographic parity relative to
    the incumbent by more than 1 pp fails the audit.

- **Recruiter overrides are training data, not errors.** When a
  recruiter overrides the MDP recommendation, both the original
  recommendation and the override are logged. The trainer treats
  overrides as label data — if recruiters consistently override a
  specific recommendation pattern, that is signal the policy should
  learn from.

- **Budget caps on embeddings.** Each cron run has a fixed embedding
  budget (e.g., 200 candidates per run). Candidates are prioritized
  by recency and screening status.

- **Exploration cap.** ε ≤ 0.10 in production for standard roles;
  ε ≤ 0.20 for roles with fewer than 20 historical hires (cold-start
  exploration). `reject_below_floor` is never an exploration target.

---

## 9. Wiring it into the live system (staged)

### Stage A — shadow scoring
- Implement `buildCandidateState`, `scoreCandidateScreening` in
  `mdp-recruitment-routines.ts`.
- Call from the recruiter dashboard cron or from candidate intake
  actions.
- Persist decisions to `coach_hiring_decisions` via the shared
  `mdp_decisions` table.
- **Do not surface recommendations.** The recruiter sees their
  existing workflow; we are only logging what the MDP would recommend.

### Stage B — passive reward logging
- After every hire/departure/milestone event, write an outcome row
  to `coach_hiring_outcomes`.
- Implement the 6-month and 12-month sealing jobs.
- We now have `(state, action, reward)` tuples for training.

### Stage C — embed candidates
- Generate resume and LinkedIn embeddings for all candidates via
  `embed-candidates` cron action.
- Store in `coach_candidate_embeddings`.
- Wire the embedding-neighbor prior into `scoreCandidateScreening`.

### Stage D — surface recommendations to recruiters
- Show the MDP recommendation alongside the candidate profile on
  the recruiter dashboard (`u/recruiter/candidates`).
- Log recruiter overrides against the recommendation.
- Keep the recommendation clearly labeled as advisory.

### Stage E — train + promote
- Implement nightly `train-recruitment` cron handler.
- Replace `PRIOR_RECRUITMENT_WEIGHTS` with loaded weights from
  `mdp_policy_weights`.
- Gate promotion behind IPS eval + fairness audit + canary.

### Stage F — pool management
- Implement the monthly `score-pool-health` snapshot.
- Surface pool-level recommendations to the admin dashboard
  (`u/admin/coaching-pool`).
- Wire pool decisions into the hiring pipeline capacity controls.

---

## 10. What this MVP does **not** do (explicitly)

- Does not make hiring decisions autonomously.
- Does not use protected characteristics as features.
- Does not retune reward weights — governance sets them.
- Does not write to coaching assignment or session tables.
- Does not replace the recruiter's workflow.
- Does not train weights until Stage E.
- Does not surface recommendations until Stage D.

All of the above are stages B–F.

---

## 11. Relationship to other MDP surfaces

The coach recruitment surface shares infrastructure with every other
surface but is the most consequential in terms of downstream impact.
A bad notification is a minor annoyance; a bad hire is a months-long
institutional cost. This is why:

- The reward horizon is the longest (12 months vs. hours/days for
  other surfaces).
- The fairness constraints are the strictest (demographic parity
  gates, not just aggregate quality metrics).
- The human-in-the-loop requirement is the most absolute (no
  autonomous execution, ever — not even in Stage F).
- The exploration budget is the most conservative (ε ≤ 0.10 for
  standard roles).

The surface does benefit from shared learning:

- The embedding infrastructure from user embeddings and page
  embeddings transfers directly.
- The neighbor-blend cold-start pattern from scraping escalation
  applies identically.
- The decision-log and policy-versioning schema is reused.
- The OPE → canary → promote pipeline is identical.

The unique addition is the **outcome-conditioned embedding** — a
technique not used on other surfaces because they have fast reward
signals. Only recruitment (and to a lesser extent, outbound email)
has the 6–12 month delay that makes outcome-conditioned clustering
the primary learning substrate.
