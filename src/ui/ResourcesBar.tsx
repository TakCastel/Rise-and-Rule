import { Baby, Coins, Hexagon, Sparkles } from "lucide-react";
import {
  formatGold,
  formatGoldDelta,
  formatPrestige,
  getGold,
  getPrestige,
  possessionIncomeBreakdown,
  possessionMonthlyPrestige,
} from "../game/economy";
import {
  DEMESNE_LIMIT,
  demesneCount,
  demesneOverage,
  demesnePenaltyPercent,
} from "../game/demesne";
import { getAllyIds, getChildrenTokens } from "../game/alliance";
import type { GameState } from "../game/types";
import type { Possession } from "../types/world";
import { cn } from "@/lib/utils";

interface ResourcesBarProps {
  game: GameState;
  player: Possession;
}

export function ResourcesBar({ game, player }: ResourcesBarProps) {
  const gold = getGold(player);
  const prestige = getPrestige(player);
  const income = possessionIncomeBreakdown(game.world, player);
  const prestigeMo = possessionMonthlyPrestige(game.world, player);
  const domainCount = demesneCount(player);
  const overage = demesneOverage(player);
  const penaltyPct = demesnePenaltyPercent(player);
  const vassalCount = player.vassalIds?.length ?? 0;
  const children = getChildrenTokens(player);
  const allyCount = getAllyIds(game.alliances, player.id).length;
  const domains = income.domains;
  const inDebt = gold < 0;
  const deficit = income.net < 0;

  return (
    <div className="resources-bar">
      <div className="resources-pills">
        <div
          className={cn("resources-pill", inDebt && "is-warn")}
          tabIndex={0}
          aria-label={`${formatGold(gold)} gold`}
        >
          <Coins className="resources-icon is-gold" aria-hidden size={15} strokeWidth={2} />
          <span className="resources-value">{formatGold(gold)}</span>
          <span className="resources-unit">{inDebt ? "debt" : "gold"}</span>
          <span className={cn("resources-income", deficit && "is-warn")}>
            {formatGoldDelta(income.net)}/mo
          </span>
          <div className="resources-tooltip" role="tooltip">
            <div className="resources-tooltip-title">
              {inDebt ? "Debt" : "Treasury"}
            </div>
            <div className="resources-tooltip-row">
              <span>Balance</span>
              <span>{formatGold(gold)}</span>
            </div>
            <div className="resources-tooltip-row">
              <span>Demesne income</span>
              <span>{formatGoldDelta(income.total)} / month</span>
            </div>
            {income.debtInterest > 0 && (
              <div className="resources-tooltip-row is-warn">
                <span>Debt interest</span>
                <span>−{formatGold(income.debtInterest)} / month</span>
              </div>
            )}
            {overage > 0 && (
              <div className="resources-tooltip-row is-warn">
                <span>Over-limit penalty</span>
                <span>
                  −{penaltyPct}% (gross {formatGold(income.gross)})
                </span>
              </div>
            )}
            {inDebt && (
              <div className="resources-tooltip-row is-warn">
                <span>Levies crippled by debt</span>
              </div>
            )}
          </div>
        </div>

        <div
          className="resources-pill"
          tabIndex={0}
          aria-label={`${formatPrestige(prestige)} prestige`}
        >
          <Sparkles
            className="resources-icon is-prestige"
            aria-hidden
            size={15}
            strokeWidth={2}
          />
          <span className="resources-value">{formatPrestige(prestige)}</span>
          <span className="resources-unit">prestige</span>
          <span className="resources-income">+{formatPrestige(prestigeMo)}/mo</span>
          <div className="resources-tooltip" role="tooltip">
            <div className="resources-tooltip-title">Prestige</div>
            <div className="resources-tooltip-row">
              <span>Standing</span>
              <span>{formatPrestige(prestige)}</span>
            </div>
            <div className="resources-tooltip-row">
              <span>From territory</span>
              <span>+{formatPrestige(prestigeMo)} / month</span>
            </div>
            <div className="resources-tooltip-row is-muted">
              <span>Spent to demand allegiance</span>
            </div>
          </div>
        </div>

        <div
          className="resources-pill"
          tabIndex={0}
          aria-label={`${children} marriage token${children === 1 ? "" : "s"}`}
        >
          <Baby
            className="resources-icon is-children"
            aria-hidden
            size={15}
            strokeWidth={2}
          />
          <span className="resources-value">{children}</span>
          <span className="resources-unit">
            {children === 1 ? "child" : "children"}
          </span>
          {allyCount > 0 ? (
            <span className="resources-income is-neutral">
              {allyCount} all{allyCount === 1 ? "y" : "ies"}
            </span>
          ) : (
            <span className="resources-income is-neutral">marriage</span>
          )}
          <div className="resources-tooltip" role="tooltip">
            <div className="resources-tooltip-title">House</div>
            <div className="resources-tooltip-row">
              <span>Children (marriage tokens)</span>
              <span>{children}</span>
            </div>
            <div className="resources-tooltip-row">
              <span>Alliances</span>
              <span>{allyCount}</span>
            </div>
            <div className="resources-tooltip-row is-muted">
              <span>
                A child is born every few years. Spend one to marry into a clan
                and seal an alliance — they join your wars.
              </span>
            </div>
          </div>
        </div>

        <div
          className={cn("resources-pill", overage > 0 && "is-warn")}
          tabIndex={0}
          aria-label={`${domainCount} of ${DEMESNE_LIMIT} domains`}
        >
          <Hexagon
            className="resources-icon is-domains"
            aria-hidden
            size={15}
            strokeWidth={2}
          />
          <span className="resources-value">
            {domainCount}/{DEMESNE_LIMIT}
          </span>
          <span className="resources-unit">domains</span>
          {overage > 0 ? (
            <span className="resources-income is-warn">−{penaltyPct}%</span>
          ) : vassalCount > 0 ? (
            <span className="resources-income is-neutral">
              {vassalCount} vassal{vassalCount === 1 ? "" : "s"}
            </span>
          ) : null}
          <div className="resources-tooltip" role="tooltip">
            <div className="resources-tooltip-title">Possessions</div>
            <div className="resources-tooltip-row">
              <span>Demesne limit</span>
              <span>
                {domainCount} / {DEMESNE_LIMIT}
              </span>
            </div>
            {overage > 0 && (
              <div className="resources-tooltip-row is-warn">
                <span>Over by {overage}</span>
                <span>
                  −{penaltyPct}%
                  {income.efficiency < 0 ? " · running a deficit" : ""}
                </span>
              </div>
            )}
            {vassalCount > 0 && (
              <div className="resources-tooltip-row">
                <span>Vassals</span>
                <span>{vassalCount}</span>
              </div>
            )}
            {vassalCount > 1 && (
              <div className="resources-tooltip-row is-muted">
                <span>
                  Keep vassals from allying — a strong allied bloc may rebel
                </span>
              </div>
            )}
            {overage > 0 && (
              <div className="resources-tooltip-row is-muted">
                <span>
                  Too many domains drain the treasury and gut your levies — grant them
                </span>
              </div>
            )}
            {domains.length > 0 && (
              <>
                <div className="resources-tooltip-sub">Domains</div>
                {domains.map((d) => (
                  <div key={d.id} className="resources-tooltip-row is-muted">
                    <span>
                      {d.name}
                      <span className="resources-tooltip-dev">
                        {" "}
                        · dev {d.development}
                      </span>
                    </span>
                    <span>+{formatGold(d.income)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
