'use client';
import { useEffect, type ReactNode } from 'react';
import { cars, carPrice, STARTING_CASH, type Car } from '@/config/vehicle.config';
import {
  RACE_FEE, RACE_PRIZE, ARENA_FEE, ARENA_PRIZE, LOAN_LIMIT, LOAN_RATE, CASH_BUNDLE, IMPOUND_REWARD,
  FIRE_WINDOW_COIN, AMBULANCE_VICTIM_COIN, TAXI_PER_KM, BUS_FARE_MIN, BUS_FARE_MAX, BUS_PER_PERSON_KM,
  HAULER_ID, FIRE_TRUCK_ID, AMBULANCE_ID, TAXI_ID, BUS_ID, BATMOBILE_ID, POLICE_IDS, UNARMED_IDS,
} from '@/game/tuning';
import { COLLECT_REWARD, COLLECT_BOXES } from '@/game/Errands';
import { FUEL_PRICE, REPAIR_PRICE, EVACUATION_COST } from '@/game/Fuel';
import { formatNumber, getLang, t } from '@/i18n';
import { useLang } from '@/i18n/react';
import { Price } from './Price';

/**
 * Settings → How to play: what the game is, how money is made and spent, the places
 * on the map and every car with its numbers. Sums come from the game's own constants,
 * so the page never drifts from what the game really charges and pays.
 */

type Lang = 'en' | 'ru' | 'pt';
type Copy = {
  intro: ReactNode[];
  sections: { title: string; items: ReactNode[] }[];
  table: { title: string; car: string; price: string; top: string; accel: string; engine: string; range: string; special: string; note: string };
  special: Record<string, string>;
  guns: string;
};

const P = (n: number) => <Price value={n} />;
const pct = Math.round(LOAN_RATE * 100);

