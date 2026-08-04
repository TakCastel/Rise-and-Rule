import { domainById, warSideOf } from "../game/army";
import type { GameState } from "../game/types";

/** Bandeau bas-centre : progression en direct des batailles impliquant le joueur (belligérant ou allié engagé). */
export function BattleOverlay({ game }: { game: GameState }) {
  const playerId = game.playerId;
  if (playerId == null) return null;
  const battling = game.armies.filter((a) => a.stance === "battling");
  if (!battling.length) return null;

  const byKey = new Map<string, typeof battling>();
  for (const a of battling) {
    const key = `${a.domainId}:${a.warId}`;
    const list = byKey.get(key) ?? [];
    list.push(a);
    byKey.set(key, list);
  }

  const battles: {
    key: string;
    domainName: string;
    mineTroops: number;
    theirsTroops: number;
    theirsName: string;
  }[] = [];

  for (const [key, armies] of byKey) {
    const war = game.wars.find((w) => w.id === armies[0].warId);
    if (!war) continue;
    const mySide = warSideOf(war, playerId);
    if (!mySide) continue;

    const mine = armies.filter((a) => warSideOf(war, a.ownerId) === mySide);
    const theirs = armies.filter((a) => warSideOf(war, a.ownerId) !== mySide);
    if (!mine.length || !theirs.length) continue;

    const domain = domainById(game.world, armies[0].domainId);
    battles.push({
      key,
      domainName: domain?.name ?? "?",
      mineTroops: mine.reduce((s, a) => s + a.troops, 0),
      theirsTroops: theirs.reduce((s, a) => s + a.troops, 0),
      theirsName: mySide === "attacker" ? war.defenderName : war.attackerName,
    });
  }

  if (!battles.length) return null;

  return (
    <div id="battle-overlay">
      {battles.map((b) => {
        const total = b.mineTroops + b.theirsTroops;
        const pct = total > 0 ? Math.round((b.mineTroops / total) * 100) : 50;
        return (
          <div key={b.key} className="battle-card">
            <div className="battle-card-title">Battle at {b.domainName}</div>
            <div className="battle-card-troops">
              <span>You · {b.mineTroops.toLocaleString()}</span>
              <span>{b.theirsName} · {b.theirsTroops.toLocaleString()}</span>
            </div>
            <div className="battle-card-bar">
              <div
                className={`battle-card-bar-fill ${pct >= 50 ? "positive" : "negative"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
