import { useEffect, useState } from "react";
import { FolderOpen, Pause, Pencil, Play, RotateCcw, Save } from "lucide-react";
import { useGame } from "./game/useGame";
import { formatDate } from "./game/tick";
import { findKingdomTitle, realmDisplayName } from "./game/titles";
import type { GameSpeed } from "./game/types";
import { MapView } from "./map/MapView";
import {
  ALLIANCE_ALLY_COLOR,
  ALLIANCE_ENEMY_ALLY_COLOR,
  ALLIANCE_ENEMY_COLOR,
  ALLIANCE_NEUTRAL_COLOR,
  ALLIANCE_SELF_COLOR,
  ALLIANCE_VASSAL_ALLY_COLOR,
  TERRAIN_PALETTE,
  developmentColor,
  opinionColor,
  powerColor,
} from "./map/levels";
import type { LevelName, Selection, TerrainType, WorldData } from "./types/world";
import { GameMenu } from "./ui/GameMenu";
import { ActionAlerts } from "./ui/ActionAlerts";
import { LevelSelector } from "./ui/LevelSelector";
import { ResourcesBar } from "./ui/ResourcesBar";
import { ArmyPanel } from "./ui/ArmyPanel";
import { BattleOverlay } from "./ui/BattleOverlay";
import { SelectionCard } from "./ui/SelectionCard";
import { WarIcon } from "./ui/WarIcon";
import { WarPanel } from "./ui/WarPanel";
import { NoticeModal } from "./ui/NoticeModal";
import { AllegianceDemandModal } from "./ui/AllegianceDemandModal";
import { NoticeToastStack } from "./ui/NoticeToastStack";
import { cn } from "@/lib/utils";
import "./App.css";

const TERRAIN_ORDER: TerrainType[] = [
  "mountains",
  "hills",
  "forest",
  "farmland",
  "plains",
  "marsh",
  "desert",
  "scrub",
  "coast",
];

const ECONOMY_BANDS = [
  { label: "0–20", score: 10 },
  { label: "20–40", score: 30 },
  { label: "40–60", score: 50 },
  { label: "60–80", score: 70 },
  { label: "80–100", score: 90 },
];

const OPINION_BANDS = [
  { label: "Hostile", score: -80 },
  { label: "Cold", score: -40 },
  { label: "Neutral", score: 0 },
  { label: "Friendly", score: 40 },
  { label: "Allied", score: 80 },
];

