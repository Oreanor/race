/** Progress: survives a reload and a return to the intro (money, garage, last spot). */
export type GameSave = {
  money: number;
  /** tank fill 0…1 */
  fuel: number;
  hp: number;
  carId: string;
  position: [number, number];
  heading: number;
  place: { name: string; country: string; coords: [number, number] };
  /** road coin ids already taken — stay gone after reload */
  collected?: string[];
  /** owed to the bank */
  loan?: number;
  /** ids of the cars we own */
  garage?: string[];
};

const STORE = 'cityRider.save';

export function loadSave(): GameSave | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const data = JSON.parse(raw) as GameSave;
    if (!data || !Array.isArray(data.position) || data.position.length !== 2) return null;
    if (!Number.isFinite(data.money) || !data.carId) return null;
    if (data.collected != null && !Array.isArray(data.collected)) return null;
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
