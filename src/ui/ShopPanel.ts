import type { GameConfig, SaveData, SkinDef, UpgradeLevels } from '../data/types';
import type { SaveService } from '../services/SaveService';
import type { AudioService } from '../services/AudioService';
import type { IIapService, ProductId, ProductInfo } from '../services/IapService';

export type ShopTab = 'upgrades' | 'skins' | 'store';

interface UpgradeDef {
  key: keyof UpgradeLevels;
  name: string;
  icon: string;
  effect: (lvl: number) => string;
  max: number;
}

const UPGRADES: UpgradeDef[] = [
  { key: 'bulletPower', name: 'Bullet Power', icon: '🔫', max: 10, effect: (l) => `+${l * 25}% damage` },
  { key: 'fireRate', name: 'Fire Rate', icon: '⚡', max: 10, effect: (l) => `+${l * 20}% rate` },
  { key: 'startingCrowd', name: 'Starting Crowd', icon: '👥', max: 10, effect: (l) => `+${l * 3} units` },
  { key: 'income', name: 'Income', icon: '💰', max: 10, effect: (l) => `+${l} coin/unit` },
];

const TABS: readonly { id: ShopTab; label: string }[] = [
  { id: 'upgrades', label: 'UPGRADES' },
  { id: 'skins', label: 'SKINS' },
  { id: 'store', label: 'STORE' },
];

