import type { WorldData } from "../types/world";
import type { GameState } from "./types";
import { getPlayer } from "./types";
import { formatDate } from "./tick";
import { buildInitialTitles } from "./titles";
import { buildConquestOrder, findPossession } from "./war";

/**
 * Empreinte légère du monde — change dès que les royaumes bougent (ajout /
 * retrait / renommage), typiquement après une régénération de world.json en
 * cours de dev. Sert à invalider une autosave devenue incompatible : sans
 * ça, une vieille partie (ancien monde) se restaure silencieusement par
 * dessus le nouveau world.json, et les changements de carte semblent ne
 * jamais s'appliquer.
 */
export function worldFingerprint(world: WorldData): string {
  const codes = (world.royaumes || [])
    .map((r) => r.code)
    .sort()
    .join(",");
  return `${world.domaines.length}|${(world.royaumes || []).length}|${codes}`;
}

const DB_NAME = "clovis";
const DB_VERSION = 1;
const STORE = "saves";
const SLOT = "main";

/**
 * L’autosave dev doit rester scopée à cet onglet : une clé globale partagée
 * entre onglets ferait qu’un full reload (déclenché par une modif de code)
 * dans l’onglet A puisse restaurer la dernière partie sauvegardée par
 * l’onglet B — un onglet oublié en arrière-plan écrase silencieusement la
 * partie en cours dans un autre. `sessionStorage` est justement scopé par
 * onglet et survit à un reload, donc l’id reste stable pour CET onglet.
 */
function devAutosaveSlotKey(): string {
  const STORAGE_KEY = "clovis-dev-tab-id";
  let tabId = sessionStorage.getItem(STORAGE_KEY);
  if (!tabId) {
    tabId = Math.random().toString(36).slice(2);
    sessionStorage.setItem(STORAGE_KEY, tabId);
  }
  return `dev-autosave:${tabId}`;
}

export interface SaveSlot {
  version: 1;
  savedAt: number;
  game: GameState;
  /** Dev autosave uniquement — absent sur les sauvegardes manuelles. */
  worldFingerprint?: string;
}

export interface SaveInfo {
  savedAt: number;
  label: string;
  detail: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function normalizeSlot(raw: unknown): SaveSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  // Ancien format : GameState direct
  if (obj.world && obj.opinions && !obj.game) {
    return {
      version: 1,
      savedAt: Date.now(),
      game: obj as unknown as GameState,
    };
  }
  if (obj.version === 1 && obj.game && typeof obj.game === "object") {
    return obj as unknown as SaveSlot;
  }
  return null;
}

/**
 * Filet de sécurité au chargement : une autosave dev écrite avant le fix de
 * la course StrictMode sur la restauration (deux appels concurrents à
 * `loadDevAutosave` pouvaient produire deux armées avec le même id — voir
 * `useGame.ts`) reste corrompue une fois enregistrée telle quelle. Le fix ne
 * répare pas rétroactivement une sauvegarde déjà écrite — donc dédoublonner
 * ici à chaque chargement, plutôt que de compter sur l'utilisateur pour
 * repartir d'une partie neuve.
 */
