import { domainById, warSideOf } from "../game/army";
import { canPressDemands, canRequestWhitePeace, warScorePercent } from "../game/army-actions";
import type { GameState, WarState } from "../game/types";

/** Motif de la guerre, en clair, pour l'onglet Guerre — pourquoi on se bat. */
function warCauseLabel(game: GameState, war: WarState): string {
  const cb = war.casusBelli ?? "claim_province";
  if (cb === "vassalize") return "Forced submission — losing makes you their vassal";
  if (cb === "depose") return "Bid to depose their liege";
  if (cb === "independence") return "Bid for independence";
  if (cb === "conquest") return "Conquest";

  if (war.claimTitleId) {
    const title = (game.titles || []).find((t) => t.id === war.claimTitleId);
    if (title) return `Claim on ${title.name}`;
  }
  if (war.warGoalDomainIds?.length) {
    return war.warGoalDomainIds.length === 1
      ? "Claim on a domain"
      : `Claim on ${war.warGoalDomainIds.length} domains`;
  }
  return "Territorial claim";
}

function warStatusLine(game: GameState, war: WarState): string {
  const armies = game.armies.filter((a) => a.warId === war.id);
  if (!armies.length) return "No armies raised yet.";
  const parts: string[] = [];

  const moving = armies.filter((a) => a.stance === "moving").length;
  if (moving) parts.push(`${moving} marching`);

  for (const a of armies.filter((x) => x.stance === "sieging")) {
    const d = domainById(game.world, a.domainId);
    parts.push(
      `siege of ${d?.name ?? "?"} (${Math.floor(a.siegeProgress ?? 0)}/${a.siegeDays ?? "?"}d)`,
    );
  }

  const battling = armies.filter((a) => a.stance === "battling");
  if (battling.length) {
    const attackerTroops = battling
      .filter((a) => warSideOf(war, a.ownerId) === "attacker")
      .reduce((s, a) => s + a.troops, 0);
    const defenderTroops = battling
      .filter((a) => warSideOf(war, a.ownerId) === "defender")
      .reduce((s, a) => s + a.troops, 0);
    parts.push(`battle: ${attackerTroops.toLocaleString()} vs ${defenderTroops.toLocaleString()}`);
  }

  const idle = armies.filter((a) => a.stance === "idle").length;
  if (idle) parts.push(`${idle} awaiting orders`);

  const routing = armies.filter((a) => a.stance === "routing").length;
  if (routing) parts.push(`${routing} routed and fleeing`);

  return parts.length ? parts.join(" · ") : "Armies in the field.";
}

export function WarPanel({
  game,
  focusWarId,
  onClose,
  onRaiseLevies,
  onSurrender,
  onWhitePeace,
  onPressDemands,
}: {
  game: GameState;
  focusWarId?: number | null;
  onClose: () => void;
  onRaiseLevies: (warId: number) => void;
  onSurrender: (warId: number) => void;
  onWhitePeace: (warId: number) => void;
  onPressDemands: (warId: number) => void;
}) {
  const playerId = game.playerId;
  // Une armée déjà levée (pour n'importe laquelle de mes guerres) engage
  // déjà tous mes fronts à la fois — pas besoin d'en relever une par guerre.
  const hasAnyArmy = game.armies.some((a) => a.ownerId === playerId);
  const allWars =
    playerId == null
      ? []
      : game.wars.filter((w) => w.attackerId === playerId || w.defenderId === playerId);
  if (!allWars.length) return null;
  // Une icône de guerre précise a été cliquée : le volet ne montre que cette
  // guerre-là, pas toutes cumulées — un icône, une guerre, un volet.
  const wars = focusWarId != null ? allWars.filter((w) => w.id === focusWarId) : allWars;
  if (!wars.length) return null;

  return (
    <div className="war-panel">
      <div className="war-panel-header">
        <span>Wars</span>
        <button type="button" className="war-panel-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {wars.map((w) => {
        const enemyName = w.attackerId === playerId ? w.defenderName : w.attackerName;
        const press = canPressDemands(game, w, playerId!);
        const peace = canRequestWhitePeace(game, w, playerId!);
        const score = warScorePercent(game, w, playerId!);
        const isBattling = game.armies.some((a) => a.warId === w.id && a.stance === "battling");
        const isFocused = focusWarId === w.id;

        return (
          <div
            key={w.id}
            className={`war-panel-card${isBattling ? " is-battling" : ""}${isFocused ? " is-focused" : ""}`}
          >
            <div className="war-panel-title">vs {enemyName}</div>
            <div className="war-panel-cause">{warCauseLabel(game, w)}</div>
            <div className="war-panel-status">{warStatusLine(game, w)}</div>
            <div className="war-panel-score">
              <div className="war-panel-score-mid" />
              <div
                className={`war-panel-score-fill ${score >= 0 ? "positive" : "negative"}`}
                style={
                  score >= 0
                    ? { left: "50%", width: `${Math.min(50, score / 2)}%` }
                    : { left: `${50 + Math.max(-50, score / 2)}%`, width: `${Math.min(50, -score / 2)}%` }
                }
              />
            </div>
            <div className={`war-panel-score-label ${score >= 0 ? "positive" : "negative"}`}>
              {score > 0 ? "+" : ""}
              {score}%
            </div>
            <div className="war-panel-actions">
              {!hasAnyArmy && (
                <button type="button" onClick={() => onRaiseLevies(w.id)}>
                  Raise levies
                </button>
              )}
              <button type="button" onClick={() => onSurrender(w.id)}>
                Surrender
              </button>
              <button
                type="button"
                disabled={!peace.ok}
                title={peace.reason}
                onClick={() => onWhitePeace(w.id)}
              >
                White peace
              </button>
              <button
                type="button"
                disabled={!press.ok}
                title={press.reason}
                onClick={() => onPressDemands(w.id)}
              >
                Press demands
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
