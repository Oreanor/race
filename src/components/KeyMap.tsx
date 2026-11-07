'use client'
import { useMemo, useState } from 'react'
import { t } from '@/i18n'
import type { MessageKey } from '@/i18n/messages'
import { useLang } from '@/i18n/react'

type Key = MessageKey
/** Board colours: CSS tokens (.keymap in globals.css), so the map follows the light/night theme. */
const UI = { PRIMARY: 'var(--km-primary)', DIM: 'var(--km-dim)', TARGET: 'var(--km-target)' }

/**
 * Схема управления: клавиатура квадратиками, мышь и выноски «клавиша — зачем».
 *
 * Перенесено из соседнего проекта elite; подписи — пары `keys.X` / `keys.X.what`.
 *
 * Подпись уходит к БЛИЖАЙШЕМУ краю: верхние ряды — в строку над клавиатурой, нижние — под
 * ней, середина — в боковые колонки. Строки вмещают по нескольку подписей; что не влезло,
 * уходит на следующий по близости край. Порядок в колонке подбирается так, чтобы лучи не
 * перекрещивались, а сами лучи прячутся ЗА непрозрачными клавишами — видны только в щелях.
 */

/** Шаг клавиши в единицах схемы. Всё остальное меряется в нём. */
const U = 40
/** Зазор между соседними клавишами. */
const KEY_GAP = 5
/** Ширина колонки выносок и её отступ от клавиатуры. */
const COL_W = 300
const COL_GAP = 70
/** Строка подписи: кегль, интерлиньяж и сколько знаков моноширинного влезает в колонку. */
const FONT = 14
const LINE_H = 18
/** Ширина моноширинного знака в долях кегля (Consolas). */
const CHAR_W = FONT * 0.55
/** Подпись в строке над/под клавиатурой: ширина, зазор между соседями и отступ от клавиш. */
const ROW_LABEL_W = 176
const ROW_LABEL_GAP = 14
const ROW_GAP = 44
/** Воздух между выносками в колонке. */
const SLOT_GAP = 10

/** Ряд клавиатуры: подпись на клавише, код (`KeyboardEvent.code`) и ширина в шагах. */
type KeyRow = [label: string, code: string, width: number][]

const letters = (s: string): KeyRow => [...s].map((c) => [c, `Key${c}`, 1])

/** Упрощённая 60%-клавиатура: каждый ряд ровно 15 шагов. */
const ROWS: KeyRow[] = [
  [
    ['Esc', 'Escape', 1],
    ...[...'1234567890'].map((c): KeyRow[number] => [c, `Digit${c}`, 1]),
    ['-', 'Minus', 1],
    ['=', 'Equal', 1],
    ['⌫', 'Backspace', 2],
  ],
  [['Tab', 'Tab', 1.5], ...letters('QWERTYUIOP'), ['[', 'BracketLeft', 1], [']', 'BracketRight', 1], ['\\', 'Backslash', 1.5]],
  [['Caps', 'CapsLock', 1.75], ...letters('ASDFGHJKL'), [';', 'Semicolon', 1], ["'", 'Quote', 1], ['Enter', 'Enter', 2.25]],
  [['Shift', 'ShiftLeft', 2.25], ...letters('ZXCVBNM'), [',', 'Comma', 1], ['.', 'Period', 1], ['/', 'Slash', 1], ['Shift', 'ShiftRight', 2.75]],
  [
    ['Ctrl', 'ControlLeft', 1.5],
    ['', 'MetaLeft', 1],
    ['Alt', 'AltLeft', 1.5],
    ['', 'Space', 7],
    ['Alt', 'AltRight', 1.5],
    ['', 'MetaRight', 1],
    ['Ctrl', 'ControlRight', 1.5],
  ],
]

