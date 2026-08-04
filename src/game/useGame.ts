import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldData } from "../types/world";
import { declareRebellion, declareWar, demandAllegiance, grantDomain, requestAlliance, sendGift, claimProvinceTitle, claimKingdomTitle, renameKingdom, foundImaginaryKingdom, startFabricateDomainClaim, cancelFabricateDomainClaim } from "./actions";
import {
  mergeArmies,
  orderMarch,
  pressDemands,
  raiseLevies,
  requestWhitePeace,
  splitArmy,
  surrenderWar,
} from "./army-actions";
import { callAlly, respondAllyCall } from "./ally-war";
import { createGame } from "./createGame";
import {
  clearDevAutosave,
  loadDevAutosave,
  loadGame,
  peekSave,
  saveDevAutosave,
  saveGame,
  worldFingerprint,
  type SaveInfo,
} from "./save";
import { tickFrame } from "./tick";
import { getPlayer, pushLog, type GameSpeed, type GameState } from "./types";

/** Une notice modale vient d'apparaître : force la pause tant qu'elle n'est pas acquittée. */
function pauseForNewNotices(prev: GameState, next: GameState): GameState {
  if (next.playing && next.notices.length > (prev.notices?.length ?? 0)) {
    return { ...next, playing: false };
  }
  return next;
}

function cloneMutable(g: GameState): GameState {
  return {
    ...g,
    world: structuredClone(g.world),
    titles: structuredClone(g.titles || []),
    kingdomDrifts: (g.kingdomDrifts || []).map((d) => ({
      ...d,
      provinceIds: [...d.provinceIds],
    })),
    nextDriftId: g.nextDriftId ?? 1,
    claimFabrications: (g.claimFabrications || []).map((f) => ({ ...f })),
    wars: g.wars.map((w) => ({
      ...w,
      conquestOrder: [...(w.conquestOrder || [])],
      attackerFrontOrder: w.attackerFrontOrder ? [...w.attackerFrontOrder] : undefined,
      capturedByAttacker: [...(w.capturedByAttacker || [])],
      capturedByDefender: [...(w.capturedByDefender || [])],
      allyOfAttacker: w.allyOfAttacker ? [...w.allyOfAttacker] : undefined,
      allyOfDefender: w.allyOfDefender ? [...w.allyOfDefender] : undefined,
      warGoalDomainIds: w.warGoalDomainIds
        ? [...w.warGoalDomainIds]
        : undefined,
    })),
    armies: g.armies.map((a) => ({
      ...a,
      path: a.path ? [...a.path] : undefined,
      battleOpponentIds: a.battleOpponentIds ? [...a.battleOpponentIds] : undefined,
    })),
    nextArmyId: g.nextArmyId ?? 1,
    opinions: { ...g.opinions },
    giftsSent: { ...g.giftsSent },
    alliances: [...(g.alliances || [])],
    allyCallRequests: (g.allyCallRequests || []).map((r) => ({ ...r })),
    nextAllyCallRequestId: g.nextAllyCallRequestId ?? 1,
    notices: [...(g.notices || [])],
    nextNoticeId: g.nextNoticeId ?? 1,
    log: [...g.log],
    nextLogId: g.nextLogId,
    nextWarId: g.nextWarId,
    nextFabricationId: g.nextFabricationId ?? 1,
  };
}

