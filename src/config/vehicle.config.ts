export const vehicleConfig = { maxSpeed: 25, reverseSpeed: 25/3.6, acceleration: 7, braking: 12, drag: 1.7, handbrake: 22, wheelbase: 2.6 };
// acceleration m/s², maxSpeed m/s, mass kg, engine litres (upgradable later); fuel: tank in litres, game-scaled consumption in litres per km (range ≈ tank / perKm)
/** Shelf order: cheapest → most expensive (see carPrice). */
export const cars = [
  { id: '15', name: 'VW Beetle', label: 'Народный жук', path: '/models/vw-bug.glb', length: 4.0, yaw: Math.PI/2, color: '#e8c547', acceleration: 7.5, maxSpeed: 125 / 3.6, mass: 820, engine: 1.6, fuel: { tank: 40, perKm: 0.9 } },
  { id: '02', name: 'Ford 31', label: 'Другой взгляд на город', path: '/models/car-2.glb', length: 4.2, yaw: Math.PI/2, color: '#a4b9a0', acceleration: 12, maxSpeed: 140 / 3.6, mass: 1050, engine: 3.3, fuel: { tank: 55, perKm: 1.3 } },
  { id: '17', name: 'Family Sedan', label: 'Розовый семейный седан', path: '/models/family-car.glb', length: 4.9, yaw: Math.PI/2, color: '#e89bb5', acceleration: 7.5, maxSpeed: 140 / 3.6, mass: 1500, engine: 3.7, fuel: { tank: 60, perKm: 1.6 } },
  { id: '16', name: 'ГАЗ-24 Милиция', label: 'Волга на страже порядка', path: '/models/gaz-24-militia.glb', length: 4.73, yaw: Math.PI/2, color: '#f2b705', acceleration: 7, maxSpeed: 145 / 3.6, mass: 1420, engine: 2.4, fuel: { tank: 55, perKm: 1.4 } },
  { id: '08', name: 'Ford 32 Tudor', label: 'Хот-род тридцатых', path: '/models/ford-32-tudor.glb', length: 4.1, yaw: Math.PI/2, color: '#7a2f2a', acceleration: 9, maxSpeed: 130 / 3.6, mass: 1100, engine: 3.6, fuel: { tank: 53, perKm: 1.5 } },
  { id: '10', name: 'Chevy Taxi', label: 'Такси по всему миру', path: '/models/chevy-taxi.glb', length: 4.9, yaw: Math.PI/2, color: '#f2c230', acceleration: 9, maxSpeed: 140 / 3.6, mass: 1500, engine: 3.9, fuel: { tank: 65, perKm: 1.7 } },
  { id: '07', name: 'ВАЗ-2108 Time Machine', label: 'Назад в будущее по-нашему', path: '/models/vaz2108.glb', length: 4.0, yaw: Math.PI/2, color: '#b9bcc0', acceleration: 8.5, maxSpeed: 160 / 3.6, mass: 900, engine: 1.3, fuel: { tank: 43, perKm: 1.0 } },
  { id: '03', name: 'Howler', label: 'Громкий характер', path: '/models/car-3.glb', length: 7.5, yaw: Math.PI/2, color: '#c4b7a2', acceleration: 9.5, maxSpeed: 120 / 3.6, mass: 2400, engine: 6.2, fuel: { tank: 70, perKm: 3.0 } },
  { id: '18', name: 'Fire Truck №5', label: 'Вода под давлением', path: '/models/fire-truck-no5.glb', length: 5.5, yaw: Math.PI/2, color: '#c62828', acceleration: 5.8, maxSpeed: 100 / 3.6, mass: 12500, engine: 8.8, fuel: { tank: 220, perKm: 4.8 } },
  { id: '09', name: 'Fleetline Police', label: 'Закон и порядок', path: '/models/fleetline-police.glb', length: 4.9, yaw: Math.PI/2, color: '#2c3a52', acceleration: 10, maxSpeed: 150 / 3.6, mass: 1550, engine: 3.5, fuel: { tank: 60, perKm: 1.8 } },
  { id: '12', name: 'Mustang 65', label: 'Дикая лошадь шестидесятых', path: '/models/mustang-65.glb', length: 4.6, yaw: Math.PI/2, color: '#c45c2a', acceleration: 10.5, maxSpeed: 190 / 3.6, mass: 1280, engine: 4.7, fuel: { tank: 60, perKm: 1.7 } },
  { id: '04', name: 'Toyota Supra 82', label: 'Японская классика', path: '/models/supra-82.glb', length: 4.6, yaw: Math.PI/2, color: '#d9d4c8', acceleration: 11, maxSpeed: 200 / 3.6, mass: 1300, engine: 2.8, fuel: { tank: 61, perKm: 1.6 } },
  { id: '01', name: 'Ferrari Diaboro', label: 'Первый характер', path: '/models/car.glb', length: 4.2, yaw: Math.PI/2, color: '#f1a453', acceleration: 16, maxSpeed: 50, mass: 1300, engine: 4.7, fuel: { tank: 45, perKm: 2.4 } },
  { id: '14', name: 'Optimus', label: 'Робот в маскировке', path: '/models/optimus.glb', length: 5.8, yaw: Math.PI/2, color: '#b71c1c', acceleration: 12, maxSpeed: 180 / 3.6, mass: 3800, engine: 14.0, fuel: { tank: 150, perKm: 3.8 } },
  { id: '13', name: 'Mustang GT 2018', label: 'Пятилитровый рык', path: '/models/mustang-2018.glb', length: 4.8, yaw: Math.PI/2, color: '#1a3a6b', acceleration: 13.5, maxSpeed: 250 / 3.6, mass: 1700, engine: 5.0, fuel: { tank: 59, perKm: 2.1 } },
  { id: '05', name: 'Ford GT40', label: 'Победитель Ле-Мана', path: '/models/gt40.glb', length: 4.1, yaw: Math.PI/2, color: '#4a78c2', acceleration: 15, maxSpeed: 300 / 3.6, mass: 1000, engine: 4.7, fuel: { tank: 70, perKm: 2.6 } },
  { id: '06', name: 'Batmobile', label: 'Ночной защитник', path: '/models/batmobile.glb', length: 5.2, yaw: Math.PI/2, color: '#30333a', acceleration: 17, maxSpeed: 320 / 3.6, mass: 2300, engine: 7.0, fuel: { tank: 80, perKm: 3.4 } },
  { id: '11', name: 'McLaren F1 GTR', label: 'Король Ле-Мана 95', path: '/models/mclaren-f1-gtr.glb', length: 4.4, yaw: Math.PI/2, color: '#e8e4da', acceleration: 16.5, maxSpeed: 330 / 3.6, mass: 1050, engine: 6.1, fuel: { tank: 90, perKm: 2.8 } },
];
export const cities = [
  { name:'Coimbra', country:'Portugal', coords:[-8.42922,40.20805] as [number,number], heading:145, road:'Avenida Emídio Navarro', note:'У реки, среди холмов' },
  { name:'Lisbon', country:'Portugal', coords:[-9.14517,38.71923] as [number,number], heading:330, road:'Avenida da Liberdade', note:'Свет, холмы и Атлантика' },
  { name:'Porto', country:'Portugal', coords:[-8.61085,41.14826] as [number,number], heading:0, road:'Avenida dos Aliados', note:'Красочные улицы над Дору' },
  { name:'Paris', country:'France', coords:[2.30764,48.86980] as [number,number], heading:295, road:'Avenue des Champs-Élysées', note:'Большие бульвары, маленькие открытия' },
  { name:'London', country:'United Kingdom', coords:[-0.12615,51.50080] as [number,number], heading:90, road:'Bridge Street', note:'По другую сторону Темзы' },
  { name:'New York', country:'United States', coords:[-73.98548,40.75803] as [number,number], heading:29, road:'7th Avenue', note:'Город, который не останавливается' },
  { name:'Tokyo', country:'Japan', coords:[139.70060,35.65957] as [number,number], heading:30, road:'Meiji-dori', note:'Новый поворот на каждом квартале' },
];
export type City = typeof cities[number];
export type Car = typeof cars[number];