function repairArmies(game: GameState): void {
  if (!game.armies?.length) return;
  const seen = new Set<number>();
  let maxId = 0;
  const deduped = game.armies.filter((a) => {
    if (a.id > maxId) maxId = a.id;
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  if (deduped.length !== game.armies.length) game.armies = deduped;
  if ((game.nextArmyId ?? 1) <= maxId) game.nextArmyId = maxId + 1;
}

function describeSave(slot: SaveSlot): SaveInfo {
  const g = slot.game;
  if (!g.giftsSent) g.giftsSent = {};
  if (!g.warTruces) g.warTruces = {};
  if (!g.alliances) g.alliances = [];
  if (!g.titles) {
    g.titles = buildInitialTitles(g.world);
  }
  if (!g.claimFabrications) g.claimFabrications = [];
  if (g.nextFabricationId == null) g.nextFabricationId = 1;
  if (!g.kingdomDrifts) g.kingdomDrifts = [];
  if (g.nextDriftId == null) g.nextDriftId = 1;
  if (!g.armies) g.armies = [];
  if (g.nextArmyId == null) g.nextArmyId = 1;
  if (!g.allyCallRequests) g.allyCallRequests = [];
  if (g.nextAllyCallRequestId == null) g.nextAllyCallRequestId = 1;
  if (!g.allegianceDemands) g.allegianceDemands = [];
  if (g.nextAllegianceDemandId == null) g.nextAllegianceDemandId = 1;
  // Notices modales : éphémères, ça n'a pas de sens de rouvrir une modale figée après rechargement.
  g.notices = [];
  if (g.nextNoticeId == null) g.nextNoticeId = 1;
  for (const p of g.world.possessions || []) {
    if (!p.claims) p.claims = [];
    if (!p.domainClaims) p.domainClaims = [];
  }
  g.playing = false;
  const player = getPlayer(g);
  return {
    savedAt: slot.savedAt,
    label: player ? player.holderName : "Saved game",
    detail: [
      player?.title,
      formatDate(g.year, g.month, g.day),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Snapshot jouable (pause forcée). */
export function snapshotForSave(game: GameState): GameState {
  // Idem saveDevAutosave : IndexedDB clone déjà en interne au put(), un
  // structuredClone manuel ici double juste le travail. Copie superficielle
  // suffisante pour ne pas muter `game.playing` par référence.
  return { ...game, playing: false };
}

export async function saveGame(game: GameState): Promise<void> {
  const slot: SaveSlot = {
    version: 1,
    savedAt: Date.now(),
    game: snapshotForSave(game),
  };
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbRequest(tx.objectStore(STORE).put(slot, SLOT));
  } finally {
    db.close();
  }
}

export async function loadGame(): Promise<GameState | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const raw = await idbRequest(tx.objectStore(STORE).get(SLOT));
    const slot = normalizeSlot(raw);
    if (!slot?.game?.world?.domaines || !slot.game.opinions) return null;
    if (!slot.game.giftsSent) slot.game.giftsSent = {};
    if (!slot.game.warTruces) slot.game.warTruces = {};
    if (!slot.game.alliances) slot.game.alliances = [];
    if (slot.game.dayProgress == null) slot.game.dayProgress = 0;
    if (!slot.game.kingdomDrifts) slot.game.kingdomDrifts = [];
    if (slot.game.nextDriftId == null) slot.game.nextDriftId = 1;
    if (!slot.game.armies) slot.game.armies = [];
    if (slot.game.nextArmyId == null) slot.game.nextArmyId = 1;
    repairArmies(slot.game);
    if (!slot.game.allyCallRequests) slot.game.allyCallRequests = [];
    if (slot.game.nextAllyCallRequestId == null) slot.game.nextAllyCallRequestId = 1;
    if (!slot.game.allegianceDemands) slot.game.allegianceDemands = [];
    if (slot.game.nextAllegianceDemandId == null) slot.game.nextAllegianceDemandId = 1;
    slot.game.notices = [];
    if (slot.game.nextNoticeId == null) slot.game.nextNoticeId = 1;
    // Anciennes sauvegardes (front automatique) : pas de migration fine possible —
    // la guerre repart de zéro en conduite manuelle (armées à lever, rien de capturé).
    for (const w of slot.game.wars || []) {
      if (!w.capturedByAttacker || !w.capturedByDefender) {
        const attacker = findPossession(slot.game.world, w.attackerId);
        const defender = findPossession(slot.game.world, w.defenderId);
        w.conquestOrder =
          attacker && defender ? buildConquestOrder(slot.game.world, attacker, defender) : [];
        w.attackerFrontOrder =
          attacker && defender ? buildConquestOrder(slot.game.world, defender, attacker) : [];
        w.capturedByAttacker = [];
        w.capturedByDefender = [];
      }
    }
    slot.game.playing = false;
    if (slot.game.phase !== "play" || slot.game.playerId == null) return null;
    return slot.game;
  } finally {
    db.close();
  }
}

export async function peekSave(): Promise<SaveInfo | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const raw = await idbRequest(tx.objectStore(STORE).get(SLOT));
    const slot = normalizeSlot(raw);
    if (!slot?.game?.world?.domaines || slot.game.playerId == null) return null;
    return describeSave(slot);
  } finally {
    db.close();
  }
}

export async function hasSave(): Promise<boolean> {
  return (await peekSave()) != null;
}

export async function clearSave(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbRequest(tx.objectStore(STORE).delete(SLOT));
  } finally {
    db.close();
  }
}

/**
 * Autosave dev : survit aux full reloads déclenchés par Vite quand un module
 * non-composant (logique de jeu) change et ne peut pas être HMR-swappé.
 * Jamais utilisé en build de prod.
 */
export async function saveDevAutosave(game: GameState): Promise<void> {
  // Pas de structuredClone manuel ici : IDBObjectStore.put() clone déjà la
  // valeur en interne (obligatoire par la spec IndexedDB, exécuté de façon
  // synchrone à l'appel) — cloner nous-mêmes avant faisait doubler le coût
  // sur un état de jeu de plusieurs Mo, écrit ~1.7×/s en dev à vitesse 3×.
  const slot: SaveSlot = {
    version: 1,
    savedAt: Date.now(),
    game,
    worldFingerprint: worldFingerprint(game.world),
  };
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbRequest(tx.objectStore(STORE).put(slot, devAutosaveSlotKey()));
  } finally {
    db.close();
  }
}

/**
 * `expectedFingerprint` = empreinte du world.json fraîchement chargé. Une
 * autosave dont l'empreinte ne correspond plus (carte régénérée entretemps)
 * est ignorée plutôt que de restaurer un monde périmé par dessus le nouveau.
 */
export async function loadDevAutosave(expectedFingerprint: string): Promise<GameState | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const raw = await idbRequest(tx.objectStore(STORE).get(devAutosaveSlotKey()));
    const slot = normalizeSlot(raw);
    if (!slot?.game?.world?.domaines || !slot.game.opinions) return null;
    if (slot.worldFingerprint !== expectedFingerprint) return null;
    slot.game.notices = [];
    if (slot.game.nextNoticeId == null) slot.game.nextNoticeId = 1;
    repairArmies(slot.game);
    return slot.game;
  } finally {
    db.close();
  }
}

export async function clearDevAutosave(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbRequest(tx.objectStore(STORE).delete(devAutosaveSlotKey()));
  } finally {
    db.close();
  }
}
