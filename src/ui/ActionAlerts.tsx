import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BellRing,
  Crown,
  Flag,
  Handshake,
  HeartHandshake,
  Landmark,
  Megaphone,
  ScrollText,
  ShieldAlert,
  Sparkles,
  Swords,
} from "lucide-react";
import {
  listAvailableActions,
  type AvailableActionTarget,
  type AvailableDomainGrant,
} from "../game/actions";
import { listCallableAllies, listIncomingAllyCalls } from "../game/ally-war";
import { formatGold, formatPrestige } from "../game/economy";
import type { GameState } from "../game/types";
import { formatCount } from "../lib/population";
import { cn } from "@/lib/utils";

type AlertSection =
  | "war"
  | "allegiance"
  | "alliance"
  | "demesne"
  | "provinces"
  | "rebel"
  | "claim"
  | "found"
  | "fabricate"
  | "callAlly"
  | "allyHelp";

interface ActionAlertsProps {
  game: GameState;
  onWar: (id: number) => void;
  onAllegiance: (id: number) => void;
  onAlliance?: (id: number) => void;
  onGrantDomain: (domainId: number) => void;
  onClaimProvince?: (provinceId: number) => void;
  onClaimKingdom?: (royaumeId: number) => void;
  onFoundKingdom?: (provinceId: number) => void;
  onFabricateClaim?: (domainId: number) => void;
  onCancelFabricateClaim?: (domainId: number) => void;
  onRebel?: (mode: "depose" | "independence") => void;
  onCallAlly?: (warId: number, allyId: number) => void;
  onRespondAllyCall?: (requestId: number, accept: boolean) => void;
  onSelect?: (id: number) => void;
  onSelectDomain?: (id: number) => void;
  onSelectProvince?: (id: number) => void;
  onSelectKingdom?: (id: number) => void;
  onHover?: (id: number | null) => void;
}

interface NotifDef {
  id: AlertSection;
  label: string;
  tooltip: string;
  count: number;
  icon: ReactNode;
  /** 0–1 ring progress (domain claim fabrication). */
  progress?: number;
}