export function useGame(template: WorldData | null) {
  const [game, setGame] = useState<GameState | null>(null);
  const [saveAvailable, setSaveAvailable] = useState(false);
  const [saveInfo, setSaveInfo] = useState<SaveInfo | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const gameRef = useRef(game);
  gameRef.current = game;
  const lastAutosaveRef = useRef(0);

  const refreshSaveInfo = useCallback(async () => {
    try {
      const info = await peekSave();
      setSaveInfo(info);
      setSaveAvailable(!!info);
    } catch {
      setSaveInfo(null);
      setSaveAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (!template) {
      setGame(null);
      setSaveAvailable(false);
      setSaveInfo(null);
      return;
    }
    if (import.meta.env.DEV) {
      // Restaure l'état exact d'avant le full reload que Vite déclenche quand
      // un module non-composant (logique de jeu) est édité en dev — sauf si
      // world.json a changé entretemps (empreinte différente), auquel cas
      // l'autosave est périmée et on repart d'une partie neuve.
      loadDevAutosave(worldFingerprint(template)).then((restored) => {
        setGame(restored ?? createGame(template));
        void refreshSaveInfo();
      });
      return;
    }
    setGame(createGame(template));
    void refreshSaveInfo();
  }, [template, refreshSaveInfo]);

  useEffect(() => {
    if (!import.meta.env.DEV || !game) return;
    const THROTTLE_MS = 600;
    const elapsed = Date.now() - lastAutosaveRef.current;
    const write = () => {
      lastAutosaveRef.current = Date.now();
      void saveDevAutosave(gameRef.current!);
    };
    if (elapsed >= THROTTLE_MS) {
      write();
      return;
    }
    const id = window.setTimeout(write, THROTTLE_MS - elapsed);
    return () => window.clearTimeout(id);
  }, [game]);

  useEffect(() => {
    if (!game?.playing || game.phase !== "play") return;

    /** Cadence de rendu du monde, indépendante de la vitesse de jeu : assez
     * fine pour que les armées en marche glissent de façon linéaire au lieu
     * d’avancer par à-coups d’un jour entier. `tickFrame` gère lui-même le
     * sous-jour (dayProgress) et les rollovers multi-jours si besoin. */
    const UPDATE_MS = 50;

    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const loop = (now: number) => {
      const rawDt = now - last;
      last = now;
      const dt = Math.min(rawDt, 100);
      const g = gameRef.current;
      if (!g?.playing || g.phase !== "play") {
        raf = requestAnimationFrame(loop);
        return;
      }

      acc += dt;
      if (acc >= UPDATE_MS) {
        const elapsed = acc;
        acc = 0;
        setGame((cur) => (cur ? pauseForNewNotices(cur, tickFrame(cur, elapsed)) : cur));
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [game?.playing, game?.phase]);

  useEffect(() => {
    if (!saveStatus) return;
    const id = window.setTimeout(() => setSaveStatus(null), 2200);
    return () => window.clearTimeout(id);
  }, [saveStatus]);

  const goToMenu = useCallback(() => {
    if (!template) return;
    setGame(createGame(template));
    setSaveStatus(null);
    if (import.meta.env.DEV) void clearDevAutosave();
    void refreshSaveInfo();
  }, [template, refreshSaveInfo]);

  const startNewGame = useCallback(() => {
    if (!template) return;
    const next = createGame(template);
    next.phase = "pick";
    next.log = [
      {
        id: 0,
        year: next.year,
        text: "Choose a character to rule. The map is the starting board for every game.",
      },
    ];
    next.nextLogId = 1;
    setGame(next);
    setSaveStatus(null);
    if (import.meta.env.DEV) void clearDevAutosave();
  }, [template]);

  const selectPlayer = useCallback((possessionId: number) => {
    setGame((g) => {
      if (!g || (g.phase !== "pick" && g.phase !== "play")) return g;
      const p = (g.world.possessions || []).find((x) => x.id === possessionId);
      if (!p) return g;
      const next = { ...g, playerId: possessionId, phase: "play" as const, playing: false };
      pushLog(next, `You rule as ${p.holderName} (${p.title}).`);
      return next;
    });
  }, []);

  const setPlaying = useCallback((playing: boolean) => {
    setGame((g) => {
      if (!g || g.phase !== "play" || g.playerId == null) return g;
      return { ...g, playing };
    });
  }, []);

  const setSpeed = useCallback((speed: GameSpeed) => {
    setGame((g) => (g ? { ...g, speed } : g));
  }, []);

  const doSave = useCallback(async () => {
    if (!game || game.phase !== "play") return;
    try {
      await saveGame(game);
      setSaveStatus("Saved");
      setGame((g) => (g ? { ...g, playing: false } : g));
      await refreshSaveInfo();
    } catch {
      setSaveStatus("Save failed");
    }
  }, [game, refreshSaveInfo]);

  const doLoad = useCallback(async () => {
    try {
      const loaded = await loadGame();
      if (!loaded) {
        setSaveStatus("No save found");
        await refreshSaveInfo();
        return false;
      }
      setGame({ ...loaded, playing: false, phase: "play" });
      setSaveStatus("Loaded");
      await refreshSaveInfo();
      return true;
    } catch {
      setSaveStatus("Load failed");
      return false;
    }
  }, [refreshSaveInfo]);

  const doWar = useCallback((targetId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      declareWar(next, targetId);
      return { ...next };
    });
  }, []);

  const doAllegiance = useCallback((targetId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      demandAllegiance(next, targetId);
      return { ...next };
    });
  }, []);

  const doAlliance = useCallback((targetId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      requestAlliance(next, targetId);
      return { ...next };
    });
  }, []);

  const doGift = useCallback((targetId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      sendGift(next, targetId);
      return { ...next };
    });
  }, []);

  const doGrant = useCallback((domainId: number, vassalId: number | null) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      grantDomain(next, domainId, vassalId);
      return { ...next };
    });
  }, []);

  const doRebel = useCallback((mode: "depose" | "independence") => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      declareRebellion(next, mode);
      return { ...next };
    });
  }, []);

  const doClaimProvince = useCallback((provinceId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      claimProvinceTitle(next, provinceId);
      return { ...next };
    });
  }, []);

  const doClaimKingdom = useCallback((royaumeId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      claimKingdomTitle(next, royaumeId);
      return { ...next };
    });
  }, []);

  const doRenameKingdom = useCallback((royaumeId: number, name: string) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      renameKingdom(next, royaumeId, name);
      return { ...next };
    });
  }, []);

  const doFoundKingdom = useCallback((provinceId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      foundImaginaryKingdom(next, provinceId);
      return { ...next };
    });
  }, []);

  const doFabricateClaim = useCallback((domainId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      if (!next.claimFabrications) next.claimFabrications = [];
      startFabricateDomainClaim(next, domainId);
      return { ...next };
    });
  }, []);

  const doCancelFabricateClaim = useCallback((domainId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      if (!next.claimFabrications) next.claimFabrications = [];
      cancelFabricateDomainClaim(next, domainId);
      return { ...next };
    });
  }, []);

  const doRaiseLevies = useCallback((warId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      raiseLevies(next, warId);
      return { ...next };
    });
  }, []);

  const doSplitArmy = useCallback((armyId: number, troopsToSplit: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      splitArmy(next, armyId, troopsToSplit);
      return { ...next };
    });
  }, []);

  const doMergeArmies = useCallback((armyIds: number[]) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      mergeArmies(next, armyIds);
      return { ...next };
    });
  }, []);

  const doOrderMarch = useCallback((armyId: number, destinationDomainId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      orderMarch(next, armyId, destinationDomainId);
      return { ...next };
    });
  }, []);

  const doSurrenderWar = useCallback((warId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      surrenderWar(next, warId);
      return { ...next };
    });
  }, []);

  const doWhitePeace = useCallback((warId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      requestWhitePeace(next, warId);
      return { ...next };
    });
  }, []);

  const doPressDemands = useCallback((warId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      pressDemands(next, warId);
      return { ...next };
    });
  }, []);

  const doCallAlly = useCallback((warId: number, allyId: number) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      callAlly(next, warId, allyId);
      return pauseForNewNotices(g, { ...next });
    });
  }, []);

  const doDismissNotice = useCallback((noticeId: number) => {
    setGame((g) => {
      if (!g) return g;
      return { ...g, notices: g.notices.filter((n) => n.id !== noticeId) };
    });
  }, []);

  const doRespondAllyCall = useCallback((requestId: number, accept: boolean) => {
    setGame((g) => {
      if (!g) return g;
      const next = cloneMutable(g);
      respondAllyCall(next, requestId, accept);
      return { ...next };
    });
  }, []);

  return {
    game,
    player: game ? getPlayer(game) : null,
    saveAvailable,
    saveInfo,
    saveStatus,
    selectPlayer,
    setPlaying,
    setSpeed,
    goToMenu,
    startNewGame,
    doSave,
    doLoad,
    doWar,
    doAllegiance,
    doAlliance,
    doGift,
    doGrant,
    doRebel,
    doClaimProvince,
    doClaimKingdom,
    doRenameKingdom,
    doFoundKingdom,
    doFabricateClaim,
    doCancelFabricateClaim,
    doRaiseLevies,
    doSplitArmy,
    doMergeArmies,
    doOrderMarch,
    doSurrenderWar,
    doWhitePeace,
    doPressDemands,
    doCallAlly,
    doRespondAllyCall,
    doDismissNotice,
  };
}
