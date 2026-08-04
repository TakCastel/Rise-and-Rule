import type { LucideIcon } from "lucide-react";
import {
  Coins,
  Crown,
  Heart,
  HeartHandshake,
  Hexagon,
  LandPlot,
  Mountain,
  Shield,
} from "lucide-react";
import type { LevelName } from "../types/world";
import { cn } from "@/lib/utils";

const LEVELS: {
  id: LevelName;
  label: string;
  Icon: LucideIcon;
}[] = [
  { id: "possession", label: "Possession", Icon: Shield },
  { id: "domaine", label: "Domain", Icon: Hexagon },
  { id: "province", label: "Province", Icon: LandPlot },
  { id: "royaume", label: "Realm", Icon: Crown },
  { id: "terrain", label: "Terrain", Icon: Mountain },
  { id: "economy", label: "Economy", Icon: Coins },
  { id: "opinion", label: "Opinion", Icon: Heart },
  { id: "alliance", label: "Alliances", Icon: HeartHandshake },
];

interface LevelSelectorProps {
  level: LevelName;
  onChange: (level: LevelName) => void;
}

export function LevelSelector({ level, onChange }: LevelSelectorProps) {
  return (
    <div className="level-selector" role="tablist" aria-label="Map level">
      {LEVELS.map(({ id, label, Icon }) => {
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
    </div>
  );
}
