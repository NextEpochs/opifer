/**
 * Agent runtime (M1).
 *
 * A turn is a sequence of separate phases, each replaceable and testable on
 * its own; every phase that costs money goes through governance first. M0
 * fixes the phase names and the default limits; the loop arrives in M1.
 */

export const TURN_PHASES = ["preflight", "assemble", "call", "errors", "read", "tools", "overflow", "compress", "recover", "close"] as const;

export type TurnPhase = (typeof TURN_PHASES)[number];

export interface TurnLimits {
  maxIterations: number;
  maxDurationMs: number;
  /** Spending cap for the turn, in the company's currency. */
  budget: number | null;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxIterations: 200,
  maxDurationMs: 60 * 60 * 1000,
  budget: null,
};

export type StopReason = "final_answer" | "interrupted" | "iteration_limit" | "time_limit" | "budget_exhausted" | "approval_pending" | "error";