/** Стрелки — отдельным островом справа: вверх над средней из трёх нижних. */
const ARROWS: [label: string, code: string, col: number, row: number][] = [
  ['↑', 'ArrowUp', 1, 3],
  ['←', 'ArrowLeft', 0, 4],
  ['↓', 'ArrowDown', 1, 4],
  ['→', 'ArrowRight', 2, 4],
]
const ARROWS_X = 15.5 // шагов от левого края клавиатуры

/** Мышь: справа от стрелок. Корпус в шагах. */
const MOUSE = { x: 19.4, y: 0.4, w: 2.5, h: 4.1 }
/** Высота линии раздела кнопок от верха корпуса, в шагах. */
const MOUSE_SPLIT = 1.6

const BOARD_W = (MOUSE.x + MOUSE.w) * U
const BOARD_H = ROWS.length * U

type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * Выноска: на какие клавиши указывает и какие пары подписей несёт. Несколько клавиш у
 * одной подписи — когда это одно действие на два конца (W/S, A/D) или одна камера на
 * стрелках. `Mouse*` — точки на мыши: колесо (MouseBody), левая и правая кнопки.
 */
interface Callout {
  keys: string[]
  rows: [Key, Key][]
  /** Край, к которому подпись прибита руками. Нет — к ближайшему, как решит раскладка. */
  side?: Side
}

