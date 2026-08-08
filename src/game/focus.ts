import type { Possession, PossessionFocus } from "../types/world";
export type { PossessionFocus } from "../types/world";

/** Bonus au domaine choisi. */
export const FOCUS_BONUS = 0.2;
/** Malus aux deux domaines délaissés. */
export const FOCUS_PENALTY = 0.1;

function multiplierFor(
  focus: PossessionFocus | undefined,
  matches: PossessionFocus,
): number {
  if (focus == null) return 1;
  return focus === matches ? 1 + FOCUS_BONUS : 1 - FOCUS_PENALTY;
}

/** Multiplicateur de revenu d’or selon le focus. */
export function economyFocusMultiplier(p: Possession | undefined): number {
  return multiplierFor(p?.focus, "economy");
}

/** Multiplicateur de dégâts infligés en bataille selon le focus. */
export function warFocusMultiplier(p: Possession | undefined): number {
  return multiplierFor(p?.focus, "war");
}

/** Multiplicateur de gains de prestige selon le focus. */
export function prestigeFocusMultiplier(p: Possession | undefined): number {
  return multiplierFor(p?.focus, "prestige");
}
