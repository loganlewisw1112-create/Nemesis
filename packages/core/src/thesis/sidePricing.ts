export interface SelectedSidePricing {
  side: 'yes' | 'no';
  marketPrice: number;
  impliedPrice: number;
}

function roundPrice(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Converts YES-denominated market/model prices into the selected contract side. */
export function selectedSidePricing(yesMarketPrice: number, yesImpliedPrice: number): SelectedSidePricing {
  if (yesImpliedPrice >= yesMarketPrice) {
    return { side: 'yes', marketPrice: yesMarketPrice, impliedPrice: yesImpliedPrice };
  }
  return {
    side: 'no',
    marketPrice: roundPrice(1 - yesMarketPrice),
    impliedPrice: roundPrice(1 - yesImpliedPrice),
  };
}