const CALLOUTS: Callout[] = [
  { keys: ['Escape'], rows: [['keys.settings', 'keys.settings.what']] },
  { keys: ['Tab'], rows: [['keys.tab', 'keys.tab.what']] },
  { keys: ['KeyW', 'KeyS'], rows: [['keys.gas', 'keys.gas.what']] },
  { keys: ['KeyA', 'KeyD'], rows: [['keys.steer', 'keys.steer.what']] },
  { keys: ['ShiftLeft'], rows: [['keys.handbrake', 'keys.handbrake.what']] },
  { keys: ['Space'], rows: [['keys.boost', 'keys.boost.what']] },
  { keys: ['KeyE'], rows: [['keys.tow', 'keys.tow.what']] },
  { keys: ['KeyR'], rows: [['keys.camera', 'keys.camera.what']] },
  { keys: ['KeyT'], rows: [['keys.time', 'keys.time.what']] },
  { keys: ['KeyY'], rows: [['keys.style', 'keys.style.what']], side: 'top' },
  { keys: ['KeyJ'], rows: [['keys.ramp', 'keys.ramp.what']] },
  { keys: ['KeyC'], rows: [['keys.swap', 'keys.swap.what']] },
  { keys: ['KeyH'], rows: [['keys.hijack', 'keys.hijack.what']] },
  { keys: ['KeyF'], rows: [['keys.beacons', 'keys.beacons.what']] },
  { keys: ['KeyK'], rows: [['keys.help', 'keys.help.what']], side: 'bottom' },
  { keys: ['KeyM'], rows: [['keys.map', 'keys.map.what']] },
  { keys: ['Enter'], rows: [['keys.chat', 'keys.chat.what']] },
  { keys: ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'], rows: [['keys.look', 'keys.look.what']] },
  { keys: ['MouseBody'], rows: [['keys.zoom', 'keys.zoom.what']] },
  { keys: ['MouseL'], rows: [['keys.fire', 'keys.fire.what']] },
  { keys: ['MouseR'], rows: [['keys.orbit', 'keys.orbit.what'], ['keys.cable', 'keys.cable.what']] },
]

interface KeyBox {
  label: string
  code: string
  x: number
  y: number
  w: number
  h: number
}

/** Клавиши в координатах доски (левый верх клавиатуры — ноль). Не зависит от языка. */
const BOXES: KeyBox[] = (() => {
  const out: KeyBox[] = []
  ROWS.forEach((row, r) => {
    let col = 0
    for (const [label, code, width] of row) {
      out.push({ label, code, x: col * U, y: r * U, w: width * U - KEY_GAP, h: U - KEY_GAP })
      col += width
    }
  })
  for (const [label, code, col, row] of ARROWS) {
    out.push({ label, code, x: (ARROWS_X + col) * U, y: row * U, w: U - KEY_GAP, h: U - KEY_GAP })
  }
  return out
})()

/**
 * Точки мыши, куда приходят выноски. Левая кнопка — точкой выше правой: так её подпись
 * ложится в колонке выше (ЛКМ над ПКМ, как на самой мыши), и лучи не скрещиваются.
 */
const MOUSE_POINTS: Record<string, [number, number]> = {
  MouseL: [(MOUSE.x + MOUSE.w * 0.25) * U, (MOUSE.y + MOUSE_SPLIT * 0.35) * U],
  MouseR: [(MOUSE.x + MOUSE.w * 0.75) * U, (MOUSE.y + MOUSE_SPLIT * 0.75) * U],
  // колесо: дальность камеры
  MouseBody: [(MOUSE.x + MOUSE.w * 0.5) * U, (MOUSE.y + 0.65) * U],
}

function anchorOf(code: string): [number, number] {
  const m = MOUSE_POINTS[code]
  if (m) return m
  const b = BOXES.find((k) => k.code === code)
  if (!b) throw new Error(`Схема клавиш: нет клавиши ${code}`)
  return [b.x + b.w / 2, b.y + b.h / 2]
}

const USED = new Set(CALLOUTS.flatMap((c) => c.keys))

/** Чья подпись у клавиши: наведение на клавишу подсвечивает её выноску, как и наведение на подпись. */
const OWNER = new Map(CALLOUTS.flatMap((c, i) => c.keys.map((code) => [code, i] as const)))

/** Обработчики наведения на клавишу или кнопку мыши. Клавиша без подписи молчит. */
type HoverProps = (code: string) => { onPointerEnter?: () => void; onPointerLeave?: () => void }

interface Placed {
  index: number
  side: Side
  /** Прямоугольник подписи, в координатах всей схемы. */
  x: number
  y: number
  w: number
  h: number
  /** Луч выходит из `port` у кромки подписи, через короткий отвод до `knee`, и дальше прямо. */
  port: [number, number]
  knee: [number, number]
  /** Точки клавиш, в координатах всей схемы. */
  anchors: [number, number][]
}

/**
 * Сколько строк займёт подпись шириной `width`. Шрифт моноширинный, поэтому хватает
 * счёта знаков; два знака запаса — на перенос по словам, который рвёт строку раньше.
 */
function linesFor(c: Callout, width: number): number {
  const perLine = Math.floor(width / CHAR_W) - 2
  return c.rows.reduce((s, [k, what]) => s + Math.ceil((t(k).length + 1 + t(what).length) / perLine), 0)
}

/** Пересекаются ли отрезки (x1,y1)–(x2,y2) и (x3,y3)–(x4,y4) во внутренних точках. */
function segmentsCross(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  return d(x3, y3, x4, y4, x1, y1) * d(x3, y3, x4, y4, x2, y2) < 0 && d(x1, y1, x2, y2, x3, y3) * d(x1, y1, x2, y2, x4, y4) < 0
}

/** Строка подписей над/под клавиатурой тянется чуть шире доски — на половину зазора колонок. */
const ROW_SPAN_LO = -COL_GAP / 2
const ROW_SPAN_HI = BOARD_W + COL_GAP / 2
const ROW_CAPACITY = Math.floor((ROW_SPAN_HI - ROW_SPAN_LO + ROW_LABEL_GAP) / (ROW_LABEL_W + ROW_LABEL_GAP))

interface Item {
  index: number
  pts: [number, number][]
  ax: number
  ay: number
  colH: number
  rowH: number
}

/**
 * Раскладка выносок. Всё считается в координатах ДОСКИ (левый верх клавиатуры — ноль)
 * и в конце сдвигается на её место в схеме: так края и лучи не зависят от того, какая
 * сторона окажется выше.
 */
function layout(): { placed: Placed[]; width: number; height: number; boardX: number; boardY: number } {
  const items: Item[] = CALLOUTS.map((c, index) => {
    const pts = c.keys.map(anchorOf)
    return {
      index,
      pts,
      ax: pts.reduce((s, p) => s + p[0], 0) / pts.length,
      ay: pts.reduce((s, p) => s + p[1], 0) / pts.length,
      colH: linesFor(c, COL_W) * LINE_H,
      rowH: linesFor(c, ROW_LABEL_W) * LINE_H,
    }
  })

  // К ближайшему краю, но с вместимостью: строки ограничены шириной доски, колонки — поровну
  // остатком (без потолка середина клавиатуры, H J K L, вся валится влево). Сперва жадно —
  // первыми выбирают те, кому другой край заметно хуже, — потом обмены парами, пока падает
  // суммарная длина: жадный проход вытолкнул бы Tab в правую колонку через всю клавиатуру.
  const colCapacity = Math.ceil(Math.max(0, items.length - 2 * ROW_CAPACITY) / 2)
  const capacity: Record<Side, number> = { left: colCapacity, right: colCapacity, top: ROW_CAPACITY, bottom: ROW_CAPACITY }
  const cost = (it: Item, side: Side): number =>
    side === 'left' ? it.ax + COL_GAP
    : side === 'right' ? BOARD_W - it.ax + COL_GAP
    : side === 'top' ? it.ay + ROW_GAP
    : BOARD_H - it.ay + ROW_GAP
  const sides: Side[] = ['left', 'right', 'top', 'bottom']
  const prefs = items.map((it) => [...sides].sort((a, b) => cost(it, a) - cost(it, b)))
  const regret = (i: number) => {
    const p = prefs[i]!
    return cost(items[i]!, p[1]!) - cost(items[i]!, p[0]!)
  }
  const assigned: Side[] = []
  const count: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 }
  // Прибитые руками занимают места первыми и в обменах не участвуют.
  const pinned = (i: number) => CALLOUTS[i]?.side
  items.forEach((_, i) => {
    const side = pinned(i)
    if (!side) return
    assigned[i] = side
    count[side]++
  })
  for (const i of items.map((_, i) => i).filter((i) => !pinned(i)).sort((a, b) => regret(b) - regret(a))) {
    const side = prefs[i]!.find((s) => count[s] < capacity[s])!
    assigned[i] = side
    count[side]++
  }
  for (let improved = true; improved; ) {
    improved = false
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const si = assigned[i]!
        const sj = assigned[j]!
        if (si === sj || pinned(i) || pinned(j)) continue
        const a = items[i]!
        const b = items[j]!
        if (cost(a, sj) + cost(b, si) < cost(a, si) + cost(b, sj) - 1e-6) {
          assigned[i] = sj
          assigned[j] = si
          improved = true
        }
      }
    }
  }
  const groups: Record<Side, Item[]> = { left: [], right: [], top: [], bottom: [] }
  items.forEach((it, i) => groups[assigned[i]!].push(it))

  const placed: Placed[] = []

  // ── Строки: каждая подпись — над своей клавишей, соседи расталкиваются по ширине.
  const rowHeight = (row: Item[]) => row.reduce((m, it) => Math.max(m, it.rowH), 0)
  const topH = rowHeight(groups.top)
  const bottomH = rowHeight(groups.bottom)
  for (const side of ['top', 'bottom'] as const) {
    const row = groups[side].sort((a, b) => a.ax - b.ax)
    const xs = row.map((it) => it.ax - ROW_LABEL_W / 2)
    for (let i = 0; i < xs.length; i++) xs[i] = Math.max(xs[i]!, ROW_SPAN_LO, i > 0 ? xs[i - 1]! + ROW_LABEL_W + ROW_LABEL_GAP : -Infinity)
    for (let i = xs.length - 1; i >= 0; i--) {
      xs[i] = Math.min(xs[i]!, ROW_SPAN_HI - ROW_LABEL_W, i < xs.length - 1 ? xs[i + 1]! - ROW_LABEL_W - ROW_LABEL_GAP : Infinity)
    }
    row.forEach((it, i) => {
      const x = xs[i]!
      const cx = x + ROW_LABEL_W / 2
      const top = side === 'top'
      placed.push({
        index: it.index,
        side,
        x,
        y: top ? -ROW_GAP - topH : BOARD_H + ROW_GAP,
        w: ROW_LABEL_W,
        h: top ? topH : bottomH,
        port: [cx, top ? -ROW_GAP + 4 : BOARD_H + ROW_GAP - 4],
        knee: [cx, top ? -ROW_GAP + 14 : BOARD_H + ROW_GAP - 14],
        anchors: it.pts,
      })
    })
  }

  // ── Колонки: высота схемы известна только с ними, поэтому сперва меряем стопки.
  const stackHeight = (col: Item[]) => col.reduce((s, it) => s + it.colH, 0) + SLOT_GAP * Math.max(0, col.length - 1)
  const central = topH + ROW_GAP + BOARD_H + ROW_GAP + bottomH
  const height = Math.max(stackHeight(groups.left), stackHeight(groups.right), central)
  const boardY = (height - central) / 2 + topH + ROW_GAP
  const boardX = COL_W + COL_GAP
  const width = boardX + BOARD_W + COL_GAP + COL_W

  /** Центры подписей колонки сверху вниз, в координатах доски. */
  const centers = (col: Item[]): number[] => {
    let y = (height - stackHeight(col)) / 2 - boardY
    return col.map((it) => {
      const c = y + it.colH / 2
      y += it.colH + SLOT_GAP
      return c
    })
  }
  /** Сколько раз лучи колонки пересекают друг друга (лучи одной подписи не в счёт). */
  const crossings = (col: Item[], kneeX: number): number => {
    const ys = centers(col)
    const rays = col.flatMap((it, i) => it.pts.map((p) => ({ owner: i, y: ys[i] ?? 0, p })))
    let n = 0
    for (let i = 0; i < rays.length; i++) {
      for (let j = i + 1; j < rays.length; j++) {
        const a = rays[i]!
        const b = rays[j]!
        if (a.owner !== b.owner && segmentsCross(kneeX, a.y, a.p[0], a.p[1], kneeX, b.y, b.p[0], b.p[1])) n++
      }
    }
    return n
  }

  for (const side of ['left', 'right'] as const) {
    const col = groups[side]
    const left = side === 'left'
    const edgeX = left ? -COL_GAP + 8 : BOARD_W + COL_GAP - 8
    const kneeX = left ? edgeX + 16 : edgeX - 16
    // Начальный порядок — по углу из колонки на клавишу; он почти верен, но подписи разной
    // высоты сдвигают соседей, а мышь стоит между клавиатурой и правой колонкой. Добиваем
    // перестановками пар, пока число пересечений падает: подписей десяток, перебор мгновенный.
    const cy = BOARD_H / 2
    col.sort((a, b) => Math.atan2(a.ay - cy, Math.abs(a.ax - kneeX)) - Math.atan2(b.ay - cy, Math.abs(b.ax - kneeX)))
    let best = crossings(col, kneeX)
    for (let improved = true; improved && best > 0; ) {
      improved = false
      for (let i = 0; i < col.length; i++) {
        for (let j = i + 1; j < col.length; j++) {
          ;[col[i], col[j]] = [col[j]!, col[i]!]
          const n = crossings(col, kneeX)
          if (n < best) {
            best = n
            improved = true
          } else [col[i], col[j]] = [col[j]!, col[i]!]
        }
      }
    }
    const ys = centers(col)
    col.forEach((it, i) => {
      const c = ys[i]!
      placed.push({
        index: it.index,
        side,
        x: left ? -COL_GAP - COL_W : BOARD_W + COL_GAP,
        y: c - it.colH / 2,
        w: COL_W,
        h: it.colH,
        port: [edgeX, c],
        knee: [kneeX, c],
        anchors: it.pts,
      })
    })
  }

  // Из координат доски — в координаты схемы.
  const shift = ([x, y]: [number, number]): [number, number] => [x + boardX, y + boardY]
  for (const p of placed) {
    p.x += boardX
    p.y += boardY
    p.port = shift(p.port)
    p.knee = shift(p.knee)
    p.anchors = p.anchors.map(shift)
  }
  return { placed, width, height, boardX, boardY }
}

