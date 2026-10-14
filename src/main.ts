import { GameManager } from './core/GameManager';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const game = new GameManager(canvas);
(window as unknown as { __game: GameManager }).__game = game;
game.boot().catch((err) => {
  console.error('Failed to boot game:', err);
  const o = document.getElementById('overlay');
  const t = document.getElementById('overlay-title');
  const b = document.getElementById('overlay-body');
  if (o && t && b) {
    // ConfigLoader / LevelRepository errors name the file and the bad field
    t.textContent = 'Failed to load';
    b.textContent = String(err);
    document.getElementById('overlay-btn')?.classList.add('hidden'); // nothing to start
    o.classList.add('show');
  }
});