export function ActionAlerts({
  game,
  onWar,
  onAllegiance,
  onAlliance,
  onGrantDomain,
  onClaimProvince,
  onClaimKingdom,
  onFoundKingdom,
  onFabricateClaim,
  onCancelFabricateClaim,
  onRebel,
  onCallAlly,
  onRespondAllyCall,
  onSelect,
  onSelectDomain,
  onSelectProvince,
  onSelectKingdom,
  onHover,
}: ActionAlertsProps) {
  const [section, setSection] = useState<AlertSection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Ne dépend que des champs effectivement lus par listAvailableActions — pas
  // du `game` entier, dont la référence change ~20×/s (dayProgress) sans que
  // les actions disponibles changent (recalcul coûteux sinon en continu).
  // (le linter signale ces deps comme "inutiles" car il ne voit pas au-delà
  // de `game` lui-même — déviation volontaire, ne pas "corriger".)
  const available = useMemo(
    () => listAvailableActions(game),
    [
      game.world,
      game.opinions,
      game.alliances,
      game.titles,
      game.claimFabrications,
      game.playerId,
      game.wars,
    ],
  );
  const warCount = available.wars.length;
  const allegCount = available.allegiances.length;
  const allianceCount = available.alliances.length;
  const claimCount = available.provinceClaims.length + available.kingdomClaims.length;
  const foundCount = available.kingdomFoundations.length;
  const fabricateCount = available.domainFabrications.length;
  const fabricating = available.fabricationProgress.length;
  const demesneCount = available.excessDomains.length;
  const hasDemesneAlert = demesneCount > 0;
  const hasProvinceAlert = available.provinceOverage > 0;
  const hasRebellion = !!available.rebellion;

  // Même logique de dépendances restreintes que `available` ci-dessus.
  const callableAllies = useMemo(
    () => listCallableAllies(game),
    [game.world, game.wars, game.alliances, game.playerId],
  );
  const incomingAllyCalls = useMemo(
    () => listIncomingAllyCalls(game),
    [game.world, game.wars, game.allyCallRequests, game.playerId],
  );
  const callAllyCount = callableAllies.length;
  const allyHelpCount = incomingAllyCalls.length;

  const notifs = useMemo((): NotifDef[] => {
    const list: NotifDef[] = [];
    if (allyHelpCount > 0) {
      list.push({
        id: "allyHelp",
        label: "Ally calls",
        tooltip: "An ally calls you to war",
        count: allyHelpCount,
        icon: <BellRing aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (warCount > 0) {
      list.push({
        id: "war",
        label: "Claims",
        tooltip: "Press a claim",
        count: warCount,
        icon: <Swords aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (callAllyCount > 0) {
      list.push({
        id: "callAlly",
        label: "Call allies",
        tooltip: "Call allies into your war",
        count: callAllyCount,
        icon: <Megaphone aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (claimCount > 0) {
      list.push({
        id: "claim",
        label: "Title",
        tooltip: "Claim a province or kingdom title",
        count: claimCount,
        icon: <Landmark aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (foundCount > 0) {
      list.push({
        id: "found",
        label: "Found",
        tooltip: "Found a kingdom",
        count: foundCount,
        icon: <Sparkles aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (fabricateCount > 0 || fabricating > 0) {
      const fab = available.fabricationProgress[0];
      const progress =
        fab && fab.daysRequired > 0
          ? Math.min(1, Math.max(0, fab.daysElapsed / fab.daysRequired))
          : undefined;
      list.push({
        id: "fabricate",
        label: "Domain",
        tooltip: fabricating > 0 ? "Claiming a domain…" : "Claim a domain",
        count: fabricating > 0 ? fabricating : fabricateCount,
        icon: <ScrollText aria-hidden size={17} strokeWidth={1.85} />,
        progress,
      });
    }
    if (allegCount > 0) {
      list.push({
        id: "allegiance",
        label: "Allegiance",
        tooltip: "Demand allegiance",
        count: allegCount,
        icon: <Crown aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (allianceCount > 0) {
      list.push({
        id: "alliance",
        label: "Allies",
        tooltip: "Demand allies",
        count: allianceCount,
        icon: <HeartHandshake aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (hasRebellion) {
      list.push({
        id: "rebel",
        label: "Rebel",
        tooltip: "Rebel against your liege",
        count: 1,
        icon: <Flag aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (hasDemesneAlert) {
      list.push({
        id: "demesne",
        label: "Demesne",
        tooltip: "Grant excess domains",
        count: available.overage,
        icon: <Handshake aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    if (hasProvinceAlert) {
      list.push({
        id: "provinces",
        label: "Provinces",
        tooltip: "Too many provinces in hand — vassals grow discontent",
        count: available.provinceOverage,
        icon: <ShieldAlert aria-hidden size={17} strokeWidth={1.85} />,
      });
    }
    return list;
  }, [
    warCount,
    callAllyCount,
    allyHelpCount,
    claimCount,
    foundCount,
    fabricateCount,
    fabricating,
    allegCount,
    allianceCount,
    hasRebellion,
    hasDemesneAlert,
    available.overage,
    hasProvinceAlert,
    available.provinceOverage,
    available.fabricationProgress,
  ]);

  useEffect(() => {
    if (!section) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setSection(null);
        onHover?.(null);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [section, onHover]);

  useEffect(() => {
    if (notifs.length === 0) {
      setSection(null);
      onHover?.(null);
      return;
    }
    if (section && !notifs.some((n) => n.id === section)) {
      setSection(null);
      onHover?.(null);
    }
  }, [notifs, section, onHover]);

  useEffect(() => {
    if (!section) onHover?.(null);
  }, [section, onHover]);

  function pickSection(next: AlertSection) {
    setSection((cur) => {
      const opening = cur !== next ? next : null;
      if (opening === "claim" && available.provinceClaims[0]) {
        onSelectProvince?.(available.provinceClaims[0].provinceId);
      } else if (opening === "claim" && available.kingdomClaims[0]) {
        onSelectKingdom?.(available.kingdomClaims[0].royaumeId);
      } else if (opening === "found" && available.kingdomFoundations[0]) {
        onSelectProvince?.(available.kingdomFoundations[0].seedProvinceId);
      } else if (opening === "fabricate") {
        const first =
          available.fabricationProgress[0]?.domainId ??
          available.domainFabrications[0]?.domainId;
        if (first != null) onSelectDomain?.(first);
      }
      return opening;
    });
    onHover?.(null);
  }

  function closePanel() {
    setSection(null);
    onHover?.(null);
  }

  function act(
    kind: "war" | "allegiance" | "alliance",
    target: AvailableActionTarget,
  ) {
    if (kind === "war") onWar(target.id);
    else if (kind === "allegiance") onAllegiance(target.id);
    else onAlliance?.(target.id);
    onSelect?.(target.id);
    closePanel();
  }

  function grant(domain: AvailableDomainGrant) {
    onGrantDomain(domain.id);
    onHover?.(null);
  }

  if (notifs.length === 0) return null;

  return (
    <div className="action-alerts" ref={rootRef}>
      <div className="action-alerts-dock" role="toolbar" aria-label="Available actions">
        {notifs.map((n, i) => {
          const hasRing = n.progress != null;
          const pct = hasRing ? Math.round((n.progress ?? 0) * 100) : 0;
          return (
            <button
              key={n.id}
              type="button"
              className={cn(
                "action-alert-notif",
                section === n.id && "is-active",
                hasRing && "has-progress",
              )}
              style={{ animationDelay: `${i * 55}ms` }}
              aria-expanded={section === n.id}
              aria-label={
                hasRing
                  ? `${n.tooltip} (${pct}%)`
                  : `${n.tooltip} (${n.count})`
              }
              title={hasRing ? `${n.tooltip} · ${pct}%` : n.tooltip}
              data-tooltip={hasRing ? `${n.tooltip} · ${pct}%` : n.tooltip}
              onClick={() => pickSection(n.id)}
            >
              {hasRing && (
                <svg
                  className="action-alert-ring"
                  viewBox="0 0 40 40"
                  aria-hidden
                >
                  <circle className="action-alert-ring-track" cx="20" cy="20" r="18" />
                  <circle
                    className="action-alert-ring-progress"
                    cx="20"
                    cy="20"
                    r="18"
                    style={
                      {
                        "--progress": String(n.progress ?? 0),
                      } as CSSProperties
                    }
                  />
                </svg>
              )}
              <span className="action-alert-notif-icon">{n.icon}</span>
              {!hasRing && (
                <span className="action-alerts-count-badge" aria-hidden>
                  {n.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {section && (
        <div className="action-alerts-panel" role="menu">
          <div className="action-alerts-panel-title">
            {notifs.find((n) => n.id === section)?.tooltip}
          </div>

          {section === "war" && (
            <ul className="action-alerts-list">
              {available.wars.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => act("war", t)}
                    onMouseEnter={() => onHover?.(t.id)}
                    onMouseLeave={() => onHover?.(null)}
                    onFocus={() => onHover?.(t.id)}
                    onBlur={() => onHover?.(null)}
                  >
                    <span className="action-alerts-item-name">
                      {t.holderName}
                      <span className="action-alerts-item-title">
                        {" "}
                        · {t.title}
                      </span>
                    </span>
                    <span className="action-alerts-item-meta">
                      {t.claimTitleName ? `${t.claimTitleName} · ` : ""}
                      {t.warGoalDomains != null
                        ? `${t.warGoalDomains} domains · `
                        : ""}
                      <span
                        className={cn(
                          "action-alerts-item-troops",
                          t.difficultyRatio != null &&
                            (t.difficultyRatio >= 1.15
                              ? "positive"
                              : t.difficultyRatio <= 0.87
                                ? "negative"
                                : undefined),
                        )}
                      >
                        {formatCount(t.troops)} troops
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "allyHelp" && (
            <ul className="action-alerts-list">
              {incomingAllyCalls.map((c) => (
                <li key={c.requestId} className="action-alerts-item-row">
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => {
                      onRespondAllyCall?.(c.requestId, true);
                      onSelect?.(c.callerId);
                      closePanel();
                    }}
                    onMouseEnter={() => onHover?.(c.callerId)}
                    onMouseLeave={() => onHover?.(null)}
                    onFocus={() => onHover?.(c.callerId)}
                    onBlur={() => onHover?.(null)}
                  >
                    <span className="action-alerts-item-name">
                      {c.callerName}
                      <span className="action-alerts-item-title"> vs {c.enemyName}</span>
                    </span>
                    <span className="action-alerts-item-meta">
                      Join the war · declining costs prestige
                    </span>
                  </button>
                  <button
                    type="button"
                    className="action-alerts-item-decline"
                    onClick={() => {
                      onRespondAllyCall?.(c.requestId, false);
                      closePanel();
                    }}
                  >
                    Decline
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "callAlly" && (
            <ul className="action-alerts-list">
              {callableAllies.map((c) => (
                <li key={`${c.warId}-${c.allyId}`}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => {
                      onCallAlly?.(c.warId, c.allyId);
                      onSelect?.(c.allyId);
                      closePanel();
                    }}
                    onMouseEnter={() => onHover?.(c.allyId)}
                    onMouseLeave={() => onHover?.(null)}
                    onFocus={() => onHover?.(c.allyId)}
                    onBlur={() => onHover?.(null)}
                  >
                    <span className="action-alerts-item-name">{c.allyName}</span>
                    <span className="action-alerts-item-meta">
                      Call into the war vs {c.enemyName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "claim" && (
            <ul className="action-alerts-list">
              {available.provinceClaims.map((c) => (
                <li key={c.provinceId}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onMouseEnter={() => onSelectProvince?.(c.provinceId)}
                    onFocus={() => onSelectProvince?.(c.provinceId)}
                    onClick={() => {
                      if (!c.canAfford) return;
                      onSelectProvince?.(c.provinceId);
                      onClaimProvince?.(c.provinceId);
                      closePanel();
                    }}
                    disabled={!c.canAfford}
                  >
                    <span className="action-alerts-item-name">{c.titleName}</span>
                    <span className="action-alerts-item-meta">
                      {c.owned}/{c.total} domains
                      {c.usurping ? " · usurp" : " · vacant"}
                    </span>
                    <span className="action-alerts-item-meta">
                      −{formatGold(c.goldCost)} gold · +
                      {formatPrestige(c.prestigeGain)} prestige
                      {!c.canAfford ? " · need gold" : ""}
                    </span>
                  </button>
                </li>
              ))}
              {available.kingdomClaims.map((c) => (
                <li key={`k-${c.royaumeId}`}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onMouseEnter={() => onSelectKingdom?.(c.royaumeId)}
                    onFocus={() => onSelectKingdom?.(c.royaumeId)}
                    onClick={() => {
                      if (!c.canAfford) return;
                      onSelectKingdom?.(c.royaumeId);
                      onClaimKingdom?.(c.royaumeId);
                      closePanel();
                    }}
                    disabled={!c.canAfford}
                  >
                    <span className="action-alerts-item-name">{c.titleName}</span>
                    <span className="action-alerts-item-meta">
                      {c.owned}/{c.total} domains
                      {c.usurping ? " · usurp" : " · vacant"}
                    </span>
                    <span className="action-alerts-item-meta">
                      −{formatGold(c.goldCost)} gold · +
                      {formatPrestige(c.prestigeGain)} prestige
                      {!c.canAfford ? " · need gold" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "found" && (
            <ul className="action-alerts-list">
              {available.kingdomFoundations.map((f) => (
                <li key={f.seedProvinceId}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onMouseEnter={() => onSelectProvince?.(f.seedProvinceId)}
                    onFocus={() => onSelectProvince?.(f.seedProvinceId)}
                    onClick={() => {
                      if (!f.canAfford) return;
                      onSelectProvince?.(f.seedProvinceId);
                      onFoundKingdom?.(f.seedProvinceId);
                      closePanel();
                    }}
                    disabled={!f.canAfford}
                  >
                    <span className="action-alerts-item-name">
                      Found {f.titleName}
                    </span>
                    <span className="action-alerts-item-meta">
                      {f.provinceIds.length} provinces · breaks the de jure map
                    </span>
                    <span className="action-alerts-item-meta">
                      −{formatGold(f.goldCost)} gold · +
                      {formatPrestige(f.prestigeGain)} prestige
                      {!f.canAfford ? " · need gold" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "fabricate" && (
            <ul className="action-alerts-list">
              {available.fabricationProgress.map((f) => (
                <li key={`prog-${f.domainId}`}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onMouseEnter={() => onSelectDomain?.(f.domainId)}
                    onFocus={() => onSelectDomain?.(f.domainId)}
                    onClick={() => {
                      onSelectDomain?.(f.domainId);
                      onCancelFabricateClaim?.(f.domainId);
                      closePanel();
                    }}
                  >
                    <span className="action-alerts-item-name">
                      Cancel · {f.domainName}
                    </span>
                    <span className="action-alerts-item-meta">
                      {f.daysElapsed}/{f.daysRequired} days · refund +
                      {formatGold(f.goldPaid)}
                    </span>
                  </button>
                </li>
              ))}
              {available.domainFabrications.slice(0, 8).map((c) => (
                <li key={c.domainId}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onMouseEnter={() => onSelectDomain?.(c.domainId)}
                    onFocus={() => onSelectDomain?.(c.domainId)}
                    onClick={() => {
                      onSelectDomain?.(c.domainId);
                      onFabricateClaim?.(c.domainId);
                      closePanel();
                    }}
                  >
                    <span className="action-alerts-item-name">
                      {c.domainName}
                      <span className="action-alerts-item-title">
                        {" "}
                        · {c.holderName}
                        {c.warDefenderName
                          ? ` (realm of ${c.warDefenderName})`
                          : ""}
                      </span>
                    </span>
                    <span className="action-alerts-item-meta">
                      −{formatGold(c.goldCost)} · ~{c.daysRequired} days · +
                      {formatPrestige(c.prestigeGain)} prestige · +
                      {formatGold(c.income)}/mo
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "allegiance" && (
            <ul className="action-alerts-list">
              {available.allegiances.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => act("allegiance", t)}
                    onMouseEnter={() => onHover?.(t.id)}
                    onMouseLeave={() => onHover?.(null)}
                    onFocus={() => onHover?.(t.id)}
                    onBlur={() => onHover?.(null)}
                  >
                    <span className="action-alerts-item-name">
                      {t.holderName}
                      <span className="action-alerts-item-title">
                        {" "}
                        · {t.title}
                      </span>
                    </span>
                    <span className="action-alerts-item-meta">
                      {formatCount(t.troops)} troops
                      {t.prestigeCost != null
                        ? ` · −${formatPrestige(t.prestigeCost)} prestige`
                        : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "alliance" && (
            <ul className="action-alerts-list">
              {[...available.alliances]
                .sort((a, b) => b.troops - a.troops)
                .map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="action-alerts-item"
                      onClick={() => act("alliance", t)}
                      onMouseEnter={() => onHover?.(t.id)}
                      onMouseLeave={() => onHover?.(null)}
                      onFocus={() => onHover?.(t.id)}
                      onBlur={() => onHover?.(null)}
                    >
                      <span className="action-alerts-item-name">
                        {t.holderName}
                        <span className="action-alerts-item-title">
                          {" "}
                          · {t.title}
                        </span>
                      </span>
                      <span className="action-alerts-item-meta">
                        opinion {t.opinion} · {formatCount(t.troops)} troops
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          )}

          {section === "rebel" && available.rebellion && (
            <ul className="action-alerts-list">
              {available.rebellion.canDepose && (
                <li>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => {
                      onRebel?.("depose");
                      onSelect?.(available.rebellion!.liegeId);
                      closePanel();
                    }}
                    onMouseEnter={() => onHover?.(available.rebellion!.liegeId)}
                    onMouseLeave={() => onHover?.(null)}
                  >
                    <span className="action-alerts-item-name">
                      Depose {available.rebellion.liegeName}
                    </span>
                    <span className="action-alerts-item-meta">
                      {available.rebellion.ratio.toFixed(1)}× ·{" "}
                      {formatCount(available.rebellion.troops)} troops
                    </span>
                  </button>
                </li>
              )}
              {available.rebellion.canIndependence && (
                <li>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => {
                      onRebel?.("independence");
                      onSelect?.(available.rebellion!.liegeId);
                      closePanel();
                    }}
                    onMouseEnter={() => onHover?.(available.rebellion!.liegeId)}
                    onMouseLeave={() => onHover?.(null)}
                  >
                    <span className="action-alerts-item-name">
                      Declare independence
                    </span>
                    <span className="action-alerts-item-meta">
                      {available.rebellion.ratio.toFixed(1)}× ·{" "}
                      {formatCount(available.rebellion.troops)} troops
                    </span>
                  </button>
                </li>
              )}
            </ul>
          )}

          {section === "demesne" && (
            <ul className="action-alerts-list">
              {available.excessDomains.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => grant(d)}
                    onMouseEnter={() => onSelectDomain?.(d.id)}
                    onFocus={() => onSelectDomain?.(d.id)}
                  >
                    <span className="action-alerts-item-name">
                      {d.name}
                      <span className="action-alerts-item-title">
                        {" "}
                        · +{formatGold(d.income)}/mo
                      </span>
                    </span>
                    <span className="action-alerts-item-meta">grant vassal</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {section === "provinces" && (
            <ul className="action-alerts-list">
              {available.excessProvinceDomains.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="action-alerts-item"
                    onClick={() => grant(d)}
                    onMouseEnter={() => onSelectDomain?.(d.id)}
                    onFocus={() => onSelectDomain?.(d.id)}
                  >
                    <span className="action-alerts-item-name">
                      {d.name}
                      <span className="action-alerts-item-title">
                        {" "}
                        · +{formatGold(d.income)}/mo
                      </span>
                    </span>
                    <span className="action-alerts-item-meta">grant vassal</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