/** Coins on a fresh start; the intro car is bought out of this purse. */
export const STARTING_CASH = 5000;

/** Shelf prices pinned into the starter tier (≤ STARTING_CASH). */
const STARTER_PRICE: Partial<Record<string, number>> = {
  '02': 4500, // Ford 31
  '17': 4800, // Family Sedan
};

/** Always join the player's garage (gifts / unlocks), even on an old save. */
export const GIFT_CARS = ['18'] as const;

/** Dealership sticker for gifted / special cars outside the speed curve. */
const PINNED_PRICE: Partial<Record<string, number>> = {
  '18': 7200, // Fire Truck №5
};

/**
 * Showroom price in coins. Steep curve on speed and punch so a starter purse
 * only covers the slowest beaters; race cars need arena / bounty money.
 */
export function carPrice(car: Car): number {
  const pinned = STARTER_PRICE[car.id] ?? PINNED_PRICE[car.id];
  if (pinned != null) return pinned;
  const kph = car.maxSpeed * 3.6;
  const raw =
    (kph / 125) ** 2.8 * 2200 +
    (car.acceleration / 8) ** 2.9 * 1600 +
    (car.engine / 2.5) ** 1.7 * 500;
  return Math.max(1500, Math.round(raw / 100) * 100);
}

/** What the dealership pays for the car you drive in (half the shelf price). */
export function tradeInPrice(car: Car): number {
  return Math.floor(carPrice(car) / 2);
}

export const mapConfig = {
  dem: {
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    tileSize: 256,
    encoding: 'terrarium' as const,
    maxzoom: 15,
    attribution: 'Terrain © <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen</a>, AWS Open Data',
  },
};