/** Непрозрачные заливки клавиш: лучи поверх, но сквозь клавишу не должен просвечивать фон. */
const FILL = { idle: 'var(--km-idle)', used: 'var(--km-used)', home: 'var(--km-home)', lit: 'var(--km-lit)' }

/** WASD — «дом» руки водителя: светлее прочих, чтобы схему узнавали с одного взгляда. */
const HOME = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD'])
const HOME_TONE = 'var(--km-home-ink)'

const isMouse = (code: string) => code in MOUSE_POINTS

/**
 * Где луч упирается в клавишу: точка входа отрезка «колено → центр» в её прямоугольник.
 * Луч кончается на рамке, а не в центре — иначе точка ложится на букву клавиши.
 * На мыши — в самой точке: кнопки делят одну рамку, на краю их не различить.
 */
function rayEnd(code: string, [kx, ky]: [number, number], [cx, cy]: [number, number]): [number, number] {
  const b = BOXES.find((k) => k.code === code)
  if (!b) return [cx, cy]
  const dx = cx - kx
  const dy = cy - ky
  const s = Math.min(dx === 0 ? Infinity : b.w / 2 / Math.abs(dx), dy === 0 ? Infinity : b.h / 2 / Math.abs(dy))
  return [cx - dx * s, cy - dy * s]
}