function App() {
  const [template, setTemplate] = useState<WorldData | null>(null);
  const [level, setLevel] = useState<LevelName>("possession");
  const [selection, setSelection] = useState<Selection>(null);
  const [playAnyone, setPlayAnyone] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [claimFocus, setClaimFocus] = useState<Selection>(null);
  const [selectedArmyId, setSelectedArmyId] = useState<number | null>(null);
  const [focusWarId, setFocusWarId] = useState<number | null>(null);
  const [renamingRealm, setRenamingRealm] = useState(false);
  const [realmNameInput, setRealmNameInput] = useState("");
  const {
    game,
    player,
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
    doCedeProvinceTitle,
    doRebel,
    doClaimProvince,
    doClaimKingdom,
    doRenameKingdom,
    doSetFocus,
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
    doRespondAllegianceDemand,
    doDismissNotice,
  } = useGame(template);

  useEffect(() => {
    fetch("/world.json")
      .then((r) => r.json())
      .then((data: WorldData) => setTemplate(data));
  }, []);

  useEffect(() => {
    if (game?.phase !== "pick") {
      setPlayAnyone(false);
      setHoverId(null);
    }
  }, [game?.phase]);

  useEffect(() => {
    if (game?.phase !== "play") setClaimFocus(null);
  }, [game?.phase]);

  useEffect(() => {
    if (game?.phase !== "play") setRenamingRealm(false);
  }, [game?.phase]);

  // Guerre focalisée conclue → on lâche le focus, et si la vue Guerre n'a
  // plus rien à montrer (focus perdu sans guerre en cours), on repasse en
  // vue normale plutôt que de rester bloqué sur un filtre vide.
  useEffect(() => {
    if (game?.phase !== "play" || game.playerId == null) return;
    if (focusWarId != null) {
      if (!game.wars.some((w) => w.id === focusWarId)) {
        setFocusWarId(null);
        if (level === "war") setLevel("possession");
      }
      return;
    }
    if (level === "war") {
      const stillAtWar = game.wars.some(
        (w) => w.attackerId === game.playerId || w.defenderId === game.playerId,
      );
      if (!stillAtWar) setLevel("possession");
    }
  }, [focusWarId, game?.phase, game?.playerId, game?.wars, level]);

  useEffect(() => {
    if (game?.phase !== "play") return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!game!.playing);
        return;
      }
      if (e.code === "Escape") {
        e.preventDefault();
        // Même reset que cliquer l'onglet "Possession" du sélecteur de niveau.
        setLevel("possession");
        setSelection((sel) =>
          sel && (sel.level === "possession" || sel.level === "domaine") ? sel : null,
        );
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [game?.phase, game?.playing, setPlaying]);

  function changeLevel(next: LevelName) {
    setLevel(next);
    // Garder la sélection personnage/domaine pour adapter la vue Opinion
    setSelection((sel) =>
      sel && (sel.level === "possession" || sel.level === "domaine") ? sel : null,
    );
  }

  function returnToMenu() {
    goToMenu();
    setSelection(null);
    setLevel("possession");
    setPlayAnyone(false);
    setHoverId(null);
    setClaimFocus(null);
  }

  async function handleLoad() {
    const ok = await doLoad();
    if (ok) {
      setLevel("possession");
      setSelection(null);
    }
  }

  const world = game?.world ?? template;
  const inPlay = game?.phase === "play";
  const isGameOver = game?.phase === "gameover";
  const canPlayAs = game?.phase === "pick";
  const playerRoyaume =
    player?.royaumeId != null
      ? (world?.royaumes || []).find((r) => r.id === player.royaumeId)
      : null;
  const canRenameRealm =
    !!player &&
    !!playerRoyaume &&
    (() => {
      const title = game?.titles ? findKingdomTitle(game.titles, playerRoyaume.id) : undefined;
      return title
        ? title.holderId === player.id
        : player.rank === "king" && player.royaumeId === playerRoyaume.id;
    })();
  const showLegend = !selection && (inPlay || canPlayAs);
  /** Focus de la vue Opinion : personnage cliqué, sinon le joueur en partie. */
  const opinionFocusId = (() => {
    if (selection?.level === "possession") return selection.id;
    if (selection?.level === "domaine" && world) {
      const d =
        world.domaines.find((x) => x.id === selection.id) ??
        world.domaines[selection.id];
      if (d?.possessionId != null) return d.possessionId;
    }
    if (canPlayAs && hoverId != null) return hoverId;
    if (inPlay || isGameOver) return game?.playerId ?? null;
    return null;
  })();
  const opinionFocusName =
    opinionFocusId != null
      ? (world?.possessions || []).find((p) => p.id === opinionFocusId)?.holderName
      : null;
  const opinionLegendTitle =
    opinionFocusName &&
    (canPlayAs ||
      (game?.playerId != null && opinionFocusId !== game.playerId))
      ? `Opinion of ${opinionFocusName}`
      : "Opinion of you";
  const terrainLegend =
    showLegend && level === "terrain" && world
      ? TERRAIN_ORDER.map((type) => {
          const t = (world.terrains || []).find((x) => x.terrainType === type);
          return t ? { type, name: t.name, color: TERRAIN_PALETTE[type] } : null;
        }).filter(Boolean)
      : [];

  const economyLegend =
    showLegend && level === "economy"
      ? ECONOMY_BANDS.map((b) => ({
          label: b.label,
          color: developmentColor(b.score),
        }))
      : [];

  const opinionLegend =
    showLegend && level === "opinion"
      ? OPINION_BANDS.map((b) => ({
          label: b.label,
          color: opinionColor(b.score),
        }))
      : [];

  const powerLegend =
    showLegend && level === "power"
      ? ECONOMY_BANDS.map((b) => ({
          label: b.label,
          color: powerColor(b.score),
        }))
      : [];

  // Le bandeau BattleOverlay (déjà rendu plus bas, indépendamment de la vue)
  // ne prend la place du volet Guerre que si on a précisément sélectionné une
  // des troupes engagées dans ce combat — sinon le volet Guerre (progression
  // globale de la guerre) reste visible, même si une bataille est en cours.
  const warPanelBattling =
    inPlay && game && level === "war" && focusWarId != null && selectedArmyId != null
      ? game.armies.some(
          (a) =>
            a.warId === focusWarId &&
            a.stance === "battling" &&
            a.id === selectedArmyId,
        )
      : false;

  const allianceLegendTitle = opinionFocusName
    ? `Alliances of ${opinionFocusName}`
    : "Alliances of you";
  const allianceAtWar =
    !selection &&
    game?.playerId != null &&
    (game.wars || []).some(
      (w) => w.attackerId === game.playerId || w.defenderId === game.playerId,
    );
  const allianceLegend =
    showLegend && level === "alliance"
      ? [
          { label: opinionFocusName ?? "You", color: ALLIANCE_SELF_COLOR },
          { label: "Ally", color: ALLIANCE_ALLY_COLOR },
          { label: "Allied vassal", color: ALLIANCE_VASSAL_ALLY_COLOR },
          ...(allianceAtWar
            ? [
                { label: "At war with you", color: ALLIANCE_ENEMY_COLOR },
                { label: "Enemy's ally", color: ALLIANCE_ENEMY_ALLY_COLOR },
              ]
            : []),
          { label: "Other", color: ALLIANCE_NEUTRAL_COLOR },
        ]
      : [];

  return (
    <div id="app-layout">
      <header id="app-header">
        <div className="header-left">
          {(inPlay || isGameOver) && player && game && (
            <span className="header-player">
              {player.holderName}
              <span className="header-player-muted">
                {" "}
                · {isGameOver ? "Defeated" : player.title}
              </span>
            </span>
          )}
          {(inPlay || isGameOver) && player && game && !renamingRealm && (
            <span className="header-realm">
              {realmDisplayName(game.world, game.titles || [], player)}
              {inPlay && canRenameRealm && (
                <button
                  type="button"
                  className="header-realm-edit"
                  aria-label="Rename kingdom"
                  title="Rename kingdom"
                  onClick={() => {
                    setRealmNameInput(playerRoyaume?.name ?? "");
                    setRenamingRealm(true);
                  }}
                >
                  <Pencil size={11} strokeWidth={2} />
                </button>
              )}
            </span>
          )}
          {renamingRealm && playerRoyaume && (
            <form
              className="header-realm-rename"
              onSubmit={(e) => {
                e.preventDefault();
                const name = realmNameInput.trim();
                if (name) doRenameKingdom(playerRoyaume.id, name);
                setRenamingRealm(false);
              }}
            >
              <input
                type="text"
                autoFocus
                maxLength={40}
                value={realmNameInput}
                onChange={(e) => setRealmNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenamingRealm(false);
                }}
              />
              <button type="submit" disabled={!realmNameInput.trim()}>
                Save
              </button>
              <button type="button" onClick={() => setRenamingRealm(false)}>
                Cancel
              </button>
            </form>
          )}
        </div>
        {inPlay && player && game && <ResourcesBar game={game} player={player} />}
        {(inPlay || isGameOver) && (
          <div className="header-actions">
            <button
              type="button"
              className="game-ctrl-btn"
              aria-label="Save game"
              title="Save"
              disabled={!inPlay}
              onClick={() => {
                void doSave();
              }}
            >
              <Save size={15} />
            </button>
            <button
              type="button"
              className="game-ctrl-btn"
              aria-label="Load game"
              title="Load"
              disabled={!saveAvailable}
              onClick={() => {
                void handleLoad();
              }}
            >
              <FolderOpen size={15} />
            </button>
            <button
              type="button"
              className="game-ctrl-btn"
              aria-label="Main menu"
              title="Replay / menu"
              onClick={returnToMenu}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        )}
      </header>
      <main id="app-main">
        <div id="map-container">
          {world ? (
            <MapView
              world={world}
              level={level}
              selection={selection}
              onSelect={(sel) => {
                setClaimFocus(null);
                setSelection(sel);
              }}
              highlightId={hoverId}
              focusOutline={claimFocus}
              onHover={canPlayAs ? setHoverId : undefined}
              pickMajorOnly={canPlayAs && !playAnyone}
              armies={inPlay ? game?.armies : undefined}
              wars={inPlay ? game?.wars : undefined}
              alliances={inPlay ? game?.alliances : undefined}
              focusWarId={inPlay ? focusWarId : null}
              selectedArmyId={selectedArmyId}
              onSelectArmy={setSelectedArmyId}
              onOrderMarch={(armyId, domainId) => doOrderMarch(armyId, domainId)}
              viewerId={inPlay ? (game?.playerId ?? null) : null}
              dayProgress={game?.dayProgress ?? 0}
              playerId={opinionFocusId}
              opinions={
                canPlayAs || inPlay || isGameOver ? game?.opinions : undefined
              }
              titles={game?.titles}
              kingdomDrifts={game?.kingdomDrifts}
            />
          ) : (
            <div className="map-loading">Loading map data…</div>
          )}
          {inPlay && player && game && (
            <div id="action-alerts-overlay">
              <ActionAlerts
                game={game}
                onWar={(id) => {
                  doWar(id);
                  setSelection(null);
                }}
                onAllegiance={(id) => {
                  doAllegiance(id);
                  setSelection({ level: "possession", id });
                }}
                onAlliance={(id) => {
                  doAlliance(id);
                  setSelection({ level: "possession", id });
                }}
                onGrantDomain={(domainId) => {
                  doGrant(domainId, null);
                }}
                onCedeProvinceTitle={(provinceId, vassalId) => {
                  doCedeProvinceTitle(provinceId, vassalId);
                }}
                onClaimProvince={(provinceId) => {
                  doClaimProvince(provinceId);
                }}
                onClaimKingdom={(royaumeId) => {
                  doClaimKingdom(royaumeId);
                }}
                onFoundKingdom={(provinceId) => {
                  doFoundKingdom(provinceId);
                }}
                onFabricateClaim={(domainId) => {
                  doFabricateClaim(domainId);
                }}
                onCancelFabricateClaim={(domainId) => {
                  doCancelFabricateClaim(domainId);
                }}
                onRebel={(mode) => {
                  doRebel(mode);
                  setSelection(null);
                }}
                onCallAlly={(warId, allyId) => {
                  doCallAlly(warId, allyId);
                }}
                onRespondAllyCall={(requestId, accept) => {
                  doRespondAllyCall(requestId, accept);
                }}
                onSelect={(id) => setSelection({ level: "possession", id })}
                onSelectDomain={(id) => {
                  setClaimFocus({ level: "domaine", id });
                }}
                onSelectProvince={(id) => {
                  setClaimFocus({ level: "province", id });
                }}
                onSelectKingdom={(id) => {
                  setClaimFocus({ level: "royaume", id });
                }}
                onHover={(id) => {
                  setHoverId(id);
                  if (id == null) setClaimFocus(null);
                }}
              />
            </div>
          )}
          {inPlay && game && level === "war" && focusWarId != null && !warPanelBattling && (
            <div id="war-panel-overlay">
              <WarPanel
                game={game}
                focusWarId={focusWarId}
                onClose={() => {
                  setFocusWarId(null);
                  setLevel("possession");
                }}
                onRaiseLevies={doRaiseLevies}
                onSurrender={doSurrenderWar}
                onWhitePeace={doWhitePeace}
                onPressDemands={doPressDemands}
              />
            </div>
          )}
          {inPlay && game && selectedArmyId != null && (
            <div id="army-panel-overlay">
              <ArmyPanel
                game={game}
                armyId={selectedArmyId}
                onSplit={(armyId, troops) => doSplitArmy(armyId, troops)}
                onMerge={(armyIds) => doMergeArmies(armyIds)}
                onClose={() => setSelectedArmyId(null)}
              />
            </div>
          )}
          {inPlay && game && <BattleOverlay game={game} />}
          {terrainLegend.length > 0 && (
            <div id="terrain-legend-overlay">
              <div className="legend-title">Terrain</div>
              {terrainLegend.map((row) => (
                <div key={row!.type} className="legend-row">
                  <span className="swatch" style={{ background: row!.color }} />
                  <span>{row!.name}</span>
                </div>
              ))}
            </div>
          )}
          {economyLegend.length > 0 && (
            <div id="terrain-legend-overlay">
              <div className="legend-title">Economy</div>
              {economyLegend.map((row) => (
                <div key={row.label} className="legend-row">
                  <span className="swatch" style={{ background: row.color }} />
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
          )}
          {opinionLegend.length > 0 && (
            <div id="terrain-legend-overlay">
              <div className="legend-title">{opinionLegendTitle}</div>
              {opinionLegend.map((row) => (
                <div key={row.label} className="legend-row">
                  <span className="swatch" style={{ background: row.color }} />
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
          )}
          {allianceLegend.length > 0 && (
            <div id="terrain-legend-overlay">
              <div className="legend-title">{allianceLegendTitle}</div>
              {allianceLegend.map((row) => (
                <div key={row.label} className="legend-row">
                  <span className="swatch" style={{ background: row.color }} />
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
          )}
          {powerLegend.length > 0 && (
            <div id="terrain-legend-overlay">
              <div className="legend-title">Power</div>
              {powerLegend.map((row) => (
                <div key={row.label} className="legend-row">
                  <span className="swatch" style={{ background: row.color }} />
                  <span>{row.label}</span>
                </div>
              ))}
            </div>
          )}
          {world && selection && (canPlayAs || inPlay) && (
            <div id="selection-card-overlay">
              <SelectionCard
                world={world}
                selection={selection}
                level={level}
                onSelect={setSelection}
                onLevelChange={setLevel}
                onClose={() => setSelection(null)}
                game={game}
                onPlayAs={
                  canPlayAs
                    ? (id) => {
                        selectPlayer(id);
                        setSelection({ level: "possession", id });
                      }
                    : undefined
                }
                onWar={
                  inPlay
                    ? (id) => {
                        doWar(id);
                        setSelection(null);
                      }
                    : undefined
                }
                onAllegiance={
                  inPlay
                    ? (id) => {
                        doAllegiance(id);
                        setSelection({ level: "possession", id });
                      }
                    : undefined
                }
                onAlliance={
                  inPlay
                    ? (id) => {
                        doAlliance(id);
                        setSelection({ level: "possession", id });
                      }
                    : undefined
                }
                onGift={inPlay ? (id) => doGift(id) : undefined}
                onGrant={
                  inPlay && player
                    ? (domainId, vassalId) => {
                        doGrant(domainId, vassalId);
                        setLevel("possession");
                        setSelection({ level: "possession", id: player.id });
                      }
                    : undefined
                }
                onFabricateClaim={
                  inPlay
                    ? (domainId) => {
                        doFabricateClaim(domainId);
                      }
                    : undefined
                }
                onCancelFabricateClaim={
                  inPlay
                    ? (domainId) => {
                        doCancelFabricateClaim(domainId);
                      }
                    : undefined
                }
                onClaimProvince={
                  inPlay
                    ? (provinceId) => {
                        doClaimProvince(provinceId);
                      }
                    : undefined
                }
                onClaimKingdom={
                  inPlay
                    ? (royaumeId) => {
                        doClaimKingdom(royaumeId);
                      }
                    : undefined
                }
                onRenameKingdom={
                  inPlay
                    ? (royaumeId, name) => {
                        doRenameKingdom(royaumeId, name);
                      }
                    : undefined
                }
                onFoundKingdom={
                  inPlay
                    ? (provinceId) => {
                        doFoundKingdom(provinceId);
                      }
                    : undefined
                }
                onRebel={
                  inPlay
                    ? (mode) => {
                        doRebel(mode);
                        setSelection(null);
                      }
                    : undefined
                }
              />
            </div>
          )}
          {(canPlayAs || inPlay) && (
            <div id="bottom-right-overlay">
              {inPlay && game && (
                <WarIcon
                  game={game}
                  focusWarId={level === "war" ? focusWarId : null}
                  onSelectWar={(warId) => {
                    const closing = level === "war" && focusWarId === warId;
                    setFocusWarId(closing ? null : warId);
                    setLevel(closing ? "possession" : "war");
                  }}
                />
              )}
              <LevelSelector level={level} onChange={changeLevel} />
            </div>
          )}
          {(inPlay || isGameOver) && game && (
            <div id="time-controls-overlay">
              <span className="time-controls-date" aria-live="polite">
                {formatDate(game.year, game.month, game.day)}
              </span>
              {inPlay && (
                <>
                  <span className="time-controls-sep" aria-hidden />
                  <button
                    type="button"
                    className={cn("time-controls-play", game.playing && "active")}
                    aria-label={game.playing ? "Pause" : "Play"}
                    onClick={() => setPlaying(!game.playing)}
                  >
                    {game.playing ? <Pause size={15} /> : <Play size={15} />}
                  </button>
                  <div className="time-controls-speeds" role="group" aria-label="Game speed">
                    {([1, 2, 3] as GameSpeed[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={cn("time-controls-speed", game.speed === s && "active")}
                        aria-pressed={game.speed === s}
                        onClick={() => setSpeed(s)}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {game && (
            <NoticeToastStack
              notices={game.notices.filter((n) => n.blocking === false)}
              onDismiss={doDismissNotice}
            />
          )}
        </div>
        <aside id="side-panel">
          <GameMenu
            templateReady={!!template}
            game={game}
            player={player}
            saveAvailable={saveAvailable}
            saveInfo={saveInfo}
            saveStatus={saveStatus}
            playAnyone={playAnyone}
            hoverId={hoverId}
            onSelectPlayer={(id) => {
              selectPlayer(id);
              setLevel("possession");
              setSelection({ level: "possession", id });
            }}
            onLoad={() => {
              void handleLoad();
            }}
            onNewGame={() => {
              startNewGame();
              setSelection(null);
              setLevel("possession");
              setPlayAnyone(false);
              setHoverId(null);
            }}
            onMainMenu={returnToMenu}
            onPlayAnyoneChange={setPlayAnyone}
            onHover={setHoverId}
            onSetFocus={doSetFocus}
          />
        </aside>
      </main>
      {game && (
        <NoticeModal
          notice={game.notices.find((n) => n.blocking !== false)}
          onDismiss={(noticeId) => doDismissNotice(noticeId)}
        />
      )}
      {game &&
        !game.notices.some((n) => n.blocking !== false) &&
        (game.allegianceDemands || []).length > 0 && (
          <AllegianceDemandModal
            game={game}
            onRespond={(requestId, accept) => doRespondAllegianceDemand(requestId, accept)}
          />
        )}
    </div>
  );
}

export default App;
