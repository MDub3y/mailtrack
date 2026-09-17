import mongoose from 'mongoose';
import { AgentRun, RunKind } from '../models/AgentRun';

// Per-owner, per-kind daily token ceilings (doc/04-decisions.md, ADR-14).
// Enforced before a call is made, not estimated after. Configured through env:
//   AI_DAILY_TOKENS_DEFAULT              applies to any kind without its own value
//   AI_DAILY_TOKENS_<KIND_UPPERCASE>     e.g. AI_DAILY_TOKENS_DRAFT_FOLLOW_UP
// A ceiling of 0 refuses every run of that kind, which is how the acceptance
// test for Phase 0 exercises the refusal path.

const HARD_DEFAULT = 200_000;

export function dailyCeilingFor(kind: RunKind): number {
  const specific = process.env[`AI_DAILY_TOKENS_${kind.toUpperCase()}`];
  if (specific !== undefined && specific !== '') return Number(specific);
  const fallback = process.env.AI_DAILY_TOKENS_DEFAULT;
  if (fallback !== undefined && fallback !== '') return Number(fallback);
  return HARD_DEFAULT;
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface BudgetCheck {
  allowed: boolean;
  ceiling: number;
  spentToday: number;
}

export async function checkBudget(ownerId: string | mongoose.Types.ObjectId, kind: RunKind): Promise<BudgetCheck> {
  const ceiling = dailyCeilingFor(kind);
  const since = startOfUtcDay();

  const [agg] = await AgentRun.aggregate<{ total: number }>([
    {
      $match: {
        ownerId: new mongoose.Types.ObjectId(String(ownerId)),
        kind,
        startedAt: { $gte: since },
        // Running runs count too: a burst of parallel jobs must not all pass
        // the check before any of them has finalised its usage.
        status: { $in: ['running', 'succeeded', 'failed'] },
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: { $add: ['$usage.input', '$usage.output', '$usage.cacheRead', '$usage.cacheWrite'] },
        },
      },
    },
  ]);

  const spentToday = agg?.total ?? 0;
  return { allowed: spentToday < ceiling, ceiling, spentToday };
}