const PRODUCT_ICON: Partial<Record<ProductId, string>> = {
  remove_ads: '🚫',
  coins_small: '💰',
  coins_large: '💰',
};

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Coin-sink shop with three tabs: stat upgrades (fed into CrowdController /
// economy at run start), cosmetic skins, and the real-money store. The store
// only talks to IIapService; granting what was bought happens here.
export class ShopPanel {
  /** After a skin is bought (which equips it) or equipped. */
  onSkinChanged: ((skin: SkinDef) => void) | null = null;
  /** After any coin balance change the shop makes (upgrade, skin, coin pack). */
  onCoinsChanged: (() => void) | null = null;

  private root: HTMLDivElement;
  private coinsNum: HTMLSpanElement;
  private tabBtns: HTMLButtonElement[] = [];
  private body: HTMLDivElement;
  private statusEl: HTMLParagraphElement;
  private returnFn: () => void;
  private tab: ShopTab = 'upgrades';
  private shown = false;
  // one store request at a time; every store button stays disabled until it settles
  private pending: ProductId | 'restore' | null = null;

  constructor(
    private save: SaveService,
    private cfg: GameConfig,
    private audio: AudioService,
    private iap: IIapService,
    private defaultClose: () => void,
  ) {
    this.returnFn = defaultClose;
    this.root = make('div', 'panel');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-labelledby', 'shop-title');
    // keep shop taps out of the game's steer input (it listens on #app)
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('keydown', (e) => {
      // only a fresh press closes: auto-repeat of a held Escape is ignored, as in settings
      if (e.key !== 'Escape' || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });

    const title = make('h1', 'panel-title', 'SHOP');
    title.id = 'shop-title';
    this.root.appendChild(title);

    const coins = make('div', 'panel-coins');
    const dot = make('span', '', '● ');
    dot.setAttribute('aria-hidden', 'true');
    this.coinsNum = make('span', '');
    coins.append(dot, this.coinsNum, make('span', 'sr-only', ' coins'));
    this.root.appendChild(coins);

    const tabs = make('div', 'shop-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Shop sections');
    for (const t of TABS) {
      const b = make('button', 'shop-tab', t.label);
      b.type = 'button';
      b.id = `shop-tab-${t.id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'shop-body');
      b.onclick = () => this.selectTab(t.id);
      this.tabBtns.push(b);
      tabs.appendChild(b);
    }
    tabs.addEventListener('keydown', this.onTabKey);
    this.root.appendChild(tabs);

    this.body = make('div', 'panel-scroll');
    this.body.id = 'shop-body';
    this.body.setAttribute('role', 'tabpanel');
    this.root.appendChild(this.body);

    this.statusEl = make('p', 'store-status');
    this.statusEl.setAttribute('role', 'status');

    const actions = make('div', 'panel-actions');
    const back = make('button', 'btn', 'BACK');
    back.type = 'button';
    back.onclick = () => { this.audio.play('click'); this.close(); };
    actions.appendChild(back);
    this.root.appendChild(actions);

    document.getElementById('hud')!.appendChild(this.root);
  }

  /**
   * Open the shop on `tab` (default: whichever tab was last used). When closed,
   * returns to `returnTo` (defaults to the menu).
   */
  open(returnTo?: () => void, tab?: ShopTab): void {
    this.returnFn = returnTo ?? this.defaultClose;
    if (tab) this.tab = tab;
    this.statusEl.textContent = '';
    this.render();
    this.body.scrollTop = 0;
    this.shown = true;
    this.root.classList.add('show');
    this.tabBtns[this.tabIndex()].focus({ preventScroll: true });
  }

  close(): void {
    if (!this.shown) return; // BACK + Escape in one frame must not run returnFn twice
    this.shown = false;
    this.root.classList.remove('show');
    this.returnFn();
  }

  private tabIndex(): number {
    for (let i = 0; i < TABS.length; i++) if (TABS[i].id === this.tab) return i;
    return 0;
  }

  private selectTab(tab: ShopTab): void {
    if (tab === this.tab) return;
    this.audio.play('click');
    this.tab = tab;
    this.statusEl.textContent = '';
    this.render();
    this.body.scrollTop = 0;
  }

  // WAI-ARIA tabs: arrows / Home / End move between tabs (roving tabindex)
  private onTabKey = (e: KeyboardEvent): void => {
    const i = this.tabIndex();
    let n: number;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else return;
    e.preventDefault();
    this.selectTab(TABS[n].id);
    this.tabBtns[n].focus();
  };

  private cost(level: number): number {
    const e = this.cfg.economy;
    return Math.ceil(e.upgradeCostBase * Math.pow(e.upgradeCostGrowth, level));
  }

  /** Mirrors GameManager: an equipped id the catalog doesn't know falls back to skins[0]. */
  private equippedId(data: SaveData): string {
    const skins = this.cfg.skins;
    for (const s of skins) if (s.id === data.equippedSkin) return s.id;
    return skins.length > 0 ? skins[0].id : 'default';
  }

  /** Rebuild the active tab in place, keeping its scroll position and keyboard focus. */
  private render(): void {
    const data = this.save.get();
    this.coinsNum.textContent = String(data.coins);
    for (let i = 0; i < TABS.length; i++) {
      const on = TABS[i].id === this.tab;
      this.tabBtns[i].setAttribute('aria-selected', String(on));
      this.tabBtns[i].tabIndex = on ? 0 : -1;
    }
    this.body.setAttribute('aria-labelledby', `shop-tab-${this.tab}`);
    const scroll = this.body.scrollTop;
    // The rebuild destroys the focused button; left alone, focus would fall to
    // <body>, where the panel's Escape handler can't hear it.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && this.body.contains(active) ? active.dataset.key : undefined;
    this.body.replaceChildren();
    if (this.tab === 'upgrades') this.renderUpgrades(data);
    else if (this.tab === 'skins') this.renderSkins(data);
    else this.renderStore(data);
    this.body.scrollTop = scroll;
    if (focusKey !== undefined) this.restoreFocus(focusKey);
  }

  /** Same control again if it is still usable (a buy can leave it disabled), else the active tab. */
  private restoreFocus(key: string): void {
    for (const b of this.body.querySelectorAll('button')) {
      if (b.dataset.key === key && !b.disabled) {
        b.focus({ preventScroll: true });
        return;
      }
    }
    this.tabBtns[this.tabIndex()].focus({ preventScroll: true });
  }

  private renderUpgrades(data: SaveData): void {
    const list = make('div', 'shop-list');
    for (const def of UPGRADES) {
      const lvl = data.upgrades[def.key];
      const maxed = lvl >= def.max;
      const price = this.cost(lvl);
      const afford = data.coins >= price && !maxed;

      const row = make('div', 'shop-row');
      const info = make('div', 'shop-info');
      info.append(
        make('div', 'shop-name', `${def.icon} ${def.name}`),
        make('div', 'shop-sub', `Lv ${lvl}/${def.max} · ${def.effect(lvl)}`),
      );
      row.appendChild(info);

      const buy = make('button', afford ? 'btn gold' : 'btn ghost', maxed ? 'MAX' : `● ${price}`);
      buy.type = 'button';
      buy.dataset.key = `up:${def.key}`;
      buy.disabled = !afford;
      buy.setAttribute('aria-label', maxed ? `${def.name} maxed` : `Upgrade ${def.name} for ${price} coins`);
      buy.onclick = () => this.buy(def.key, price);
      row.appendChild(buy);

      list.appendChild(row);
    }
    this.body.appendChild(list);
  }

  private buy(key: keyof UpgradeLevels, price: number): void {
    const data = this.save.get();
    if (data.coins < price) return;
    data.coins -= price;
    data.upgrades[key] += 1;
    this.save.save();
    this.audio.play('coin');
    this.render();
    this.onCoinsChanged?.();
  }

  private renderSkins(data: SaveData): void {
    const grid = make('div', 'skin-grid');
    const equipped = this.equippedId(data);
    for (const skin of this.cfg.skins) {
      const isOn = skin.id === equipped;
      const owned = isOn || data.ownedSkins.includes(skin.id);

      const card = make('div', isOn ? 'skin-card equipped' : 'skin-card');
      card.style.setProperty('--skin', skin.color);
      card.style.setProperty('--tracer', skin.tracer);

      const stage = make('div', 'skin-stage');
      stage.setAttribute('aria-hidden', 'true');
      stage.append(make('div', 'skin-capsule'), make('div', 'skin-tracer'));
      card.append(stage, make('div', 'skin-name', skin.name));

      let btn: HTMLButtonElement;
      if (isOn) {
        btn = make('button', 'btn equipped', 'EQUIPPED');
        btn.disabled = true;
        btn.setAttribute('aria-label', `${skin.name} equipped`);
      } else if (owned) {
        btn = make('button', 'btn', 'EQUIP');
        btn.setAttribute('aria-label', `Equip ${skin.name}`);
        btn.onclick = () => this.equipSkin(skin);
      } else {
        const afford = data.coins >= skin.price;
        btn = make('button', afford ? 'btn gold' : 'btn ghost', skin.price > 0 ? `● ${skin.price}` : 'FREE');
        btn.disabled = !afford;
        btn.setAttribute('aria-label', `Buy ${skin.name} for ${skin.price} coins`);
        btn.onclick = () => this.buySkin(skin);
      }
      btn.type = 'button';
      btn.dataset.key = `skin:${skin.id}`;
      card.appendChild(btn);
      grid.appendChild(card);
    }
    this.body.appendChild(grid);
  }

  private buySkin(skin: SkinDef): void {
    if (!this.save.buySkin(skin.id, skin.price)) return; // also equips it
    this.audio.play('coin');
    this.render();
    this.onSkinChanged?.(skin);
    this.onCoinsChanged?.();
  }

  private equipSkin(skin: SkinDef): void {
    if (!this.save.equipSkin(skin.id)) return;
    this.audio.play('click');
    this.render();
    this.onSkinChanged?.(skin);
  }

  private renderStore(data: SaveData): void {
    const list = make('div', 'shop-list');
    const busy = this.pending !== null;
    for (const p of this.iap.products()) {
      const row = make('div', 'shop-row');
      const info = make('div', 'shop-info');
      const icon = PRODUCT_ICON[p.id];
      info.append(
        make('div', 'shop-name', icon ? `${icon} ${p.title}` : p.title),
        make('div', 'shop-sub', p.id === 'remove_ads' ? 'No more ads between levels' : p.coins ? `+${p.coins} coins` : ''),
      );
      row.appendChild(info);

      let btn: HTMLButtonElement;
      if (p.id === 'remove_ads' && data.removeAds) {
        btn = make('button', 'btn equipped', 'OWNED');
        btn.disabled = true;
        btn.setAttribute('aria-label', `${p.title} owned`);
      } else {
        const inFlight = this.pending === p.id;
        btn = make('button', 'btn', inFlight ? '…' : p.price);
        btn.disabled = busy;
        btn.setAttribute('aria-label', `Buy ${p.title} for ${p.price}`);
        if (inFlight) btn.setAttribute('aria-busy', 'true');
        btn.onclick = () => void this.purchase(p);
      }
      btn.type = 'button';
      btn.dataset.key = `store:${p.id}`;
      row.appendChild(btn);
      list.appendChild(row);
    }

    const foot = make('div', 'store-foot');
    foot.appendChild(make('p', 'store-note', 'Test store - no real purchases are made.'));
    const restoring = this.pending === 'restore';
    const restore = make('button', 'btn ghost small', restoring ? '…' : 'RESTORE PURCHASES');
    restore.type = 'button';
    restore.dataset.key = 'restore';
    restore.disabled = busy;
    if (restoring) restore.setAttribute('aria-busy', 'true');
    restore.onclick = () => void this.restore();
    foot.append(restore, this.statusEl);
    this.body.append(list, foot);
  }

  /** Only repaint while visible: a purchase can settle after the shop was closed. */
  private refresh(): void {
    if (this.shown) this.render();
  }

  private async purchase(p: ProductInfo): Promise<void> {
    if (this.pending !== null) return;
    this.pending = p.id;
    this.audio.play('click');
    this.statusEl.textContent = '';
    this.refresh();
    let ok = false;
    try {
      ok = await this.iap.purchase(p.id);
    } catch {
      ok = false;
    }
    this.pending = null;
    const coins = ok && p.coins ? p.coins : 0;
    if (ok) {
      if (p.id === 'remove_ads') this.save.setRemoveAds(true);
      if (coins > 0) this.save.addCoins(coins);
      this.audio.play('coin');
    }
    this.refresh();
    this.statusEl.textContent = !ok
      ? 'Purchase not completed.'
      : coins > 0 ? `+${coins} coins added.` : `${p.title} unlocked.`;
    if (coins > 0) this.onCoinsChanged?.();
  }

  private async restore(): Promise<void> {
    if (this.pending !== null) return;
    this.pending = 'restore';
    this.audio.play('click');
    this.statusEl.textContent = '';
    this.refresh();
    let ids: ProductId[] | null = null;
    try {
      ids = await this.iap.restore();
    } catch {
      ids = null;
    }
    this.pending = null;
    const ads = Array.isArray(ids) && ids.includes('remove_ads');
    if (ads) {
      this.save.setRemoveAds(true);
      this.audio.play('coin');
    }
    this.refresh();
    this.statusEl.textContent = ids === null
      ? 'Restore failed. Try again later.'
      : ads ? 'Remove Ads restored.' : 'Nothing to restore.';
  }
}
