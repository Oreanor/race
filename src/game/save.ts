/** Mid-drive progress: survives a page reload, cleared when you exit to the menu. */
export type GameSave = {
  money: number;
  /** tank fill 0…1 */
  fuel: number;
  hp: number;
  carId: string;
  position: [number, number];
  heading: number;
  place: { name: string; country: string; coords: [number, number] };
};

const STORE = 'cityRider.save';

export function loadSave(): GameSave | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const data = JSON.parse(raw) as GameSave;
    if (!data || !Array.isArray(data.position) || data.position.length !== 2) return null;
    if (!Number.isFinite(data.money) || !data.carId) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSave(save: GameSave) {
  try {
    localStorage.setItem(STORE, JSON.stringify(save));
  } catch { /* private mode: this session only */ }
}

export function clearSave() {
  try {
    localStorage.removeItem(STORE);
  } catch { /* private mode */ }
}
