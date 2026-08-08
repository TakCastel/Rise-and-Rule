import type { LucideIcon } from "lucide-react";
import {
  BicepsFlexed,
  Coins,
  Crown,
  Heart,
  HeartHandshake,
  Hexagon,
  LandPlot,
  MoreHorizontal,
  Mountain,
  Shield,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LevelName } from "../types/world";
import { cn } from "@/lib/utils";

type LevelEntry = { id: LevelName; label: string; Icon: LucideIcon };

/** Vues consultées le plus souvent — restent visibles directement. */
const PRIMARY_LEVELS: LevelEntry[] = [
  { id: "possession", label: "Possession", Icon: Shield },
  { id: "terrain", label: "Terrain", Icon: Mountain },
  { id: "economy", label: "Economy", Icon: Coins },
  { id: "opinion", label: "Opinion", Icon: Heart },
  { id: "alliance", label: "Alliances", Icon: HeartHandshake },
  { id: "power", label: "Power", Icon: BicepsFlexed },
];

/** Niveaux de granularité administrative — moins consultés, repliés. */
const MORE_LEVELS: LevelEntry[] = [
  { id: "domaine", label: "Domain", Icon: Hexagon },
  { id: "province", label: "Province", Icon: LandPlot },
  { id: "royaume", label: "Realm", Icon: Crown },
];

interface LevelSelectorProps {
  level: LevelName;
  onChange: (level: LevelName) => void;
}

export function LevelSelector({ level, onChange }: LevelSelectorProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const moreActive = MORE_LEVELS.some((l) => l.id === level);

  useEffect(() => {
    if (!moreOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [moreOpen]);

  return (
    <div className="level-selector-wrap" ref={rootRef}>
      {moreOpen && (
        <div className="level-more-popover" role="menu" aria-label="More filters">
          {MORE_LEVELS.map(({ id, label, Icon }) => {
            const active = level === id;
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={cn("level-more-item", active && "active")}
                onClick={() => {
                  onChange(id);
                  setMoreOpen(false);
                }}
              >
                <Icon aria-hidden size={16} strokeWidth={active ? 2.25 : 1.75} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="level-selector" role="tablist" aria-label="Map level">
        {PRIMARY_LEVELS.map(({ id, label, Icon }) => {
          const active = level === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-label={label}
              aria-selected={active}
              title={label}
              data-tooltip={label}
              className={cn("level-icon-btn", active && "active")}
              onClick={() => onChange(id)}
            >
              <Icon aria-hidden size={18} strokeWidth={active ? 2.25 : 1.75} />
              <span className="sr-only">{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          aria-label="More filters"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          title="More filters"
          data-tooltip="More filters"
          className={cn("level-icon-btn", (moreActive || moreOpen) && "active")}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <MoreHorizontal aria-hidden size={18} strokeWidth={moreActive ? 2.25 : 1.75} />
          <span className="sr-only">More filters</span>
        </button>
      </div>
    </div>
  );
}
