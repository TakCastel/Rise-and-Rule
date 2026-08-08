import { Coffee } from "lucide-react";

/**
 * Bouton de soutien, flottant en bas à droite du viewport (pas de la carte)
 * — rendu une seule fois, hors de tout bloc conditionnel sur la phase de
 * jeu, pour rester visible sur l'écran-titre, le choix de personnage et en
 * partie. `position: fixed` (pas `absolute` dans `.map2d`) : le coin
 * bas-droit de la carte est déjà pris par le sélecteur de niveau/l'icône de
 * guerre — ancré au viewport, ce bouton atterrit sur l'aside à la place,
 * dont les sections repliées par défaut laissent typiquement ce coin vide.
 */
export function BuyMeACoffeeButton() {
  return (
    <a
      href="https://buymeacoffee.com/ttlh"
      target="_blank"
      rel="noopener noreferrer"
      className="bmac-button"
      title="Buy me a coffee"
    >
      <Coffee size={15} strokeWidth={2.25} aria-hidden />
      <span>Buy me a coffee</span>
    </a>
  );
}
