/**
 * Runtime dell'agente (M1).
 *
 * Il turno è una sequenza di fasi separate, ognuna sostituibile e testabile
 * da sola; ogni fase che costa denaro passa prima dal governo. In M0 sono
 * fissati i nomi delle fasi e i limiti di default; il loop arriva in M1.
 */

export const TURN_PHASES = [
  "preflight",
  "assemblaggio",
  "chiamata",
  "errori",
  "lettura",
  "tool",
  "overflow",
  "compressione",
  "recupero",
  "chiusura",
] as const;

export type TurnPhase = (typeof TURN_PHASES)[number];

export interface TurnLimits {
  maxIterations: number;
  maxDurationMs: number;
  /** Tetto di spesa del turno, nella valuta dell'azienda. */
  budget: number | null;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxIterations: 200,
  maxDurationMs: 60 * 60 * 1000,
  budget: null,
};

export type StopReason =
  | "risposta_finale"
  | "interruzione"
  | "limite_iterazioni"
  | "limite_tempo"
  | "budget_esaurito"
  | "approvazione_in_attesa"
  | "errore";
