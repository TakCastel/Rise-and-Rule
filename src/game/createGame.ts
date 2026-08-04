import { buildOpinionMatrix } from "./opinion";
import {
  STARTING_PRESTIGE_MONTHS,
  STARTING_TREASURY_MONTHS,
  ensureDomainIncomes,
  possessionMonthlyIncome,
  possessionMonthlyPrestige,
  setGold,
  setPrestige,
} from "./economy";
import type { GameState } from "./types";
import { START_YEAR, cloneWorld } from "./types";
import type { WorldData } from "../types/world";
import { rebuildPossessionNeighbors } from "./war";
import { buildInitialTitles, seedDeJureProvinceClaims } from "./titles";

export function createGame(template: WorldData): GameState {
  const world = cloneWorld(template);
  ensureDomainIncomes(world);
  rebuildPossessionNeighbors(world);
  for (const p of world.possessions || []) {
    const monthly = possessionMonthlyIncome(world, p);
    setGold(p, monthly * STARTING_TREASURY_MONTHS);
    const prestigeMo = possessionMonthlyPrestige(world, p);
    setPrestige(p, prestigeMo * STARTING_PRESTIGE_MONTHS);
    // 1 ou 2 enfants au départ (jetons de mariage)
    p.childrenTokens = Math.random() < 0.5 ? 1 : 2;
    if (!p.claims) p.claims = [];
    if (!p.domainClaims) p.domainClaims = [];
  }
  const opinions = buildOpinionMatrix(world);
  const titles = buildInitialTitles(world);
  seedDeJureProvinceClaims(world, titles, START_YEAR);
  return {
    world,
    phase: "menu",
    playerId: null,
    year: START_YEAR,
    month: 0,
    day: 1,
    dayProgress: 0,
    playing: false,
    speed: 1,
    wars: [],
    nextWarId: 1,
    armies: [],
    nextArmyId: 1,
    titles,
    kingdomDrifts: [],
    nextDriftId: 1,
    claimFabrications: [],
    nextFabricationId: 1,
    opinions,
    giftsSent: {},
    alliances: [],
    allyCallRequests: [],
    nextAllyCallRequestId: 1,
    notices: [],
    nextNoticeId: 1,
    log: [
      {
        id: 0,
        year: START_YEAR,
        text: "Western Europe, around 486. Choose a path from the main menu.",
      },
    ],
    nextLogId: 1,
  };
}
