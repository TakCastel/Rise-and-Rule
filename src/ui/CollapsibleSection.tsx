import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Section repliable générique — aside (`GameMenu`) et fiche de territoire
 * (`SelectionCard`) partagent le même besoin : plusieurs listes (domaines,
 * vassaux, alliés, chronique…) empilées faisaient un mur de texte toujours
 * déployé. Repliée par défaut, elle ne montre que son titre + un compteur ;
 * un clic déroule le contenu. État local au composant — se referme tout
 * seul quand la carte change (nouvelle sélection ⇒ nouvelle instance).
 */
export function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  className,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn("collapsible-section", className)}>
      <button
        type="button"
        className="collapsible-section-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <h3 className="collapsible-section-title">{title}</h3>
        {count != null && <span className="collapsible-section-count">{count}</span>}
        <ChevronDown
          size={13}
          strokeWidth={2.25}
          className={cn("collapsible-section-chevron", open && "is-open")}
          aria-hidden
        />
      </button>
      {open && <div className="collapsible-section-body">{children}</div>}
    </section>
  );
}