/** Схема без рамки и заголовка: что вокруг — решает тот, кто её показывает. */
export function KeyMap() {
  const lang = useLang()
  // Раскладка зависит от длины подписей, значит — от языка.
  const { placed, width, height, boardX, boardY } = useMemo(layout, [lang])
  const [hover, setHover] = useState<number | null>(null)
  const lit = new Set(hover === null ? [] : CALLOUTS[hover]?.keys ?? [])
  const hoverProps: HoverProps = (code) => {
    const owner = OWNER.get(code)
    if (owner === undefined) return {}
    return {
      onPointerEnter: () => setHover(owner),
      onPointerLeave: () => setHover((h) => (h === owner ? null : h)),
    }
  }

  // Лучи — слоем ПОВЕРХ клавиатуры. Координаты клавиш в схеме сдвинуты на доску.
  const rays = placed.map((p) => {
    const c = CALLOUTS[p.index]
    if (!c) return null
    const on = hover === p.index
    const color = on ? UI.TARGET : UI.PRIMARY
    const [kx, ky] = p.knee
    return (
      <g key={p.index} opacity={hover === null || on ? 1 : 0.3} pointerEvents="none">
        <line x1={p.port[0]} y1={p.port[1]} x2={kx} y2={ky} style={{ stroke: color }} strokeWidth={1.2} />
        {p.anchors.map(([ax, ay], i) => {
          const code = c.keys[i] ?? ''
          const [ex, ey] = isMouse(code)
            ? [ax, ay]
            : rayEnd(code, [kx - boardX, ky - boardY], [ax - boardX, ay - boardY]).map((v, j) => v + (j === 0 ? boardX : boardY))
          return (
            <g key={i}>
              <line x1={kx} y1={ky} x2={ex} y2={ey} style={{ stroke: color }} strokeWidth={1} strokeOpacity={0.8} />
              <circle cx={ex} cy={ey} r={2.5} style={{ fill: color }} />
            </g>
          )
        })}
      </g>
    )
  })

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto max-h-[80vh] w-full cursor-default select-none">
      <g transform={`translate(${boardX} ${boardY})`}>
        {BOXES.map((k) => {
          const used = USED.has(k.code)
          const on = lit.has(k.code)
          const home = HOME.has(k.code)
          const tone = on ? UI.TARGET : home ? HOME_TONE : used ? UI.PRIMARY : UI.DIM
          return (
            <g key={k.code} {...hoverProps(k.code)}>
              <rect
                x={k.x}
                y={k.y}
                width={k.w}
                height={k.h}
                rx={4}
                style={{ fill: on ? FILL.lit : home ? FILL.home : used ? FILL.used : FILL.idle, stroke: tone }}
                strokeOpacity={used ? 1 : 0.55}
                strokeWidth={used ? 1.5 : 1}
              />
              {k.label && (
                <text
                  x={k.x + k.w / 2}
                  y={k.y + k.h / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={k.label.length > 2 ? 11 : 14}
                  style={{ fill: tone }}
                  fillOpacity={used ? 1 : 0.6}
                >
                  {k.label}
                </text>
              )}
            </g>
          )
        })}
        <Mouse lit={lit} hoverProps={hoverProps} />
      </g>

      {rays}

      {placed.map((p) => {
        const c = CALLOUTS[p.index]
        if (!c) return null
        const on = hover === p.index
        return (
          <foreignObject
            key={p.index}
            x={p.x}
            y={p.y}
            width={p.w}
            height={p.h}
            onPointerEnter={() => setHover(p.index)}
            onPointerLeave={() => setHover((h) => (h === p.index ? null : h))}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                // Строка над клавиатурой прижата к ней низом, под клавиатурой — верхом.
                justifyContent: p.side === 'top' ? 'flex-end' : p.side === 'bottom' ? 'flex-start' : 'center',
                height: '100%',
                fontSize: FONT,
                lineHeight: `${LINE_H}px`,
                textAlign: p.side === 'left' ? 'right' : p.side === 'right' ? 'left' : 'center',
                color: 'var(--ui-ink)',
                opacity: hover === null || on ? 1 : 0.45,
              }}
            >
              {c.rows.map(([k, what]) => (
                <div key={k}>
                  <span style={{ color: on ? UI.TARGET : UI.PRIMARY, fontWeight: 700 }}>{t(k)}</span> {t(what)}
                </div>
              ))}
            </div>
          </foreignObject>
        )
      })}
    </svg>
  )
}

