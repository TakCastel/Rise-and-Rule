import { formatCount } from "../lib/population";
import { allyTroopContribution } from "../game/alliance";
import {
  DEMESNE_LIMIT,
  demesneOverage,
  demesnePenaltyPercent,
} from "../game/demesne";
import { formatGold, possessionIncomeBreakdown } from "../game/economy";
import { possessionPower, possessionPowerBreakdown } from "../game/power";
import type { SaveInfo } from "../game/save";
import { formatDate } from "../game/tick";
import { isChronicleRelevant, type GameState } from "../game/types";
import { realmDisplayName, titlesHeldBy, type Title } from "../game/titles";
import type { Possession, WorldData } from "../types/world";
import { cn } from "@/lib/utils";

interface GameMenuProps {
  templateReady: boolean;
  game: GameState | null;
  player: Possession | null;
  saveAvailable: boolean;
  saveInfo: SaveInfo | null;
  saveStatus: string | null;
  playAnyone: boolean;
  hoverId: number | null;
  onSelectPlayer: (id: number) => void;
  onLoad: () => void;
  onNewGame: () => void;
  onMainMenu: () => void;
  onPlayAnyoneChange: (value: boolean) => void;
  onHover: (id: number | null) => void;
}

export function GameMenu({
  templateReady,
  game,
  player,
  saveAvailable,
  saveInfo,
  saveStatus,
  playAnyone,
  hoverId,
  onSelectPlayer,
  onLoad,
  onNewGame,
  onMainMenu,
  onPlayAnyoneChange,
  onHover,
}: GameMenuProps) {
  if (!templateReady || !game) {
    return (
      <div className="panel">
        <div className="panel-level">Menu</div>
        <h2>Strateclo</h2>
        <p className="panel-muted">Loading board…</p>
      </div>
    );
  }

  if (game.phase === "menu") {
    return (
      <MainMenuPanel
        saveAvailable={saveAvailable}
        saveInfo={saveInfo}
        saveStatus={saveStatus}
        onNewGame={onNewGame}
        onLoad={onLoad}
      />
    );
  }

  if (game.phase === "pick") {
    return (
      <PickCharacterPanel
        world={game.world}
        titles={game.titles || []}
        opinions={game.opinions}
        saveStatus={saveStatus}
        playAnyone={playAnyone}
        hoverId={hoverId}
        onPlayAnyoneChange={onPlayAnyoneChange}
        onHover={onHover}
        onSelect={onSelectPlayer}
        onBack={onMainMenu}
      />
    );
  }

  if (game.phase === "gameover") {
    return (
      <div className="panel game-menu">
        <div className="panel-level">Game over</div>
        <h2>Defeated</h2>
        <p className="panel-muted">
          {game.gameOverReason ??
            "Your rule has ended. The map remembers another victor."}
        </p>
        {player && (
          <div className="selection-context" style={{ borderTop: "none", paddingTop: 0 }}>
            <div className="selection-context-row">
              <span className="selection-context-label">Ruler</span>
              <span className="selection-context-value">{player.holderName}</span>
            </div>
            <div className="selection-context-row">
              <span className="selection-context-label">Date</span>
              <span className="selection-context-value">
                {formatDate(game.year, game.month, game.day)}
              </span>
            </div>
          </div>
        )}
        <div className="main-menu-actions" style={{ marginTop: "1rem" }}>
          <button type="button" className="selection-action-btn primary" onClick={onNewGame}>
            New game
          </button>
          <button type="button" className="selection-action-btn" onClick={onMainMenu}>
            Main menu
          </button>
        </div>
        <h3>Chronicle</h3>
        <ul className="game-log">
          {game.log.slice(0, 12).map((e) => (
            <li key={e.id}>
              <span className="game-log-year">{e.year}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const powerBreakdown = player
    ? possessionPowerBreakdown(game.world, player, game.opinions)
    : null;
  const allyLevies = player
    ? Math.round(allyTroopContribution(game.world, player, game.opinions, game.alliances))
    : 0;

  const powerLabel = powerBreakdown
    ? powerBreakdown.capacity > powerBreakdown.total
      ? `${formatCount(powerBreakdown.total)}/${formatCount(powerBreakdown.capacity)}`
      : formatCount(powerBreakdown.total)
    : "0";

  const demesneWarn =
    player && demesneOverage(player) > 0
      ? ` (−${demesnePenaltyPercent(player)}%)`
      : "";

  const chronicle = game.log.filter((e) =>
    isChronicleRelevant(game, e.involvedIds),
  );

  return (
    <div className="panel game-menu">
      <h2>{player?.holderName ?? "—"}</h2>
      {player?.title && <p className="game-menu-title">{player.title}</p>}
      {player?.name && (
        <p className="panel-muted game-menu-realm">
          {realmDisplayName(game.world, game.titles || [], player)}
        </p>
      )}

      {player && (
        <dl className="game-menu-stats">
          <div className="game-menu-stat">
            <dt>Levies</dt>
            <dd>
              {powerLabel}
              {allyLevies > 0 && (
                <span className="game-menu-stat-note">
                  {" "}
                  +{formatCount(allyLevies)} allies
                </span>
              )}
            </dd>
          </div>
          <div className="game-menu-stat">
            <dt>Demesne</dt>
            <dd>
              {player.domaines.length}/{DEMESNE_LIMIT}
              {demesneWarn}
            </dd>
          </div>
          <div className="game-menu-stat">
            <dt>Vassals</dt>
            <dd>{player.vassalIds.length}</dd>
          </div>
        </dl>
      )}

      {player && (
        <HoldingsSection
          world={game.world}
          player={player}
          titles={game.titles || []}
        />
      )}

      {saveStatus && <p className="game-save-status">{saveStatus}</p>}

      <h3>Chronicle</h3>
      {chronicle.length === 0 ? (
        <p className="panel-muted">Nothing yet.</p>
      ) : (
        <ul className="game-log">
          {chronicle.map((e) => (
            <li key={e.id}>
              <span className="game-log-year">{e.year}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Ce que le joueur possède réellement, du plus concret au plus abstrait :
 * domaines de son demesne (possession directe), puis titres de province et
 * de royaume (de jure, obtenus par contrôle > 2/3 des domaines).
 */
function HoldingsSection({
  world,
  player,
  titles,
}: {
  world: WorldData;
  player: Possession;
  titles: Title[];
}) {
  const domains = possessionIncomeBreakdown(world, player).domains;
  const held = titlesHeldBy(titles, player.id);
  const provinces = held
    .filter((t) => t.tier === "province")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const kingdoms = held.filter((t) => t.tier === "kingdom");

  return (
    <>
      <h3>Domains</h3>
      {domains.length === 0 ? (
        <p className="panel-muted">No domains held.</p>
      ) : (
        <ul className="game-menu-titles-list">
          {domains.map((d) => (
            <li key={d.id}>
              <span className="game-menu-titles-name">{d.name}</span>
              <span className="game-menu-titles-tier">
                +{formatGold(d.income)}/mo
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Provinces</h3>
      {provinces.length === 0 ? (
        <p className="panel-muted">No province titles held.</p>
      ) : (
        <ul className="game-menu-titles-list">
          {provinces.map((t) => (
            <li key={t.id}>
              <span className="game-menu-titles-name">{t.name}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Kingdoms</h3>
      {kingdoms.length === 0 ? (
        <p className="panel-muted">No kingdom title held.</p>
      ) : (
        <ul className="game-menu-titles-list">
          {kingdoms.map((t) => (
            <li key={t.id}>
              <span className="game-menu-titles-name">{t.name}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function MainMenuPanel({
  saveAvailable,
  saveInfo,
  saveStatus,
  onNewGame,
  onLoad,
}: {
  saveAvailable: boolean;
  saveInfo: SaveInfo | null;
  saveStatus: string | null;
  onNewGame: () => void;
  onLoad: () => void;
}) {
  return (
    <div className="panel game-menu">
      <div className="panel-level">Main menu</div>
      <h2>Strateclo</h2>
      <p className="panel-muted">
        Western Europe around 486. Rule a kingdom, raise levies, and reshape the map.
      </p>

      <div className="main-menu-actions">
        <button type="button" className="selection-action-btn primary" onClick={onNewGame}>
          New game
        </button>
        <button
          type="button"
          className="selection-action-btn"
          disabled={!saveAvailable}
          onClick={onLoad}
        >
          Continue
        </button>
        <button
          type="button"
          className="selection-action-btn"
          disabled={!saveAvailable}
          onClick={onLoad}
        >
          Load game
        </button>
      </div>

      {saveInfo ? (
        <p className="panel-muted main-menu-save-meta">
          Save: {saveInfo.label}
          {saveInfo.detail ? ` · ${saveInfo.detail}` : ""}
        </p>
      ) : (
        <p className="panel-muted main-menu-save-meta">No saved game yet.</p>
      )}
      {saveStatus && <p className="game-save-status">{saveStatus}</p>}
    </div>
  );
}

function PickCharacterPanel({
  world,
  titles,
  opinions,
  saveStatus,
  playAnyone,
  hoverId,
  onPlayAnyoneChange,
  onHover,
  onSelect,
  onBack,
}: {
  world: WorldData;
  titles: Title[];
  opinions: Record<string, number>;
  saveStatus: string | null;
  playAnyone: boolean;
  hoverId: number | null;
  onPlayAnyoneChange: (value: boolean) => void;
  onHover: (id: number | null) => void;
  onSelect: (id: number) => void;
  onBack: () => void;
}) {
  const list = [...(world.possessions || [])]
    .filter((p) => {
      if (playAnyone) {
        return p.rank === "king" || p.rank === "chief" || p.rank === "vassal";
      }
      return p.rank === "king";
    })
    .sort(
      (a, b) =>
        possessionPower(world, b, opinions) - possessionPower(world, a, opinions),
    );

  const top = playAnyone ? list.slice(0, 40) : list;

  return (
    <div className="panel game-menu">
      <div className="panel-level">New game</div>
      <h2>Choose ruler</h2>
      <p className="panel-muted">
        {playAnyone
          ? "All rulers are available — including minor chiefs. Hover a name to highlight their lands."
          : "Major kingdoms only. Hover a name to highlight their lands on the map."}
      </p>
      {saveStatus && <p className="game-save-status">{saveStatus}</p>}

      <label className="pick-anyone-toggle">
        <input
          type="checkbox"
          checked={playAnyone}
          onChange={(e) => onPlayAnyoneChange(e.target.checked)}
        />
        <span>Play anyone</span>
      </label>

      <ul className="panel-domain-list game-pick-list">
        {top.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={cn("panel-link", hoverId === p.id && "is-hover")}
              onClick={() => onSelect(p.id)}
              onMouseEnter={() => onHover(p.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(p.id)}
              onBlur={() => onHover(null)}
            >
              <span className="selection-person">
                <span className="selection-person-name">{p.holderName}</span>
                <span className="selection-person-title">
                  {p.title} · {realmDisplayName(world, titles, p)}
                </span>
              </span>
              <span className="selection-list-aside">
                {formatCount(possessionPower(world, p, opinions))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="panel-muted" style={{ marginTop: "0.75rem" }}>
        {playAnyone
          ? `Showing ${top.length} of ${list.length}. Use the map for anyone else.`
          : `${top.length} major rulers. Enable “Play anyone” for chiefs and vassals.`}
      </p>
      <button type="button" className="game-reset-link" onClick={onBack}>
        Back to main menu
      </button>
    </div>
  );
}
