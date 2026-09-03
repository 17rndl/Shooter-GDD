import type { GameConfig, UpgradeLevels } from '../data/types';
import type { SaveService } from '../services/SaveService';
import type { AudioService } from '../services/AudioService';

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

// Coin-sink shop. Buys raise stats fed into CrowdController / economy at run start.
export class ShopPanel {
  private root: HTMLDivElement;
  private coinsEl: HTMLDivElement;
  private list: HTMLDivElement;
  private returnFn: () => void;

  constructor(
    private save: SaveService,
    private cfg: GameConfig,
    private audio: AudioService,
    private defaultClose: () => void,
  ) {
    this.returnFn = defaultClose;
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute', inset: '0', display: 'none', flexDirection: 'column',
      alignItems: 'center', gap: '14px', padding: '20px 18px',
      background: 'rgba(6,10,22,0.94)', color: '#fff', pointerEvents: 'auto', overflowY: 'auto',
    } as CSSStyleDeclaration);
    // keep shop taps out of the game's steer input (it listens on #app)
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('h1');
    title.textContent = 'UPGRADES';
    Object.assign(title.style, { fontSize: '28px', fontWeight: '900', marginTop: '8px' } as CSSStyleDeclaration);
    this.root.appendChild(title);

    this.coinsEl = document.createElement('div');
    Object.assign(this.coinsEl.style, {
      fontSize: '22px', fontWeight: '900', color: '#ffd24a',
    } as CSSStyleDeclaration);
    this.root.appendChild(this.coinsEl);

    this.list = document.createElement('div');
    Object.assign(this.list.style, {
      display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '360px', flex: '1',
    } as CSSStyleDeclaration);
    this.root.appendChild(this.list);

    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'BACK';
    back.onclick = () => { this.audio.play('click'); this.close(); };
    this.root.appendChild(back);

    document.getElementById('hud')!.appendChild(this.root);
  }

  private cost(level: number): number {
    const e = this.cfg.economy;
    return Math.ceil(e.upgradeCostBase * Math.pow(e.upgradeCostGrowth, level));
  }

  private render(): void {
    const data = this.save.get();
    this.coinsEl.textContent = `● ${data.coins}`;
    this.list.innerHTML = '';

    for (const def of UPGRADES) {
      const lvl = data.upgrades[def.key];
      const maxed = lvl >= def.max;
      const price = this.cost(lvl);
      const afford = data.coins >= price && !maxed;

      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px',
        background: 'rgba(255,255,255,0.08)', borderRadius: '14px',
        border: '1px solid rgba(255,255,255,0.12)',
      } as CSSStyleDeclaration);

      const info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML =
        `<div style="font-weight:800;font-size:16px">${def.icon} ${def.name}</div>` +
        `<div style="opacity:0.75;font-size:13px">Lv ${lvl}/${def.max} · ${def.effect(lvl)}</div>`;
      row.appendChild(info);

      const buy = document.createElement('button');
      buy.className = afford ? 'btn gold' : 'btn ghost';
      Object.assign(buy.style, { padding: '10px 14px', fontSize: '14px', minWidth: '92px' } as CSSStyleDeclaration);
      buy.textContent = maxed ? 'MAX' : `● ${price}`;
      buy.disabled = !afford;
      if (!afford) buy.style.opacity = '0.55';
      buy.onclick = () => this.buy(def.key, price);
      row.appendChild(buy);

      this.list.appendChild(row);
    }
  }

  private buy(key: keyof UpgradeLevels, price: number): void {
    const data = this.save.get();
    if (data.coins < price) return;
    data.coins -= price;
    data.upgrades[key] += 1;
    this.save.save();
    this.audio.play('coin');
    this.render();
  }

  /** Open the shop. When closed, returns to `returnTo` (defaults to the menu). */
  open(returnTo?: () => void): void {
    this.returnFn = returnTo ?? this.defaultClose;
    this.render();
    this.root.style.display = 'flex';
  }

  close(): void {
    this.root.style.display = 'none';
    this.returnFn();
  }
}
