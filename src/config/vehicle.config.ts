export const vehicleConfig = { maxSpeed: 25, reverseSpeed: 25/3.6, acceleration: 7, braking: 12, drag: 1.7, handbrake: 22, wheelbase: 2.6 };
// fuel: tank in litres, game-scaled consumption in litres per km (range ≈ tank / perKm)
export const cars = [
  { id: '01', name: 'Ferrari Diaboro', label: 'Первый характер', path: '/models/car.glb', length: 4.2, yaw: Math.PI/2, color: '#f1a453', acceleration: 16, maxSpeed: 50, fuel: { tank: 45, perKm: 2.4 } },
  { id: '02', name: 'Ford 31', label: 'Другой взгляд на город', path: '/models/car-2.glb', length: 4.2, yaw: Math.PI/2, color: '#a4b9a0', acceleration: 12, maxSpeed: 33, fuel: { tank: 55, perKm: 1.3 } },
  { id: '03', name: 'Howler', label: 'Громкий характер', path: '/models/car-3.glb', length: 4.2, yaw: Math.PI/2, color: '#c4b7a2', acceleration: 9.5, maxSpeed: 25, fuel: { tank: 70, perKm: 3.0 } },
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
export const mapConfig = {
  style: 'https://tiles.openfreemap.org/styles/liberty',
  dem: {
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    tileSize: 256,
    encoding: 'terrarium' as const,
    maxzoom: 15,
    attribution: 'Рельеф © <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen</a>, AWS Open Data',
  },
};
