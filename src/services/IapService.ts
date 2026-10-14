// In-app purchases behind a thin adapter, like ads. The stub "buys" everything
// so the shop is fully testable with no store; swap in StoreKit / Play Billing
// (or a wrapper such as RevenueCat) by implementing IIapService. Granting the
// purchase is the caller's job (ShopPanel), so a real store's receipt check
// slots in here without touching game code.
// Pure TS with no imports: Node unit-tests this file directly.

export type ProductId = 'remove_ads' | 'coins_small' | 'coins_large';

export interface ProductInfo {
  id: ProductId;
  title: string;
  /** Display string as the store localises it, e.g. '$2.99'. */
  price: string;
  /** Coins granted by a consumable; absent for non-consumables. */
  coins?: number;
}

export interface IIapService {
  products(): ProductInfo[];
  /** Resolves true once the store confirms payment. Never grants anything itself. */
  purchase(id: ProductId): Promise<boolean>;
  /** Non-consumables the store says this account owns. */
  restore(): Promise<ProductId[]>;
}

const CATALOG: readonly ProductInfo[] = [
  { id: 'remove_ads', title: 'Remove Ads', price: '$2.99' },
  { id: 'coins_small', title: 'Coin Pouch', price: '$0.99', coins: 1500 },
  { id: 'coins_large', title: 'Coin Chest', price: '$4.99', coins: 10000 },
];

export class IapServiceStub implements IIapService {
  private readonly latencyMs: number;

  constructor(latencyMs: number) {
    this.latencyMs = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
  }

  products(): ProductInfo[] {
    return CATALOG.map((p) => ({ ...p })); // copies: a caller can't edit the catalog
  }

  purchase(id: ProductId): Promise<boolean> {
    return this.delay().then(() => {
      const known = CATALOG.some((p) => p.id === id);
      console.info(`[IapServiceStub] purchase ${id} — ${known ? 'approved (test store)' : 'unknown product'}`);
      return known;
    });
  }

  restore(): Promise<ProductId[]> {
    return this.delay().then(() => {
      console.info('[IapServiceStub] restore — nothing to restore');
      return [];
    });
  }

  private delay(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
  }
}