function copy(lang: Lang): Copy {
  if (lang === 'ru') return {
    intro: [
      <>Это открытый мир размером с планету: <b>любой город Земли</b> — настоящие улицы, дома, рельеф, реки и мосты — и в нём можно ездить на самых крутых машинах, от «жука» до LaFerrari.</>,
      <>Можно просто кататься и любоваться: менять время суток и сезон, архитектуру, летать между городами. А можно брать миссии, зарабатывать монеты и покупать новые машины в гараж. На старте у вас {P(STARTING_CASH)}.</>,
    ],
    sections: [
      { title: 'Миссии', items: [
        <>На карте всегда висят четыре метки: гонка, арена, доставка и коробки. Подъедьте к метке — и миссия начнётся. <b>Tab</b> — к следующей.</>,
        <><b>Гонка</b>: взнос {P(RACE_FEE)}, извилистый курс ~5 км, пять чекпоинтов и финиш, три соперника, 10 минут. Первым — {P(RACE_PRIZE)}.</>,
        <><b>Арена</b>: взнос {P(ARENA_FEE)}, уничтожить три вооружённые машины. Победа — {P(ARENA_PRIZE)}. Только на машине с оружием.</>,
        <><b>Доставка</b>: отвезти посылку по адресу в 1–2,5 км — от 1 300 до 2 850 монет, чем дальше, тем больше.</>,
        <><b>Коробки</b>: {COLLECT_BOXES} коробок в радиусе 2 км, собрать все наездом — {P(COLLECT_REWARD)}.</>,
        <>Особые машины получают свою работу: такси, автобус, скорая, пожарная, эвакуатор, полиция — см. таблицу ниже.</>,
      ] },
      { title: 'Места на карте', items: [
        <><b>Заправка</b>: топливо по {FUEL_PRICE} монете за литр, бак тратится по реальному расходу машины, буст (Space) жжёт больше. Кончилось — эвакуатор (<b>E</b>) довезёт до ближайшей заправки и зальёт бак за {P(EVACUATION_COST)}.</>,
        <><b>Автосервис</b>: ремонт — {REPAIR_PRICE} монета за единицу прочности, можно чинить частично.</>,
        <><b>Автосалон</b>: купить новую машину или пересесть на любую из гаража. <b>C</b> — следующая машина из гаража прямо на ходу.</>,
        <><b>Банк</b>: кредит до {P(LOAN_LIMIT)} под {pct}% без срока, один за раз. А можно и ограбить: стрелять по банку 3 секунды — пачки по {P(CASH_BUNDLE)}, и за вами полиция. Оторваться от каждой машины на 2 км — деньги ваши; поймают — штраф 18–25 тыс. плюс украденное.</>,
        <><b>Аэропорт, порт, вокзал</b>: перелёт, рейс или поезд в другой город мира, цена зависит от расстояния (поезд дешевле самолёта).</>,
        <><b>Больница, полиция</b>: туда везут пострадавших и эвакуированные машины; там же вы очнётесь, если машину разбили.</>,
      ] },
      { title: 'Ещё', items: [
        <><b>H</b> — угнать припаркованную машину рядом: полиция в погоню, оторвётесь — машина уйдёт на чёрный рынок за полцены.</>,
        <><b>J</b> — поставить трамплин, <b>T</b> — время суток (Shift+T — сезон), <b>Y</b> — стиль архитектуры, <b>M</b> — карта, клик ставит цель.</>,
        <>Онлайн вы ездите в одном мире с другими игроками; <b>Enter</b> — чат. Трафик мирный, но если по нему стрелять или таранить, он может разозлиться.</>,
        <>Деньги, гараж и прогресс сохраняются. «Начать заново» в настройках стирает всё.</>,
      ] },
    ],
    table: { title: 'Машины', car: 'Машина', price: 'Цена', top: 'Макс.', accel: '0–100', engine: 'Двиг.', range: 'Запас', special: 'Особенность', note: 'Скорость в км/ч, разгон в секундах, запас хода в км на полном баке.' },
    special: {
      [HAULER_ID]: 'Эвакуатор: трос (ЛКМ) цепляет машины, задания «забрать на штрафстоянку» — +' + formatNumber(IMPOUND_REWARD),
      [FIRE_TRUCK_ID]: 'Брандспойт; тушить пожары — +' + FIRE_WINDOW_COIN + ' за окно',
      [AMBULANCE_ID]: 'Пострадавших в больницу — +' + formatNumber(AMBULANCE_VICTIM_COIN) + ' за каждого',
      [TAXI_ID]: 'Пассажиры — +' + TAXI_PER_KM + ' за км',
      [BUS_ID]: `Остановки (+${BUS_FARE_MIN}…${BUS_FARE_MAX}) и экскурсии (+${BUS_PER_PERSON_KM} за человеко-км)`,
      [BATMOBILE_ID]: 'Оружие, охота за разыскиваемыми, трос (ПКМ)',
      police: 'Мигалки (F), охота за разыскиваемыми',
    },
    guns: 'Оружие',
  };
  if (lang === 'pt') return {
    intro: [
      <>Um mundo aberto do tamanho do planeta: <b>qualquer cidade da Terra</b> — ruas, casas, relevo, rios e pontes reais — para conduzir os carros mais incríveis, do Carocha ao LaFerrari.</>,
      <>Pode só passear e apreciar: mudar a hora e a estação, a arquitetura, voar entre cidades. Ou fazer missões, ganhar moedas e comprar carros novos para a garagem. Começa com {P(STARTING_CASH)}.</>,
    ],
    sections: [
      { title: 'Missões', items: [
        <>No mapa há sempre quatro marcas: corrida, arena, entrega e caixas. Chegue à marca e a missão começa. <b>Tab</b> — a seguinte.</>,
        <><b>Corrida</b>: inscrição {P(RACE_FEE)}, ~5 km sinuosos, cinco pontos de controlo e a meta, três rivais, 10 minutos. Em primeiro — {P(RACE_PRIZE)}.</>,
        <><b>Arena</b>: inscrição {P(ARENA_FEE)}, destruir três carros armados. Vitória — {P(ARENA_PRIZE)}. Só com um carro armado.</>,
        <><b>Entrega</b>: levar um pacote a uma morada a 1–2,5 km — 1 300 a 2 850 moedas, quanto mais longe, mais.</>,
        <><b>Caixas</b>: {COLLECT_BOXES} caixas num raio de 2 km, apanhe todas — {P(COLLECT_REWARD)}.</>,
        <>Os carros especiais têm o seu trabalho: táxi, autocarro, ambulância, bombeiros, reboque, polícia — veja a tabela.</>,
      ] },
      { title: 'Lugares no mapa', items: [
        <><b>Posto de combustível</b>: {FUEL_PRICE} moeda por litro, o consumo é o real do carro, o turbo (Space) gasta mais. Sem combustível — o reboque (<b>E</b>) leva-o ao posto mais próximo e enche o depósito por {P(EVACUATION_COST)}.</>,
        <><b>Oficina</b>: reparação a {REPAIR_PRICE} moeda por ponto, também parcial.</>,
        <><b>Stand</b>: comprar um carro ou trocar para outro da garagem. <b>C</b> — o próximo carro da garagem a andar.</>,
        <><b>Banco</b>: empréstimo até {P(LOAN_LIMIT)} a {pct}%, sem prazo, um de cada vez. Ou assalte-o: dispare 3 segundos — maços de {P(CASH_BUNDLE)} e a polícia atrás. Fuja 2 km de cada carro e o dinheiro é seu; apanhado — multa de 18–25 mil mais o roubado.</>,
        <><b>Aeroporto, porto, estação</b>: avião, barco ou comboio para outra cidade do mundo; o preço depende da distância.</>,
        <><b>Hospital, polícia</b>: para lá vão os feridos e os carros rebocados; e é lá que acorda se o carro for destruído.</>,
      ] },
      { title: 'Mais', items: [
        <><b>H</b> — roubar um carro estacionado ao lado: a polícia persegue; fuja e o carro vai para o mercado negro por metade do preço.</>,
        <><b>J</b> — rampa, <b>T</b> — hora do dia (Shift+T — estação), <b>Y</b> — estilo de arquitetura, <b>M</b> — mapa, clique para marcar o destino.</>,
        <>Online conduz no mesmo mundo que outros jogadores; <b>Enter</b> — chat. O trânsito é calmo, mas se disparar ou bater nele pode zangar-se.</>,
        <>Dinheiro, garagem e progresso ficam guardados. «Recomeçar» nas definições apaga tudo.</>,
      ] },
    ],
    table: { title: 'Carros', car: 'Carro', price: 'Preço', top: 'Máx.', accel: '0–100', engine: 'Motor', range: 'Autonomia', special: 'Especial', note: 'Velocidade em km/h, aceleração em segundos, autonomia em km com o depósito cheio.' },
    special: {
      [HAULER_ID]: 'Reboque: cabo (LMB) prende carros, trabalhos de apreensão — +' + formatNumber(IMPOUND_REWARD),
      [FIRE_TRUCK_ID]: 'Mangueira; apagar incêndios — +' + FIRE_WINDOW_COIN + ' por janela',
      [AMBULANCE_ID]: 'Feridos ao hospital — +' + formatNumber(AMBULANCE_VICTIM_COIN) + ' cada',
      [TAXI_ID]: 'Passageiros — +' + TAXI_PER_KM + ' por km',
      [BUS_ID]: `Paragens (+${BUS_FARE_MIN}…${BUS_FARE_MAX}) e excursões (+${BUS_PER_PERSON_KM} por pessoa·km)`,
      [BATMOBILE_ID]: 'Armas, caça aos procurados, cabo (RMB)',
      police: 'Luzes (F), caça aos procurados',
    },
    guns: 'Armas',
  };
  return {
    intro: [
      <>An open world the size of the planet: <b>any city on Earth</b> — real streets, houses, hills, rivers and bridges — to drive in the coolest cars, from a Beetle to a LaFerrari.</>,
      <>You can just cruise and take it in: change the time of day and the season, the architecture, fly between cities. Or take missions, earn coins and buy new cars for your garage. You start with {P(STARTING_CASH)}.</>,
    ],
    sections: [
      { title: 'Missions', items: [
        <>Four markers are always on the map: race, arena, delivery and boxes. Drive up to one and it starts. <b>Tab</b> — the next one.</>,
        <><b>Race</b>: entry {P(RACE_FEE)}, a winding ~5 km course, five checkpoints then the finish, three rivals, 10 minutes. Win — {P(RACE_PRIZE)}.</>,
        <><b>Arena</b>: entry {P(ARENA_FEE)}, destroy three armed cars. Win — {P(ARENA_PRIZE)}. Armed cars only.</>,
        <><b>Delivery</b>: take a parcel to an address 1–2.5 km away — 1,300 to 2,850 coins, the farther the more.</>,
        <><b>Boxes</b>: {COLLECT_BOXES} boxes within 2 km, drive over them all — {P(COLLECT_REWARD)}.</>,
        <>Special cars get their own jobs: taxi, bus, ambulance, fire truck, tow truck, police — see the table.</>,
      ] },
      { title: 'Places on the map', items: [
        <><b>Fuel station</b>: {FUEL_PRICE} coin per litre; the tank drains at the car's real consumption, the boost (Space) burns more. Run dry — the tow truck (<b>E</b>) takes you to the nearest station and fills up for {P(EVACUATION_COST)}.</>,
        <><b>Car service</b>: repairs at {REPAIR_PRICE} coin per point, partial repairs too.</>,
        <><b>Dealership</b>: buy a new car or switch to any car in your garage. <b>C</b> — the next garage car on the go.</>,
        <><b>Bank</b>: a loan up to {P(LOAN_LIMIT)} at {pct}%, no term, one at a time. Or rob it: fire at it for 3 seconds — bundles of {P(CASH_BUNDLE)} and the police on you. Get 2 km ahead of each car and the cash is yours; caught — a fine of 18–25k plus the loot.</>,
        <><b>Airport, port, station</b>: fly, sail or ride to another city in the world; the price depends on the distance.</>,
        <><b>Hospital, police</b>: where victims and towed cars go — and where you wake up if your car is wrecked.</>,
      ] },
      { title: 'More', items: [
        <><b>H</b> — hijack a parked car beside you: the police give chase; lose them and it goes to the black market for half its price.</>,
        <><b>J</b> — a ramp, <b>T</b> — time of day (Shift+T — season), <b>Y</b> — architecture style, <b>M</b> — the map, click to pin a target.</>,
        <>Online you share the world with other players; <b>Enter</b> — chat. Traffic is calm, but shoot or ram it and it may turn on you.</>,
        <>Money, garage and progress are saved. «Start over» in the settings wipes it all.</>,
      ] },
    ],
    table: { title: 'Cars', car: 'Car', price: 'Price', top: 'Top', accel: '0–100', engine: 'Engine', range: 'Range', special: 'Special', note: 'Speed in km/h, 0–100 in seconds, range in km on a full tank.' },
    special: {
      [HAULER_ID]: 'Tow truck: the cable (LMB) hooks cars; impound jobs — +' + formatNumber(IMPOUND_REWARD),
      [FIRE_TRUCK_ID]: 'Water hose; fire calls — +' + FIRE_WINDOW_COIN + ' per window',
      [AMBULANCE_ID]: 'Victims to hospital — +' + formatNumber(AMBULANCE_VICTIM_COIN) + ' each',
      [TAXI_ID]: 'Passenger fares — +' + TAXI_PER_KM + ' per km',
      [BUS_ID]: `Bus stops (+${BUS_FARE_MIN}…${BUS_FARE_MAX}) and tours (+${BUS_PER_PERSON_KM} per person·km)`,
      [BATMOBILE_ID]: 'Guns, wanted hunts, cable (RMB)',
      police: 'Police lights (F), wanted hunts',
    },
    guns: 'Guns',
  };
}