/** Мышь: корпус, раздел кнопок и колёсико. */
function Mouse({ lit, hoverProps }: { lit: Set<string>; hoverProps: HoverProps }) {
  const x = MOUSE.x * U
  const y = MOUSE.y * U
  const w = MOUSE.w * U
  const h = MOUSE.h * U
  const split = y + MOUSE_SPLIT * U
  const tone = (code: string) => (lit.has(code) ? UI.TARGET : UI.PRIMARY)
  const half = (code: string, left: boolean) => (
    <path
      d={
        left
          ? `M${x + w / 2},${y} L${x + w / 2},${split} L${x},${split} L${x},${y + w / 2} A${w / 2},${w / 2} 0 0 1 ${x + w / 2},${y} Z`
          : `M${x + w / 2},${y} L${x + w / 2},${split} L${x + w},${split} L${x + w},${y + w / 2} A${w / 2},${w / 2} 0 0 0 ${x + w / 2},${y} Z`
      }
      style={{ fill: lit.has(code) ? FILL.lit : FILL.used, stroke: tone(code) }}
      strokeWidth={1.5}
      {...hoverProps(code)}
    />
  )
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={w / 2} style={{ fill: FILL.idle, stroke: UI.PRIMARY }} strokeWidth={1.5} />
      {half('MouseL', true)}
      {half('MouseR', false)}
      {/* колесо — своя цель: дальность камеры */}
      <rect x={x + w / 2 - 5} y={y + 0.3 * U} width={10} height={0.7 * U} rx={5} style={{ fill: lit.has('MouseBody') ? FILL.lit : FILL.used, stroke: tone('MouseBody') }} strokeWidth={1.5} {...hoverProps('MouseBody')} />
    </g>
  )
}
