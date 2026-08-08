import { useState } from "react";
import { domainById, siegeDefenseStrength } from "../game/army";
import type { GameState } from "../game/types";
import { findPossession } from "../game/war";

export function ArmyPanel({
  game,
  armyId,
  onSplit,
  onMerge,
  onClose,
}: {
  game: GameState;
  armyId: number;
  onSplit: (armyId: number, troops: number) => void;
  onMerge: (armyIds: number[]) => void;
  onClose: () => void;
}) {
  const [splitAmount, setSplitAmount] = useState(0);
  const army = game.armies.find((a) => a.id === armyId);
  if (!army) return null;

  const owner = findPossession(game.world, army.ownerId);
  const domain = domainById(game.world, army.domainId);
  const mergeable =
    army.stance === "idle"
      ? game.armies.filter(
          (a) =>
            a.id !== army.id &&
            a.ownerId === army.ownerId &&
            a.domainId === army.domainId &&
            a.stance === "idle",
        )
      : [];

  return (
    <div className="army-panel">
      <div className="army-panel-header">
        <span>{owner?.holderName ?? "Army"}</span>
        <button type="button" className="army-panel-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="army-panel-body">
        <div className="army-panel-row">
          <span>{army.troops.toLocaleString()} troops</span>
          <span className="army-panel-muted">{domain?.name ?? "?"}</span>
        </div>
        {army.stance !== "sieging" && (
          <div className="army-panel-row army-panel-muted">
            {army.stance === "idle" && "Idle — right-click a domain to march"}
            {army.stance === "moving" && "Marching — right-click a domain to redirect"}
            {army.stance === "battling" && "In battle"}
            {army.stance === "routing" && "Routed — fleeing, cannot be ordered until it regroups"}
          </div>
        )}
      </div>
      {army.stance === "sieging" && domain && (
        <div className="selection-siege">
          <div className="selection-siege-header">
            <span>Sieging {domain.name}</span>
            <span className="selection-siege-days">
              {Math.floor(army.siegeProgress ?? 0)} / {army.siegeDays ?? "?"}d
            </span>
          </div>
          <div className="selection-siege-bar">
            <div
              className="selection-siege-bar-fill"
              style={{
                width: `${Math.max(0, Math.min(1, (army.siegeProgress ?? 0) / (army.siegeDays ?? 1))) * 100}%`,
              }}
            />
          </div>
          {army.troops < siegeDefenseStrength(domain) && (
            <div className="selection-siege-stalled">
              Not enough troops to press the siege — reinforcements needed.
            </div>
          )}
        </div>
      )}
      {army.stance === "idle" && (
        <div className="army-panel-actions">
          <input
            type="number"
            min={1}
            max={Math.max(1, army.troops - 1)}
            value={splitAmount || ""}
            onChange={(e) => setSplitAmount(Number(e.target.value))}
            placeholder="Split troops"
          />
          <button
            type="button"
            disabled={splitAmount <= 0 || splitAmount >= army.troops}
            onClick={() => {
              onSplit(army.id, splitAmount);
              setSplitAmount(0);
            }}
          >
            Split
          </button>
        </div>
      )}
      {mergeable.length > 0 && (
        <div className="army-panel-merge">
          {mergeable.map((m) => (
            <button type="button" key={m.id} onClick={() => onMerge([army.id, m.id])}>
              Merge with {m.troops.toLocaleString()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
