import { useState } from "react";
import { Plus, X } from "lucide-react";
import { previewAction, previewFabricateDomainClaim, previewGift, previewGrantDomain } from "../game/actions";
import { siegeDefenseStrength } from "../game/army";
import {
  ALLIANCE_MAX_HOPS,
  ALLIANCE_OPINION_MIN,
  areAllied,
  getAllyIds,
  getChildrenTokens,
} from "../game/alliance";
import { isUnderLiege } from "../game/war";
import {
  formatGold,
  formatGoldDelta,
  formatPrestige,
  getGold,
  getPrestige,
  possessionIncomeBreakdown,
  possessionMonthlyPrestige,
  domainMonthlyIncome,
} from "../game/economy";
import {
  DEMESNE_LIMIT,
  demesneCount,
  demesneOverage,
  demesnePenaltyPercent,
} from "../game/demesne";
import { possessionPowerBreakdown } from "../game/power";
import {
  canFoundImaginaryKingdom,
  canUsurpKingdomTitle,
  canUsurpProvinceTitle,
  findKingdomTitle,
  findProvinceTitle,
  fullControlFromDomains,
  hasClaim,
  kingdomTitleGoldCost,
  kingdomTitlePrestigeGain,
  provinceTitleGoldCost,
  provinceTitlePrestigeGain,
  realmDisplayName,
  titlesHeldBy,
} from "../game/titles";
import type { GameState } from "../game/types";
import { formatCount as formatPower } from "../lib/population";
import { TERRAIN_PALETTE, developmentColor, getPanelInfo } from "../map/levels";
import { CollapsibleSection } from "./CollapsibleSection";
import {
  LEVY_RATE,
  formatCount,
  getPossessionDemesneManpower,
  sumManpower,
} from "../lib/population";
import type { LevelName, Selection, WorldData } from "../types/world";

const BUILDING_SLOT_COUNT = 3;

interface SelectionCardProps {
  world: WorldData;
  selection: Selection;
  level: LevelName;
  onSelect: (sel: Selection) => void;
  onLevelChange: (level: LevelName) => void;
  onClose: () => void;
  game?: GameState | null;
  onPlayAs?: (possessionId: number) => void;
  onWar?: (targetId: number) => void;
  onAllegiance?: (targetId: number) => void;
  onAlliance?: (targetId: number) => void;
  onGift?: (targetId: number) => void;
  onGrant?: (domainId: number, vassalId: number | null) => void;
  onFabricateClaim?: (domainId: number) => void;
  onCancelFabricateClaim?: (domainId: number) => void;
  onClaimProvince?: (provinceId: number) => void;
  onClaimKingdom?: (royaumeId: number) => void;
  onFoundKingdom?: (provinceId: number) => void;
  onRenameKingdom?: (royaumeId: number, name: string) => void;
  onRebel?: (mode: "depose" | "independence") => void;
}

export function SelectionCard({
  world,
  selection,
  level,
  onSelect,
  onLevelChange,
  onClose,
  game,
  onPlayAs,
  onWar,
  onAllegiance,
  onAlliance,
  onGift,
  onGrant,
  onFabricateClaim,
  onCancelFabricateClaim,
  onClaimProvince,
  onClaimKingdom,
  onFoundKingdom,
  onRenameKingdom,
  onRebel,
}: SelectionCardProps) {
  const info = getPanelInfo(world, selection);
  if (!info || !selection) return null;

  if (selection.level === "possession") {
    return (
      <CharacterCard
        world={world}
        selection={selection}
        info={info}
        onSelect={onSelect}
        onLevelChange={onLevelChange}
        onClose={onClose}
        game={game}
        onPlayAs={onPlayAs}
        onWar={onWar}
        onAllegiance={onAllegiance}
        onAlliance={onAlliance}
        onGift={onGift}
        onGrant={onGrant}
        onRebel={onRebel}
      />
    );
  }

  return (
    <TerritoryCard
      world={world}
      selection={selection}
      level={level}
      info={info}
      onSelect={onSelect}
      onLevelChange={onLevelChange}
      onClose={onClose}
      game={game}
      onGrant={onGrant}
      onFabricateClaim={onFabricateClaim}
      onCancelFabricateClaim={onCancelFabricateClaim}
      onClaimProvince={onClaimProvince}
      onClaimKingdom={onClaimKingdom}
      onFoundKingdom={onFoundKingdom}
      onRenameKingdom={onRenameKingdom}
      onWar={onWar}
    />
  );
}

type PanelInfo = NonNullable<ReturnType<typeof getPanelInfo>>;