function specialOf(car: Car, c: Copy) {
  if (POLICE_IDS.has(car.id)) return `${c.special.police}, ${c.guns.toLowerCase()}`;
  return c.special[car.id] ?? (UNARMED_IDS.has(car.id) ? '' : c.guns);
}

export default function RulesDialog({ onClose }: { onClose: () => void }) {
  useLang();
  const lang = getLang();
  const c = copy(lang === 'ru' || lang === 'pt' ? lang : 'en');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const shelf = [...cars].sort((a, b) => carPrice(a) - carPrice(b));
  return (
    <div className="ui-backdrop" role="presentation" onPointerDown={onClose}>
      <section className="ui-dialog rules" role="dialog" aria-label={t('rules.title')} onPointerDown={(e) => e.stopPropagation()}>
        <h2 className="ui-title">{t('rules.title')}</h2>
        <div className="rules-body">
          {c.intro.map((p, i) => <p key={i} className="rules-lead">{p}</p>)}
          {c.sections.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <ul>{s.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </section>
          ))}
          <section>
            <h3>{c.table.title}</h3>
            <div className="rules-table">
              <table>
                <thead>
                  <tr><th>{c.table.car}</th><th>{c.table.price}</th><th>{c.table.top}</th><th>{c.table.accel}</th><th>{c.table.engine}</th><th>{c.table.range}</th><th>{c.table.special}</th></tr>
                </thead>
                <tbody>
                  {shelf.map((car) => (
                    <tr key={car.id}>
                      <td className="rules-car">{car.name}</td>
                      <td><Price value={carPrice(car)} /></td>
                      <td>{formatNumber(Math.round(car.maxSpeed * 3.6))}</td>
                      <td>{formatNumber(Math.round(100 / 3.6 / car.acceleration * 10) / 10)}</td>
                      <td>{formatNumber(car.engine)} L</td>
                      <td>{formatNumber(Math.round(car.fuel.tank / car.fuel.perKm))}</td>
                      <td className="rules-special">{specialOf(car, c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ui-text">{c.table.note}</p>
          </section>
        </div>
        <div className="ui-actions">
          <button type="button" className="ui-btn" autoFocus onClick={onClose}>{t('keys.close')}</button>
        </div>
      </section>
    </div>
  );
}
