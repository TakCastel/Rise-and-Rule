import { Swords } from "lucide-react";
import { warScorePercent } from "../game/army-actions";
import type { GameState } from "../game/types";

const RING_SIZE = 62;
const RING_STROKE = 3.5;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

/** Anneau de progression autour du bouton : sens horaire vert si le score est positif, antihoraire rouge sinon. */
function WarScoreRing({ percent }: { percent: number }) {
  const clamped = Math.max(-100, Math.min(100, Math.round(percent)));
  const frac = Math.abs(clamped) / 100;
  const positive = clamped >= 0;
  const offset = RING_C * (1 - frac);

  return (
    <svg
      className={`war-icon-ring ${positive ? "positive" : "negative"}`}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_R}
        fill="none"
        className="war-icon-ring-track"
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_R}
        fill="none"
        className="war-icon-ring-fill"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={offset}
        style={{
          transform: positive ? "rotate(-90deg)" : "rotate(-90deg) scaleX(-1)",
          transformOrigin: "50% 50%",
        }}
      />
    </svg>
  );
}

/**
 * Une icône par guerre (pas une moyenne agrégée) — chacune affiche l’anneau
 * de progression propre à ce conflit précis. Cliquer une icône ouvre le
 * panneau de guerres en mettant celle-ci en avant.
 */
export function WarIcon({
  game,
  focusWarId,
  onSelectWar,
}: {
  game: GameState;
  focusWarId: number | null;
  onSelectWar: (warId: number) => void;
}) {
  const playerId = game.playerId;
  const wars =
    playerId == null
      ? []
      : game.wars.filter((w) => w.attackerId === playerId || w.defenderId === playerId);
  if (!wars.length) return null;

  return (
    <div className="war-icon-stack">
      {wars.map((w) => {
        const enemyName = w.attackerId === playerId ? w.defenderName : w.attackerName;
        const score = warScorePercent(game, w, playerId!);
        const roundedScore = Math.max(-100, Math.min(100, Math.round(score)));
        const isBattling = game.armies.some((a) => a.warId === w.id && a.stance === "battling");
        return (
          <div className="war-icon-wrap" key={w.id}>
            <WarScoreRing percent={score} />
            <button
              type="button"
              className={`war-icon-btn${focusWarId === w.id ? " active" : ""}${isBattling ? " is-battling" : ""}`}
              aria-label={`War vs ${enemyName}`}
              title={`vs ${enemyName} — war score ${roundedScore > 0 ? "+" : ""}${roundedScore}%`}
              onClick={() => onSelectWar(w.id)}
            >
              <Swords size={20} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