function CharacterCard({
  world,
  selection,
  info,
  onSelect,
  onLevelChange,
  onClose,
  game,
  onPlayAs,
  onWar,
  onAllegiance,
  onAlliance,
  onGift,
  onGrant,
  onRebel,
}: {
  world: WorldData;
  selection: NonNullable<Selection>;
  info: PanelInfo;
  onSelect: (sel: Selection) => void;
  onLevelChange: (level: LevelName) => void;
  onClose: () => void;
  game?: GameState | null;
  onPlayAs?: (possessionId: number) => void;
  onWar?: (targetId: number) => void;
  onAllegiance?: (targetId: number) => void;
  onAlliance?: (targetId: number) => void;
  onGift?: (targetId: number) => void;
  onGrant?: (domainId: number, vassalId: number | null) => void;
  onRebel?: (mode: "depose" | "independence") => void;
}) {
  const possession = (world.possessions || []).find((p) => p.id === selection.id);
  if (!possession) return null;

  const realmName = realmDisplayName(world, game?.titles || [], possession);

  const isKing = possession.rank === "king";
  const isVassal = possession.rank === "vassal" || possession.rank === "subvassal";
  const isChief = possession.rank === "chief";
  const liege =
    possession.liegeId != null
      ? (world.possessions || []).find((p) => p.id === possession.liegeId)
      : null;

  const vassals = isKing || (possession.vassalIds || []).length > 0
    ? (possession.vassalIds || [])
        .map((id) => (world.possessions || []).find((p) => p.id === id))
        .filter(Boolean)
        .slice()
        .sort((a, b) => a!.holderName.localeCompare(b!.holderName))
    : [];

  const allyIds = getAllyIds(game?.alliances, possession.id);
  const allies = allyIds
    .map((id) => (world.possessions || []).find((p) => p.id === id))
    .filter(Boolean)
    .slice()
    .sort((a, b) => a!.holderName.localeCompare(b!.holderName));

  const heldTitles = titlesHeldBy(game?.titles || [], possession.id);
  const heldProvinceTitles = heldTitles
    .filter((t) => t.tier === "province")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const heldKingdomTitles = heldTitles.filter((t) => t.tier === "kingdom");
  const claimedTitles = (game?.titles || []).filter(
    (t) => t.holderId !== possession.id && hasClaim(possession, t.id),
  );

  const demesne = getPossessionDemesneManpower(world, possession);
  const host = possessionPowerBreakdown(world, possession, game?.opinions, game?.armies);
  const hasVassals = host.vassals.length > 0;
  const income = possessionIncomeBreakdown(world, possession);
  const treasury = getGold(possession);
  const prestige = getPrestige(possession);
  const prestigeMo = possessionMonthlyPrestige(world, possession);

  const rankLabel = isKing
    ? "King"
    : possession.rank === "subvassal"
      ? "Subvassal"
      : isVassal
        ? "Vassal"
        : isChief
          ? "Chief"
          : "Holder";
  const isPlayer = game?.playerId === possession.id;
  const canPlayAs = game?.phase === "pick" && onPlayAs;
  const canInteract =
    game?.phase === "play" && game.playerId != null && !isPlayer;
  const warPreview = canInteract ? previewAction(game!, possession.id, "war") : null;
  const allegPreview = canInteract
    ? previewAction(game!, possession.id, "allegiance")
    : null;
  const alliancePreview = canInteract
    ? previewAction(game!, possession.id, "alliance")
    : null;
  const giftPreview = canInteract ? previewGift(game!, possession.id) : null;
  const alreadyAllied =
    !!game && areAllied(game.alliances, game.playerId ?? -1, possession.id);
  const playerChildren =
    game?.playerId != null
      ? Math.max(
          0,
          (world.possessions || []).find((p) => p.id === game.playerId)?.childrenTokens ?? 0,
        )
      : 0;

  const playerPossession =
    game?.phase === "play" && game.playerId != null
      ? (world.possessions || []).find((p) => p.id === game.playerId)
      : null;
  const isPlayerLiege =
    !!canInteract &&
    !!playerPossession &&
    playerPossession.liegeId === possession.id;
  /** Sujet du joueur (vassal / sous-vassal) — pas de guerre contre eux. */
  const isOwnSubject =
    !!canInteract &&
    !!playerPossession &&
    isUnderLiege(world, possession, playerPossession.id);
  const deposePreview = isPlayerLiege
    ? previewAction(game!, possession.id, "depose")
    : null;
  const independencePreview = isPlayerLiege
    ? previewAction(game!, possession.id, "independence")
    : null;

  return (
    <div
      className="selection-card selection-card-character"
      role="dialog"
      aria-label={possession.holderName}
      style={{ ["--selection-accent" as string]: info.color }}
    >
      <div className="selection-card-accent" aria-hidden />
      <div className="selection-card-body">
        <header className="selection-card-header">
          <div className="selection-card-heading">
            <div className="selection-card-level">
              {rankLabel}
              {isPlayer ? " · You" : ""}
            </div>
            <h2>{possession.holderName}</h2>
            <p className="selection-card-sub">
              {[possession.title, realmName].filter(Boolean).join(" · ")}
            </p>
          </div>
          <button
            type="button"
            className="selection-card-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        {canPlayAs && (
          <button
            type="button"
            className="selection-action-btn primary"
            onClick={() => onPlayAs(possession.id)}
          >
            Play as {possession.holderName}
          </button>
        )}

        {(warPreview || allegPreview || alliancePreview || deposePreview || independencePreview) && (
          <div className="selection-actions">
            {(warPreview || allegPreview || alliancePreview) && !isPlayerLiege && (
              <div className="selection-actions-meta">
                Opinion of you:{" "}
                {alliancePreview?.opinion ??
                  allegPreview?.opinion ??
                  warPreview?.opinion ??
                  0}
                {!warPreview?.neighbor &&
                !allegPreview?.neighbor &&
                !alliancePreview
                  ? " · not neighbors"
                  : ""}
                {alreadyAllied ? " · allied" : ""}
                {warPreview?.claimTitleName
                  ? ` · ${warPreview.claimTitleName}`
                  : ""}
                {warPreview?.warGoalDomainIds?.length
                  ? ` · ${warPreview.warGoalDomainIds.length} domains`
                  : ""}
                {warPreview?.redirectedToName
                  ? ` · protected by ${warPreview.redirectedToName}`
                  : ""}
              </div>
            )}
            {(warPreview || allegPreview) && !isPlayerLiege && !isOwnSubject && (
              <div className="selection-actions-row">
                <button
                  type="button"
                  className="selection-action-btn"
                  disabled={!warPreview?.ok || !onWar}
                  title={
                    warPreview?.redirectedToName
                      ? `War against ${warPreview.redirectedToName}, who protects this vassal${
                          warPreview.reason ? ` — ${warPreview.reason}` : ""
                        }`
                      : warPreview?.reason
                  }
                  onClick={() => onWar?.(possession.id)}
                >
                  {warPreview?.claimTitleName
                    ? `Claim war · ${warPreview.claimTitleName}`
                    : warPreview?.redirectedToName
                    ? `Declare war on ${warPreview.redirectedToName}`
                    : "Declare war"}
                </button>
                <button
                  type="button"
                  className="selection-action-btn"
                  disabled={!allegPreview?.ok || !onAllegiance}
                  title={allegPreview?.reason}
                  onClick={() => onAllegiance?.(possession.id)}
                >
                  Demand allegiance
                  {allegPreview?.prestigeCost != null
                    ? ` · ${formatPrestige(allegPreview.prestigeCost)}`
                    : ""}
                </button>
              </div>
            )}
            {alliancePreview && !isPlayerLiege && (
              <>
                <div className="selection-actions-meta">
                  {alreadyAllied
                    ? "Allied — they send all their troops to your wars"
                    : `Demand ally · ≤${ALLIANCE_MAX_HOPS} territories · opinion ≥${ALLIANCE_OPINION_MIN} · costs 1 child (you have ${playerChildren})`}
                  {!alliancePreview.ok && alliancePreview.reason
                    ? ` — ${alliancePreview.reason}`
                    : ""}
                  {alliancePreview.hops != null
                    ? ` · ${alliancePreview.hops} away`
                    : ""}
                </div>
                {!alreadyAllied && (
                  <div className="selection-actions-row">
                    <button
                      type="button"
                      className="selection-action-btn"
                      disabled={!alliancePreview.ok || !onAlliance}
                      title={
                        alliancePreview.ok
                          ? "Spend a child to seal the alliance"
                          : alliancePreview.reason
                      }
                      onClick={() => onAlliance?.(possession.id)}
                    >
                      Demand ally
                    </button>
                  </div>
                )}
              </>
            )}
            {allegPreview?.ok && !isPlayerLiege && (
              <div className="selection-actions-meta">Will accept — all conditions met</div>
            )}
            {warPreview?.ok && !isPlayerLiege && !isOwnSubject && (
              <div className="selection-actions-meta">
                War starts a multi-day campaign; larger host usually wins. Loser becomes a vassal.
              </div>
            )}
            {giftPreview && !isPlayerLiege && (
              <>
                <div className="selection-actions-meta">
                  {giftPreview.alreadySent
                    ? "Gift already sent"
                    : `Gift costs ${formatGold(giftPreview.gold)} gold (+${giftPreview.opinionGain} opinion)`}
                </div>
                <div className="selection-actions-row">
                  <button
                    type="button"
                    className="selection-action-btn"
                    disabled={!giftPreview.ok || !onGift}
                    title={giftPreview.ok ? undefined : giftPreview.reason}
                    onClick={() => onGift?.(possession.id)}
                  >
                    Send gift · {formatGold(giftPreview.gold)}
                    <span className="selection-gift-op">+{giftPreview.opinionGain}</span>
                  </button>
                </div>
              </>
            )}
            {(deposePreview || independencePreview) && (
              <>
                <div className="selection-actions-meta">
                  Your liege · strength{" "}
                  {(deposePreview ?? independencePreview)!.ratio.toFixed(2)}×
                  {" · "}
                  Rebel to seize the throne or break free
                </div>
                <div className="selection-actions-row">
                  <button
                    type="button"
                    className="selection-action-btn"
                    disabled={!deposePreview?.ok || !onRebel}
                    title={
                      deposePreview?.ok
                        ? "Win to take their lands and vassals"
                        : deposePreview?.reason
                    }
                    onClick={() => onRebel?.("depose")}
                  >
                    Rebel · depose
                  </button>
                  <button
                    type="button"
                    className="selection-action-btn"
                    disabled={!independencePreview?.ok || !onRebel}
                    title={
                      independencePreview?.ok
                        ? "Win to leave the realm as an independent ruler"
                        : independencePreview?.reason
                    }
                    onClick={() => onRebel?.("independence")}
                  >
                    Declare independence
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="selection-manpower">
          <div className="selection-manpower-main">
            <span className="selection-manpower-value">{formatGold(treasury)}</span>
            <span className="selection-manpower-label">
              {treasury < 0 ? "Debt" : "Gold"}
              <span className="selection-manpower-note">
                {" "}
                · {formatGoldDelta(income.net)}/mo
              </span>
            </span>
          </div>
          <div className="selection-manpower-side">
            <span className="selection-manpower-side-value">
              {formatPrestige(prestige)}
            </span>
            <span className="selection-manpower-side-label">
              Prestige · +{formatPrestige(prestigeMo)}/mo
            </span>
          </div>
          <div className="selection-manpower-side">
            <span className="selection-manpower-side-value">
              {formatCount(host.total)}
              {host.capacity > host.total ? (
                <span className="selection-manpower-note">
                  /{formatCount(host.capacity)}
                </span>
              ) : null}
            </span>
            <span className="selection-manpower-side-label">Levies</span>
          </div>
        </div>
        {hasVassals && (
          <div className="selection-actions-meta" style={{ marginTop: "-0.15rem" }}>
            Host {formatCount(host.total)}
            {host.capacity > host.total
              ? ` / ${formatCount(host.capacity)}`
              : ""}{" "}
            · vassals send 10–50% of their levies by opinion
          </div>
        )}

        <div className="selection-context">
          {liege && (
            <button
              type="button"
              className="selection-context-row is-link"
              onClick={() => onSelect({ level: "possession", id: liege.id })}
            >
              <span className="selection-context-label">Liege</span>
              <span className="selection-context-value">{liege.holderName}</span>
            </button>
          )}
          <div className="selection-context-row">
            <span className="selection-context-label">Realm</span>
            <span className="selection-context-value">{realmName}</span>
          </div>
          <div className="selection-context-row">
            <span className="selection-context-label">Demesne</span>
            <span className="selection-context-value">
              {demesneCount(possession)} / {DEMESNE_LIMIT}
              {demesneOverage(possession) > 0
                ? ` · −${demesnePenaltyPercent(possession)}%`
                : ""}
            </span>
          </div>
          {allegPreview && (
            <div className="selection-context-row">
              <span className="selection-context-label">Opinion</span>
              <span className="selection-context-value">{allegPreview.opinion}</span>
            </div>
          )}
          {warPreview && (
            <div className="selection-context-row">
              <span className="selection-context-label">Their power</span>
              <span className="selection-context-value">
                {formatPower(warPreview.targetPower)}
              </span>
            </div>
          )}
        </div>

        {vassals.length > 0 && (
          <CollapsibleSection title="Vassals" count={vassals.length}>
            <ul>
              {vassals.map((v) => {
                const share = host.vassals.find((s) => s.id === v!.id);
                const pct = share ? Math.round(share.fraction * 100) : 0;
                const coAllied =
                  !!game &&
                  (possession.vassalIds || []).some(
                    (oid) =>
                      oid !== v!.id && areAllied(game.alliances, v!.id, oid),
                  );
                return (
                  <li key={v!.id}>
                    <button type="button" onClick={() => onSelect({ level: "possession", id: v!.id })}>
                      <span className="selection-person">
                        <span className="selection-person-name">{v!.holderName}</span>
                        <span className="selection-person-title">
                          {v!.title}
                          {share ? ` · opinion ${share.opinion}` : ""}
                          {coAllied ? " · allied to peers" : ""}
                        </span>
                      </span>
                      <span className="selection-list-aside">
                        {share
                          ? `${formatCount(share.contributed)} (${pct}%)`
                          : formatCount(getPossessionDemesneManpower(world, v!).levies)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </CollapsibleSection>
        )}

        {allies.length > 0 && (
          <CollapsibleSection title="Allies" count={allies.length}>
            <ul>
              {allies.map((a) => (
                <li key={a!.id}>
                  <button
                    type="button"
                    onClick={() => onSelect({ level: "possession", id: a!.id })}
                  >
                    <span className="selection-person">
                      <span className="selection-person-name">{a!.holderName}</span>
                      <span className="selection-person-title">{a!.title}</span>
                    </span>
                    <span className="selection-list-aside">
                      {formatCount(getPossessionDemesneManpower(world, a!).levies)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        {heldProvinceTitles.length > 0 && (
          <CollapsibleSection title="Provinces" count={heldProvinceTitles.length}>
            <ul>
              {heldProvinceTitles.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onLevelChange("province");
                      onSelect({ level: "province", id: t.deJureId });
                    }}
                  >
                    <span>{t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        {heldKingdomTitles.length > 0 && (
          <CollapsibleSection title="Kingdoms" count={heldKingdomTitles.length}>
            <ul>
              {heldKingdomTitles.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onLevelChange("royaume");
                      onSelect({ level: "royaume", id: t.deJureId });
                    }}
                  >
                    <span>{t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        {claimedTitles.length > 0 && (
          <CollapsibleSection title="Claims" count={claimedTitles.length}>
            <ul>
              {claimedTitles.map((t) => {
                const holder =
                  t.holderId != null
                    ? (world.possessions || []).find((p) => p.id === t.holderId)
                    : null;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onLevelChange(t.tier === "kingdom" ? "royaume" : "province");
                        onSelect({
                          level: t.tier === "kingdom" ? "royaume" : "province",
                          id: t.deJureId,
                        });
                      }}
                    >
                      <span>{t.name}</span>
                      <span className="selection-list-aside">
                        {holder ? holder.holderName : "Vacant"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </CollapsibleSection>
        )}

        {isPlayer && game?.phase === "play" && (
          <div className="selection-context-row" style={{ marginTop: "0.35rem" }}>
            <span className="selection-context-label">Children</span>
            <span className="selection-context-value">
              {getChildrenTokens(possession)} marriage token
              {getChildrenTokens(possession) === 1 ? "" : "s"}
            </span>
          </div>
        )}

        {isPlayer && income.domains.length > 0 && (
          <>
            {game?.phase === "play" && demesneOverage(possession) > 0 && (
              <p className="panel-muted" style={{ marginTop: 0 }}>
                Over demesne limit (−{demesnePenaltyPercent(possession)}%
                {income.efficiency < 0 ? ", running a deficit" : ""}). Grant domains
                or your treasury — and levies — will collapse.
              </p>
            )}
            <CollapsibleSection title="Domains" count={income.domains.length}>
            <ul>
              {income.domains.map((d) => {
                const canCreate =
                  game?.phase === "play" && onGrant
                    ? previewGrantDomain(game, d.id, null)?.ok
                    : false;
                const grantableVassals =
                  game?.phase === "play" && onGrant
                    ? (possession.vassalIds || [])
                        .map((id) => (world.possessions || []).find((p) => p.id === id))
                        .filter(Boolean)
                        .filter((v) => previewGrantDomain(game, d.id, v!.id)?.ok)
                    : [];
                return (
                  <li key={d.id}>
                    <div className="selection-domain-grant">
                      <button
                        type="button"
                        className="selection-domain-grant-main"
                        onClick={() => {
                          onLevelChange("domaine");
                          onSelect({ level: "domaine", id: d.id });
                        }}
                      >
                        <span className="selection-person">
                          <span className="selection-person-name">{d.name}</span>
                          <span className="selection-person-title">
                            dev {d.development} · +{formatGold(d.income)}/mo
                          </span>
                        </span>
                      </button>
                      {game?.phase === "play" && onGrant && (
                        <select
                          className="selection-grant-select compact"
                          defaultValue=""
                          aria-label={`Grant ${d.name}`}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (!raw) return;
                            e.target.value = "";
                            if (raw === "new") {
                              if (canCreate) onGrant(d.id, null);
                              return;
                            }
                            const vid = Number(raw);
                            if (!Number.isFinite(vid)) return;
                            onGrant(d.id, vid);
                          }}
                        >
                          <option value="" disabled>
                            Grant…
                          </option>
                          <option value="new" disabled={!canCreate}>
                            New vassal
                          </option>
                          {grantableVassals.map((v) => (
                            <option key={v!.id} value={v!.id}>
                              {v!.holderName}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            </CollapsibleSection>
          </>
        )}

        <footer className="selection-card-foot">
          {formatCount(demesne.population)} pop · {Math.round(LEVY_RATE * 100)}% muster
          {hasVassals ? ` · host ${formatCount(host.total)}` : ""}
          {` · ${formatGoldDelta(income.net)} gold/mo`}
        </footer>
      </div>
    </div>
  );
}

function TerritoryCard({
  world,
  selection,
  level,
  info,
  onSelect,
  onLevelChange,
  onClose,
  game,
  onGrant,
  onFabricateClaim,
  onCancelFabricateClaim,
  onClaimProvince,
  onClaimKingdom,
  onFoundKingdom,
  onRenameKingdom,
  onWar,
}: {
  world: WorldData;
  selection: NonNullable<Selection>;
  level: LevelName;
  info: PanelInfo;
  onSelect: (sel: Selection) => void;
  onLevelChange: (level: LevelName) => void;
  onClose: () => void;
  game?: GameState | null;
  onGrant?: (domainId: number, vassalId: number | null) => void;
  onFabricateClaim?: (domainId: number) => void;
  onCancelFabricateClaim?: (domainId: number) => void;
  onClaimProvince?: (provinceId: number) => void;
  onClaimKingdom?: (royaumeId: number) => void;
  onFoundKingdom?: (provinceId: number) => void;
  onRenameKingdom?: (royaumeId: number, name: string) => void;
  onWar?: (targetId: number) => void;
}) {
  const [renameValue, setRenameValue] = useState("");

  const kingdomMeta =
    selection.level === "royaume"
      ? (world.royaumes || []).find((r) => r.id === selection.id)
      : info.royaumeId != null
        ? (world.royaumes || []).find((r) => r.id === info.royaumeId)
        : null;

  const provinceMeta =
    selection.level === "province"
      ? (world.provinces || []).find((p) => p.id === selection.id)
      : info.provinceId != null
        ? (world.provinces || []).find((p) => p.id === info.provinceId)
        : null;

  const possessionMeta =
    info.possessionId != null
      ? (world.possessions || []).find((p) => p.id === info.possessionId)
      : null;

  const domainMeta =
    selection.level === "domaine"
      ? (world.domaines.find((d) => d.id === selection.id) ?? world.domaines[selection.id])
      : null;

  const terrainLabel =
    domainMeta?.terrainType &&
    ((world.terrains || []).find((t) => t.id === domainMeta.terrainId) ??
      (world.terrains || []).find((t) => t.terrainType === domainMeta.terrainType));

  const isSeaDomain = domainMeta?.terrainType === "sea";

  const memberDomains =
    selection.level === "province" && provinceMeta
      ? provinceMeta.domaines
          .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
          .filter(Boolean)
          .slice()
          .sort((a, b) => a!.name.localeCompare(b!.name))
      : [];

  const memberProvinces =
    selection.level === "royaume" && kingdomMeta
      ? (() => {
          const fromIds = (kingdomMeta.provinces || [])
            .map((id) => (world.provinces || []).find((p) => p.id === id))
            .filter(Boolean);
          const list =
            fromIds.length > 0
              ? fromIds
              : (world.provinces || []).filter((p) => p.royaumeId === kingdomMeta.id);
          return list.slice().sort((a, b) => a!.name.localeCompare(b!.name));
        })()
      : [];

  const realmDomainsForManpower =
    selection.level === "royaume" && kingdomMeta
      ? kingdomMeta.domaines
          .map((id) => world.domaines.find((d) => d.id === id) ?? world.domaines[id])
          .filter(Boolean)
      : [];

  const accent =
    level === "terrain" && domainMeta?.terrainType
      ? TERRAIN_PALETTE[domainMeta.terrainType]
      : level === "economy" && domainMeta?.development != null
        ? developmentColor(domainMeta.development)
        : info.color;

  const filterLabel =
    level === "terrain"
      ? "Terrain"
      : level === "economy"
        ? "Economy"
        : level === "opinion"
          ? "Opinion"
          : info.level;

  const domainManpower =
    selection.level === "domaine" && domainMeta && !isSeaDomain ? sumManpower([domainMeta]) : null;

  const siegeArmy =
    selection.level === "domaine" && domainMeta && game
      ? game.armies.find((a) => a.stance === "sieging" && a.domainId === domainMeta.id)
      : null;
  const siegeAttacker =
    siegeArmy != null
      ? (world.possessions || []).find((p) => p.id === siegeArmy.ownerId)
      : null;
  const siegeFrac =
    siegeArmy != null
      ? Math.max(0, Math.min(1, (siegeArmy.siegeProgress ?? 0) / (siegeArmy.siegeDays ?? 1)))
      : 0;
  const siegeStalled =
    siegeArmy != null && domainMeta != null && siegeArmy.troops < siegeDefenseStrength(domainMeta);
  const groupManpower =
    selection.level === "province" && memberDomains.length
      ? sumManpower(memberDomains)
      : selection.level === "royaume" && realmDomainsForManpower.length
        ? sumManpower(realmDomainsForManpower)
        : null;

  function openDomain(id: number) {
    onLevelChange("domaine");
    onSelect({ level: "domaine", id });
  }
  function openProvince(id: number) {
    onLevelChange("province");
    onSelect({ level: "province", id });
  }
  function openKingdom(id: number) {
    onLevelChange("royaume");
    onSelect({ level: "royaume", id });
  }
  function openPossession(id: number) {
    onLevelChange("possession");
    onSelect({ level: "possession", id });
  }

  const subtitle =
    level === "terrain" && terrainLabel
      ? terrainLabel.name
      : level === "economy" && domainMeta?.development != null
        ? `Development ${domainMeta.development} / 100`
        : info.title && level !== "economy"
          ? info.title
          : null;

  const showBuildings = selection.level === "domaine" && !isSeaDomain;

  const player =
    game?.playerId != null
      ? (world.possessions || []).find((p) => p.id === game.playerId)
      : null;
  const canGrant =
    !!game &&
    game.phase === "play" &&
    !!onGrant &&
    selection.level === "domaine" &&
    !!player &&
    domainMeta != null &&
    domainMeta.possessionId === player.id;
  const grantNew = canGrant ? previewGrantDomain(game!, selection.id, null) : null;
  const playerVassals = canGrant
    ? (player!.vassalIds || [])
        .map((id) => (world.possessions || []).find((p) => p.id === id))
        .filter(Boolean)
    : [];

  const fabricatePreview =
    !!game &&
    game.phase === "play" &&
    !!onFabricateClaim &&
    selection.level === "domaine" &&
    !!player
      ? previewFabricateDomainClaim(game, selection.id)
      : null;
  const fabProgress =
    game?.phase === "play" && player && selection.level === "domaine"
      ? (game.claimFabrications || []).find(
          (f) => f.actorId === player.id && f.domainId === selection.id,
        )
      : null;
  const hasReadyClaim =
    !!player &&
    selection.level === "domaine" &&
    (player.domainClaims || []).includes(selection.id);
  const claimWarTargetId =
    hasReadyClaim && domainMeta?.possessionId != null
      ? domainMeta.possessionId
      : null;
  const claimWarPreview =
    claimWarTargetId != null && game?.phase === "play"
      ? previewAction(game, claimWarTargetId, "war")
      : null;

  const contextRows: { label: string; value: string; onClick?: () => void }[] = [];
  if (selection.level === "domaine" && terrainLabel) {
    contextRows.push({ label: "Terrain", value: terrainLabel.name });
  }
  if (selection.level === "domaine" && domainMeta?.development != null && !isSeaDomain) {
    contextRows.push({ label: "Development", value: `${domainMeta.development} / 100` });
  }
  if (selection.level === "domaine" && domainMeta && !isSeaDomain) {
    contextRows.push({
      label: "Income",
      value: `+${formatGold(domainMonthlyIncome(domainMeta))} / month`,
    });
  }
  if (selection.level === "domaine" && possessionMeta) {
    contextRows.push({
      label: "Holder",
      value: possessionMeta.holderName,
      onClick: () => openPossession(possessionMeta.id),
    });
  }
  if (selection.level === "domaine" && provinceMeta) {
    contextRows.push({
      label: "Province",
      value: provinceMeta.name,
      onClick: () => openProvince(provinceMeta.id),
    });
  }
  if ((selection.level === "domaine" || selection.level === "province") && kingdomMeta) {
    contextRows.push({
      label: "Realm",
      value: kingdomMeta.name,
      onClick: () => openKingdom(kingdomMeta.id),
    });
  }

  if (selection.level === "province" && provinceMeta && game?.titles) {
    const title = findProvinceTitle(game.titles, provinceMeta.id);
    if (title) {
      const holder =
        title.holderId != null
          ? (world.possessions || []).find((p) => p.id === title.holderId)
          : null;
      contextRows.push({
        label: "Title",
        value: holder ? holder.holderName : "Vacant",
        onClick: holder ? () => openPossession(holder.id) : undefined,
      });

      const claimants = (world.possessions || []).filter(
        (p) =>
          (p.claims || []).some((c) => c.titleId === title.id) &&
          p.id !== title.holderId,
      );
      if (claimants.length === 1) {
        contextRows.push({
          label: "Claim",
          value: claimants[0].holderName,
          onClick: () => openPossession(claimants[0].id),
        });
      } else if (claimants.length > 1) {
        contextRows.push({
          label: "Claims",
          value: claimants.map((c) => c.holderName).join(", "),
        });
      } else {
        contextRows.push({
          label: "Claims",
          value: "None",
        });
      }
    }
  }

  if (selection.level === "province" && provinceMeta && game?.kingdomDrifts?.length) {
    const drift = game.kingdomDrifts.find((d) =>
      d.provinceIds.includes(provinceMeta.id),
    );
    if (drift) {
      const newRoy = (world.royaumes || []).find((r) => r.id === drift.royaumeId);
      const yearsLeft = Math.max(0, drift.dueYear - game.year);
      contextRows.push({
        label: "Drift",
        value: `→ ${newRoy?.name ?? "?"} in ~${yearsLeft}y`,
        onClick: newRoy ? () => openKingdom(newRoy.id) : undefined,
      });
    }
  }

  if (selection.level === "royaume" && kingdomMeta && game?.titles) {
    const title = findKingdomTitle(game.titles, kingdomMeta.id);
    const holder =
      title?.holderId != null
        ? (world.possessions || []).find((p) => p.id === title.holderId)
        : null;
    contextRows.push({
      label: "Title",
      value: holder ? holder.holderName : "Vacant",
      onClick: holder ? () => openPossession(holder.id) : undefined,
    });

    const claimants = title
      ? (world.possessions || []).filter(
          (p) =>
            (p.claims || []).some((c) => c.titleId === title.id) &&
            p.id !== title.holderId,
        )
      : [];
    if (claimants.length === 1) {
      contextRows.push({
        label: "Claim",
        value: claimants[0].holderName,
        onClick: () => openPossession(claimants[0].id),
      });
    } else if (claimants.length > 1) {
      contextRows.push({
        label: "Claims",
        value: claimants.map((c) => c.holderName).join(", "),
      });
    } else {
      contextRows.push({
        label: "Claims",
        value: "None",
      });
    }
  }

  if (selection.level === "royaume" && kingdomMeta && game?.kingdomDrifts?.length) {
    const drift = game.kingdomDrifts.find((d) => d.royaumeId === kingdomMeta.id);
    if (drift) {
      const yearsLeft = Math.max(0, drift.dueYear - game.year);
      const provNames = drift.provinceIds
        .map((pid) => (world.provinces || []).find((p) => p.id === pid)?.name)
        .filter(Boolean)
        .join(", ");
      contextRows.push({
        label: "Drift",
        value: `${provNames} in ~${yearsLeft}y`,
      });
    }
  }

  const provinceClaimCheck =
    selection.level === "province" &&
    provinceMeta &&
    game?.phase === "play" &&
    player &&
    onClaimProvince
      ? canUsurpProvinceTitle(game.world, game.titles || [], player, provinceMeta.id)
      : null;
  const provinceGoldCost = provinceClaimCheck?.ok
    ? provinceTitleGoldCost(provinceClaimCheck.control)
    : 0;
  const provincePrestigeGain = provinceClaimCheck?.ok
    ? provinceTitlePrestigeGain(provinceClaimCheck.control)
    : 0;
  const canAffordProvinceClaim =
    !!player && provinceClaimCheck?.ok
      ? getGold(player) >= provinceGoldCost
      : false;

  const kingdomClaimCheck =
    selection.level === "royaume" &&
    kingdomMeta &&
    game?.phase === "play" &&
    player &&
    onClaimKingdom
      ? canUsurpKingdomTitle(game.world, game.titles || [], player, kingdomMeta.id)
      : null;
  const kingdomGoldCost = kingdomClaimCheck?.ok
    ? kingdomTitleGoldCost(kingdomClaimCheck.control)
    : 0;
  const kingdomPrestigeGain = kingdomClaimCheck?.ok
    ? kingdomTitlePrestigeGain(kingdomClaimCheck.control)
    : 0;
  const canAffordKingdomClaim =
    !!player && kingdomClaimCheck?.ok
      ? getGold(player) >= kingdomGoldCost
      : false;

  const canRenameKingdom =
    selection.level === "royaume" &&
    !!kingdomMeta &&
    game?.phase === "play" &&
    !!player &&
    !!onRenameKingdom &&
    (() => {
      const title = game?.titles ? findKingdomTitle(game.titles, kingdomMeta.id) : undefined;
      return title
        ? title.holderId === player.id
        : player.rank === "king" && player.royaumeId === kingdomMeta.id;
    })();

  const foundKingdomCheck =
    selection.level === "province" &&
    provinceMeta &&
    game?.phase === "play" &&
    player &&
    onFoundKingdom
      ? canFoundImaginaryKingdom(game.world, game.titles || [], player, provinceMeta.id)
      : null;
  const foundKingdomControl = foundKingdomCheck?.ok
    ? fullControlFromDomains(foundKingdomCheck.domainIds ?? [])
    : null;
  const foundKingdomGoldCost = foundKingdomControl
    ? kingdomTitleGoldCost(foundKingdomControl)
    : 0;
  const foundKingdomPrestigeGain = foundKingdomControl
    ? kingdomTitlePrestigeGain(foundKingdomControl)
    : 0;
  const canAffordFoundKingdom =
    !!player && foundKingdomCheck?.ok
      ? getGold(player) >= foundKingdomGoldCost
      : false;
  const foundKingdomProvinceNames =
    foundKingdomCheck?.ok && foundKingdomCheck.provinceIds
      ? foundKingdomCheck.provinceIds
          .map((pid) => (world.provinces || []).find((p) => p.id === pid)?.name)
          .filter(Boolean)
          .join(", ")
      : "";

  const primaryPop = domainManpower?.population ?? groupManpower?.population;
  const primaryLevies = domainManpower?.levies ?? groupManpower?.levies;
  const primaryIncome =
    selection.level === "domaine" && domainMeta
      ? isSeaDomain
        ? null
        : domainMonthlyIncome(domainMeta)
      : memberDomains.length
        ? memberDomains.reduce((s, d) => s + domainMonthlyIncome(d!), 0)
        : realmDomainsForManpower.length
          ? realmDomainsForManpower.reduce((s, d) => s + domainMonthlyIncome(d!), 0)
          : null;
  const footParts: string[] = [];
  if (domainMeta?.areaKm2 != null) {
    footParts.push(`${formatCount(Math.round(domainMeta.areaKm2))} km²`);
  }

  return (
    <div
      className="selection-card"
      role="dialog"
      aria-label={info.name}
      style={{ ["--selection-accent" as string]: accent }}
    >
      <div className="selection-card-accent" aria-hidden />

      <div className="selection-card-body">
        <header className="selection-card-header">
          <div className="selection-card-heading">
            <div className="selection-card-level">{filterLabel}</div>
            <h2>
              {info.name}
              {info.code ? <span className="dept-code"> ({info.code})</span> : null}
            </h2>
            {subtitle ? <p className="selection-card-sub">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="selection-card-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </header>

        {canRenameKingdom && kingdomMeta && (
          <form
            className="selection-rename-kingdom"
            onSubmit={(e) => {
              e.preventDefault();
              const name = renameValue.trim();
              if (name) onRenameKingdom?.(kingdomMeta.id, name);
              setRenameValue("");
            }}
          >
            <input
              type="text"
              placeholder={`Rename ${kingdomMeta.name}…`}
              maxLength={40}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
            <button type="submit" disabled={!renameValue.trim()}>
              Rename
            </button>
          </form>
        )}

        {provinceClaimCheck?.ok && (
          <div className="selection-actions">
            <div className="selection-actions-meta">
              Take the province title (−{formatGold(provinceGoldCost)} gold, +
              {formatPrestige(provincePrestigeGain)} prestige)
              {!canAffordProvinceClaim
                ? ` — need ${formatGold(provinceGoldCost)} gold, have ${formatGold(getGold(player!))}`
                : ""}
            </div>
            <button
              type="button"
              className="selection-action-btn primary"
              disabled={!onClaimProvince || !canAffordProvinceClaim}
              title={!canAffordProvinceClaim ? "Not enough gold" : undefined}
              onClick={() => onClaimProvince?.(selection.id)}
            >
              Claim province · −{formatGold(provinceGoldCost)} · +
              {formatPrestige(provincePrestigeGain)}
            </button>
          </div>
        )}

        {kingdomClaimCheck?.ok && (
          <div className="selection-actions">
            <div className="selection-actions-meta">
              Take the kingdom title (−{formatGold(kingdomGoldCost)} gold, +
              {formatPrestige(kingdomPrestigeGain)} prestige)
              {!canAffordKingdomClaim
                ? ` — need ${formatGold(kingdomGoldCost)} gold, have ${formatGold(getGold(player!))}`
                : ""}
            </div>
            <button
              type="button"
              className="selection-action-btn primary"
              disabled={!onClaimKingdom || !canAffordKingdomClaim}
              title={!canAffordKingdomClaim ? "Not enough gold" : undefined}
              onClick={() => onClaimKingdom?.(selection.id)}
            >
              Claim kingdom · −{formatGold(kingdomGoldCost)} · +
              {formatPrestige(kingdomPrestigeGain)}
            </button>
          </div>
        )}

        {foundKingdomCheck?.ok && (
          <div className="selection-actions">
            <div className="selection-actions-meta">
              Found a kingdom from {foundKingdomProvinceNames} (−
              {formatGold(foundKingdomGoldCost)} gold, +
              {formatPrestige(foundKingdomPrestigeGain)} prestige) — these
              provinces join immediately, taken from their current realm
              {!canAffordFoundKingdom
                ? ` — need ${formatGold(foundKingdomGoldCost)} gold, have ${formatGold(getGold(player!))}`
                : ""}
            </div>
            <button
              type="button"
              className="selection-action-btn primary"
              disabled={!onFoundKingdom || !canAffordFoundKingdom}
              title={!canAffordFoundKingdom ? "Not enough gold" : undefined}
              onClick={() => onFoundKingdom?.(selection.id)}
            >
              Found kingdom · −{formatGold(foundKingdomGoldCost)} · +
              {formatPrestige(foundKingdomPrestigeGain)}
            </button>
          </div>
        )}

        {canGrant && grantNew && (
          <div className="selection-actions">
            {demesneOverage(player!) > 0 && (
              <div className="selection-actions-meta">
                Demesne {demesneCount(player!)}/{DEMESNE_LIMIT} · −
                {demesnePenaltyPercent(player!)}% income & levies — grant domains to vassals
              </div>
            )}
            <button
              type="button"
              className="selection-action-btn primary"
              disabled={!grantNew.ok}
              title={grantNew.reason}
              onClick={() => onGrant?.(selection.id, null)}
            >
              Create vassal (enfeoff)
            </button>
            {playerVassals.length > 0 && (
              <label className="selection-grant-select-wrap">
                <span className="sr-only">Grant to existing vassal</span>
                <select
                  className="selection-grant-select"
                  defaultValue=""
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) return;
                    const vid = Number(raw);
                    e.target.value = "";
                    if (!Number.isFinite(vid)) return;
                    onGrant?.(selection.id, vid);
                  }}
                >
                  <option value="" disabled>
                    Grant to vassal…
                  </option>
                  {playerVassals.map((v) => {
                    const g = previewGrantDomain(game!, selection.id, v!.id);
                    return (
                      <option key={v!.id} value={v!.id} disabled={!g?.ok}>
                        {v!.holderName}
                        {!g?.ok && g?.reason ? ` (${g.reason})` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
          </div>
        )}

        {(fabProgress || fabricatePreview || hasReadyClaim) && (
          <div className="selection-actions">
            {fabProgress && (
              <>
                <div className="selection-actions-meta">
                  Claiming… {fabProgress.daysElapsed}/{fabProgress.daysRequired}{" "}
                  days (−{formatGold(fabProgress.goldPaid)} paid)
                </div>
                <button
                  type="button"
                  className="selection-action-btn"
                  disabled={!onCancelFabricateClaim}
                  onClick={() => onCancelFabricateClaim?.(selection.id)}
                >
                  Cancel claim · +{formatGold(fabProgress.goldPaid)} refund
                </button>
              </>
            )}
            {!fabProgress && fabricatePreview && (
              <>
                <div className="selection-actions-meta">
                  {fabricatePreview.ok
                    ? `Claim takes ~${fabricatePreview.daysRequired} days · +${formatPrestige(fabricatePreview.prestigeGain)} prestige${
                        fabricatePreview.warDefenderName
                          ? ` · war vs ${fabricatePreview.warDefenderName}`
                          : fabricatePreview.holderName
                            ? ` · vs ${fabricatePreview.holderName}`
                            : ""
                      }`
                    : fabricatePreview.reason}
                </div>
                <button
                  type="button"
                  className="selection-action-btn"
                  disabled={!fabricatePreview.ok || !onFabricateClaim}
                  title={fabricatePreview.reason}
                  onClick={() => onFabricateClaim?.(selection.id)}
                >
                  Claim domain · −{formatGold(fabricatePreview.goldCost)}
                </button>
              </>
            )}
            {hasReadyClaim && claimWarTargetId != null && (
              <>
                <div className="selection-actions-meta">
                  Claim ready
                  {claimWarPreview?.redirectedToName
                    ? ` · war vs ${claimWarPreview.redirectedToName}`
                    : claimWarPreview?.claimTitleName
                      ? ` · ${claimWarPreview.claimTitleName}`
                      : ""}
                </div>
                <button
                  type="button"
                  className="selection-action-btn primary"
                  disabled={!claimWarPreview?.ok || !onWar}
                  title={claimWarPreview?.reason}
                  onClick={() => onWar?.(claimWarTargetId)}
                >
                  {claimWarPreview?.redirectedToName
                    ? `Press claim vs ${claimWarPreview.redirectedToName}`
                    : "Press claim"}
                </button>
              </>
            )}
          </div>
        )}

        {(primaryLevies != null || primaryPop != null || primaryIncome != null) && (
          <div className="selection-manpower">
            {primaryIncome != null ? (
              <div className="selection-manpower-main">
                <span className="selection-manpower-value">+{formatGold(primaryIncome)}</span>
                <span className="selection-manpower-label">
                  Income
                  <span className="selection-manpower-note"> / month</span>
                </span>
              </div>
            ) : primaryLevies != null ? (
              <div className="selection-manpower-main">
                <span className="selection-manpower-value">{formatCount(primaryLevies)}</span>
                <span className="selection-manpower-label">
                  Levies
                  {domainManpower ? (
                    <span className="selection-manpower-note">
                      {" "}
                      · {Math.round(LEVY_RATE * 100)}%
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}
            {primaryLevies != null && primaryIncome != null ? (
              <div className="selection-manpower-side">
                <span className="selection-manpower-side-value">{formatCount(primaryLevies)}</span>
                <span className="selection-manpower-side-label">Levies</span>
              </div>
            ) : primaryPop != null ? (
              <div className="selection-manpower-side">
                <span className="selection-manpower-side-value">{formatCount(primaryPop)}</span>
                <span className="selection-manpower-side-label">Population</span>
              </div>
            ) : null}
          </div>
        )}

        {showBuildings && (
          <section className="selection-buildings" aria-label="Buildings">
            <div className="selection-buildings-label">Buildings</div>
            <div className="selection-building-slots">
              {Array.from({ length: BUILDING_SLOT_COUNT }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className="selection-building-slot"
                  aria-label={`Building slot ${i + 1}`}
                  title="Coming soon"
                  disabled
                >
                  <Plus size={14} strokeWidth={1.75} aria-hidden />
                </button>
              ))}
            </div>
          </section>
        )}

        {siegeArmy && (
          <div className="selection-siege">
            <div className="selection-siege-header">
              <span>Siege by {siegeAttacker?.holderName ?? "Unknown"}</span>
              <span className="selection-siege-days">
                {Math.floor(siegeArmy.siegeProgress ?? 0)} / {siegeArmy.siegeDays ?? "?"}d
              </span>
            </div>
            <div className="selection-siege-bar">
              <div
                className="selection-siege-bar-fill"
                style={{ width: `${siegeFrac * 100}%` }}
              />
            </div>
            {siegeStalled && (
              <div className="selection-siege-stalled">
                Not enough troops to press the siege — reinforcements needed.
              </div>
            )}
          </div>
        )}

        {contextRows.length > 0 && (
          <div className="selection-context">
            {contextRows.map((row) =>
              row.onClick ? (
                <button
                  key={row.label}
                  type="button"
                  className="selection-context-row is-link"
                  onClick={row.onClick}
                >
                  <span className="selection-context-label">{row.label}</span>
                  <span className="selection-context-value">{row.value}</span>
                </button>
              ) : (
                <div key={row.label} className="selection-context-row">
                  <span className="selection-context-label">{row.label}</span>
                  <span className="selection-context-value">{row.value}</span>
                </div>
              ),
            )}
          </div>
        )}

        {selection.level === "royaume" && memberProvinces.length > 0 && (
          <CollapsibleSection title="Provinces" count={memberProvinces.length}>
            <ul>
              {memberProvinces.map((p) => (
                <li key={p!.id}>
                  <button type="button" onClick={() => openProvince(p!.id)}>
                    <span>{p!.name}</span>
                    <span className="selection-list-aside">{p!.domaines.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        {selection.level === "province" && memberDomains.length > 0 && (
          <CollapsibleSection title="Domains" count={memberDomains.length}>
            <ul>
              {memberDomains.map((d) => (
                <li key={d!.id}>
                  <button type="button" onClick={() => openDomain(d!.id)}>
                    {d!.name}
                  </button>
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        )}

        {footParts.length > 0 && (
          <footer className="selection-card-foot">{footParts.join(" · ")}</footer>
        )}
      </div>
    </div>
  );
}
