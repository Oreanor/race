// All game sound is synthesised with Web Audio — no files to load, nothing to license.
// One AudioContext, made on the first key or click (browsers keep audio locked until then).
// The engine sets the scene once a frame (`frame`); short sounds are one-shot calls.

type Position = [number, number];

/** a car heard around us: where it is, how it moves (m/s east / north) */
export type HeardCar = { id: string; position: Position; velocity: [number, number] };

export type AudioFrame = {
  /** driving (not the menu, not paused): the car and the street are heard */
  active: boolean;
  /** our engine, 0 (idle) … 1 (redline) */
  revs: number;
  /** our speed, m/s */
  speed: number;
  /** throttle down */
  throttle: boolean;
  boost: boolean;
  /** body vs travel angle (rad): the tyres squeal on a big one */
  slip: number;
  /** engine size, litres: the voice — a thin four or a deep V8 */
  litres: number;
  /** listener */
  position: Position;
  heading: number;
  velocity: [number, number];
  /** metres from the camera (the ear) to our car: higher camera, everything farther */
  ear: number;
  /** 0 day … 1 night */
  night: number;
  /** 0 open country … 1 dense town */
  urban: number;
  /** police after us (a wail) */
  police: HeardCar[];
  /** our own siren while our lights are on */
  ownSiren: 'police' | 'ambulance' | null;
  /** rivals and traffic close by (their engines) */
  engines: HeardCar[];
  /** trains and trams around: the lead car of each */
  trains: (HeardCar & { kind: 'rail' | 'tram'; vintage: boolean })[];
};

const SOUND = 343; // m/s
const METERS_PER_DEGREE = 111_319.49;

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** east / north metres from `a` to `b` */
function offset(a: Position, b: Position): [number, number] {
  return [
    (b[0] - a[0]) * METERS_PER_DEGREE * Math.cos(a[1] * Math.PI / 180),
    (b[1] - a[1]) * METERS_PER_DEGREE,
  ];
}

/** a sound source out in the world: loudness by distance, left/right, Doppler */
function spatial(frame: AudioFrame, car: HeardCar, reach: number) {
  const [e, n] = offset(frame.position, car.position);
  // heard from the camera: up above the car, so nothing is ever closer than it
  const d = Math.hypot(e, n, frame.ear) || 0.001;
  // closing speed along the line between us (+: coming together)
  const ue = e / d, un = n / d;
  const closing = (frame.velocity[0] - car.velocity[0]) * ue + (frame.velocity[1] - car.velocity[1]) * un;
  const doppler = clamp(SOUND / Math.max(60, SOUND - closing), 0.7, 1.4);
  const gain = d > reach ? 0 : Math.min(1, 25 / (d + 10)) ** 1.1;
  // right of our heading → +pan
  const right = e * Math.cos(frame.heading) - n * Math.sin(frame.heading);
  const pan = clamp(right / Math.max(8, d), -0.85, 0.85);
  return { d, gain, pan, doppler };
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.5;
  private noise: AudioBuffer | null = null;
  private brown: AudioBuffer | null = null;
  // our car
  private engine: { a: OscillatorNode; b: OscillatorNode; drive: WaveShaperNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private tyres: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private wind: { filter: BiquadFilterNode; gain: GainNode } | null = null;
  private town: { gain: GainNode } | null = null;
  private horn: GainNode | null = null;
  private sirens = new Map<string, { osc: OscillatorNode; gain: GainNode; pan: StereoPannerNode; kind: 'police' | 'ambulance'; phase: number }>();
  private motors = new Map<string, { osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode }>();
  private trainVoices = new Map<string, { osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode; clack: number; chuff: number; whistled: boolean; rang: number }>();
  private lastFrame = 0;
  private boosting = false;
  /** our car's loudness from where the camera is (one-shots and the horn use it too) */
  private nearness = 1;
  private hidden = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  private onVisibility = () => {
    this.hidden = document.hidden;
    if (!this.ctx) return;
    if (document.hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  };

  /** 0 … 1 (0: off) */
  setVolume(v: number) {
    this.volume = clamp(v);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  /** Call from a key / click: makes (or wakes) the audio context. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.hidden) void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    limiter.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(limiter);
    this.noise = this.makeNoise(false);
    this.brown = this.makeNoise(true);
    this.buildCar();
  }

  dispose() {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    void this.ctx?.close();
    this.ctx = null;
  }

  private makeNoise(brown: boolean) {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.5; }
      else data[i] = white;
    }
    return buffer;
  }

  private loop(buffer: AudioBuffer) {
    const src = this.ctx!.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  private buildCar() {
    const ctx = this.ctx!, out = this.master!;
    // engine: a sawtooth at the firing rate and a square an octave down, through a soft clip and a lowpass
    const a = ctx.createOscillator(); a.type = 'sawtooth';
    const b = ctx.createOscillator(); b.type = 'square';
    const mix = ctx.createGain(); mix.gain.value = 0.5;
    const drive = ctx.createWaveShaper(); drive.curve = this.curve(1.3);
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 0.9;
    const gain = ctx.createGain(); gain.gain.value = 0;
    a.connect(mix); b.connect(mix); mix.connect(drive); drive.connect(filter); filter.connect(gain); gain.connect(out);
    a.start(); b.start();
    this.engine = { a, b, drive, filter, gain };
    // tyres: band-passed noise
    const tyreSrc = this.loop(this.noise!);
    const tf = ctx.createBiquadFilter(); tf.type = 'bandpass'; tf.frequency.value = 2300; tf.Q.value = 9;
    const tg = ctx.createGain(); tg.gain.value = 0;
    tyreSrc.connect(tf); tf.connect(tg); tg.connect(out);
    this.tyres = { filter: tf, gain: tg };
    // wind: low noise rising with speed
    const windSrc = this.loop(this.noise!);
    const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 500;
    const wg = ctx.createGain(); wg.gain.value = 0;
    windSrc.connect(wf); wf.connect(wg); wg.connect(out);
    this.wind = { filter: wf, gain: wg };
    // the town: a deep rumble of far traffic
    const townSrc = this.loop(this.brown!);
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 350;
    const ng = ctx.createGain(); ng.gain.value = 0;
    townSrc.connect(nf); nf.connect(ng); ng.connect(out);
    this.town = { gain: ng };
    // horn: two square tones a third apart
    const hg = ctx.createGain(); hg.gain.value = 0;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 1800;
    for (const f of [415, 520]) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(hf); o.start();
    }
    hf.connect(hg); hg.connect(out);
    this.horn = hg;
  }

  private curve(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024, curve = new Float32Array(new ArrayBuffer(n * 4));
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return curve;
  }

  /** Once a frame: our car, the street, sirens and engines around. */
  frame(f: AudioFrame) {
    const ctx = this.ctx;
    if (!ctx || !this.engine || !this.tyres || !this.wind || !this.town) return;
    const t = ctx.currentTime;
    const smooth = 0.06;
    // our own car and the air around it fade as the camera rises (the M map: barely a murmur)
    const near = clamp(22 / Math.max(1, f.ear), 0.06, 1) ** 0.7;
    const on = (f.active ? 1 : 0) * near;
    this.nearness = near;
    // ---- our engine: pitch from revs; a bigger engine sits lower (a small four buzzes,
    // a V8 rumbles) — the tone stays under ~280 Hz and the filter keeps it warm
    const size = f.litres < 1.9 ? 1.2 : f.litres < 3.2 ? 1 : f.litres < 5.5 ? 0.82 : 0.7;
    const pitch = (48 + clamp(f.revs) * 185) * size;
    this.engine.a.frequency.setTargetAtTime(pitch, t, 0.03);
    this.engine.b.frequency.setTargetAtTime(pitch / 2, t, 0.03);
    this.engine.filter.frequency.setTargetAtTime(220 + clamp(f.revs) * 1300 + (f.boost ? 450 : 0), t, smooth);
    // the boost growls: a harder clip (swapped only when it changes)
    if (f.boost !== this.boosting) {
      this.boosting = f.boost;
      this.engine.drive.curve = this.curve(f.boost ? 2.2 : 1.3);
    }
    const engineLevel = (0.09 + (f.throttle ? 0.07 : 0) + clamp(f.revs) * 0.06 + (f.boost ? 0.05 : 0)) * on;
    this.engine.gain.gain.setTargetAtTime(engineLevel, t, smooth);
    // ---- tyres: squeal on a big slide at speed
    // only a real slide: an everyday corner already drifts up to ~0.42 rad without a sound
    const squeal = clamp((Math.abs(f.slip) - 0.46) * 2.5) * clamp(Math.abs(f.speed) / 12);
    this.tyres.gain.gain.setTargetAtTime(squeal * 0.16 * on, t, 0.04);
    this.tyres.filter.frequency.setTargetAtTime(2000 + squeal * 700, t, 0.05);
    // ---- wind with speed
    const rush = clamp(Math.abs(f.speed) / 70);
    this.wind.gain.gain.setTargetAtTime(rush * rush * 0.1 * on, t, 0.3);
    this.wind.filter.frequency.setTargetAtTime(300 + rush * 700, t, 0.3);
    // ---- the town by day, softer at night; nearly nothing out in the fields
    this.town.gain.gain.setTargetAtTime(f.urban * (0.11 - 0.07 * f.night) * on, t, 0.8);
    // ---- sirens: the police after us, and ours
    const wanted = new Map<string, { kind: 'police' | 'ambulance'; s: ReturnType<typeof spatial> }>();
    if (f.active) {
      for (const car of f.police) {
        const s = spatial(f, car, 1500);
        if (s.gain > 0.01) wanted.set(car.id, { kind: 'police', s });
      }
      if (f.ownSiren) wanted.set('__own', { kind: f.ownSiren, s: { d: 0, gain: 0.55 * near, pan: 0, doppler: 1 } });
    }
    for (const [id, voice] of this.sirens) {
      if (wanted.has(id)) continue;
      voice.gain.gain.setTargetAtTime(0, t, 0.1);
      voice.osc.stop(t + 0.5);
      this.sirens.delete(id);
    }
    for (const [id, want] of wanted) {
      let voice = this.sirens.get(id);
      if (!voice || voice.kind !== want.kind) {
        if (voice) { voice.gain.gain.setTargetAtTime(0, t, 0.05); voice.osc.stop(t + 0.3); }
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 2600;
        const gain = ctx.createGain(); gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        osc.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.master!);
        osc.start();
        voice = { osc, gain, pan, kind: want.kind, phase: Math.random() * 10 };
        this.sirens.set(id, voice);
      }
      const clock = t + voice.phase;
      // police: a rising and falling wail; ambulance: hi-lo two tones
      const pitch = want.kind === 'police'
        ? 640 + 520 * (0.5 - 0.5 * Math.cos(clock * Math.PI * 2 / 2.4))
        : (Math.floor(clock / 0.65) % 2 ? 770 : 960);
      voice.osc.frequency.setTargetAtTime(pitch * want.s.doppler, t, want.kind === 'police' ? 0.03 : 0.01);
      voice.gain.gain.setTargetAtTime(want.s.gain * 0.13, t, 0.08);
      voice.pan.pan.setTargetAtTime(want.s.pan, t, 0.08);
    }
    // ---- other cars' engines nearby (the closest few)
    const nearby = f.active
      ? f.engines.map((car) => ({ car, s: spatial(f, car, 120) })).filter((e) => e.s.gain > 0.02).sort((a, b) => a.s.d - b.s.d).slice(0, 4)
      : [];
    const keep = new Set(nearby.map((e) => e.car.id));
    for (const [id, voice] of this.motors) {
      if (keep.has(id)) continue;
      voice.gain.gain.setTargetAtTime(0, t, 0.1);
      voice.osc.stop(t + 0.5);
      this.motors.delete(id);
    }
    for (const { car, s } of nearby) {
      let voice = this.motors.get(car.id);
      if (!voice) {
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 700;
        const gain = ctx.createGain(); gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        osc.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.master!);
        osc.start();
        voice = { osc, filter, gain, pan };
        this.motors.set(car.id, voice);
      }
      const speed = Math.hypot(car.velocity[0], car.velocity[1]);
      const pitch = (40 + speed * 3.2) * s.doppler;
      voice.osc.frequency.setTargetAtTime(pitch, t, 0.08);
      voice.filter.frequency.setTargetAtTime(400 + speed * 30, t, 0.1);
      voice.gain.gain.setTargetAtTime(s.gain * 0.07, t, 0.1);
      voice.pan.pan.setTargetAtTime(s.pan, t, 0.1);
    }
    const dt = this.lastFrame ? Math.min(0.2, t - this.lastFrame) : 0;
    this.lastFrame = t;
    this.trainsFrame(f, t, dt);
  }

  /**
   * Trains: a new one hums (electric) and clacks over the rail joints; an old one chuffs in
   * time with its speed, clacks and whistles once as it comes near. Trams: a soft hum,
   * the old ones ring their bell now and then.
   */
  private trainsFrame(f: AudioFrame, t: number, dt: number) {
    const ctx = this.ctx!;
    const near = f.active
      ? f.trains.map((train) => ({ train, s: spatial(f, train, 450) })).filter((e) => e.s.gain > 0.01).sort((a, b) => a.s.d - b.s.d).slice(0, 3)
      : [];
    const keep = new Set(near.map((e) => e.train.id));
    for (const [id, voice] of this.trainVoices) {
      if (keep.has(id)) continue;
      voice.gain.gain.setTargetAtTime(0, t, 0.2);
      voice.osc.stop(t + 1);
      this.trainVoices.delete(id);
    }
    for (const { train, s } of near) {
      let voice = this.trainVoices.get(train.id);
      if (!voice) {
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
        const gain = ctx.createGain(); gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        osc.connect(filter); filter.connect(gain); gain.connect(pan); pan.connect(this.master!);
        osc.start();
        voice = { osc, filter, gain, pan, clack: 0, chuff: 0, whistled: false, rang: 0 };
        this.trainVoices.set(train.id, voice);
      }
      const speed = Math.hypot(train.velocity[0], train.velocity[1]);
      const steam = train.kind === 'rail' && train.vintage;
      // the steady voice: an electric hum (higher with speed), or a low firebox rumble
      const hum = steam ? 45 : train.kind === 'tram' ? 120 + speed * 9 : 70 + speed * 6;
      voice.osc.frequency.setTargetAtTime(hum * s.doppler, t, 0.2);
      voice.filter.frequency.setTargetAtTime(steam ? 260 : 600 + speed * 25, t, 0.2);
      voice.gain.gain.setTargetAtTime(s.gain * (steam ? 0.05 : 0.06) * clamp(0.3 + speed / 10), t, 0.2);
      voice.pan.pan.setTargetAtTime(s.pan, t, 0.1);
      const level = s.gain;
      // clack-clack over the joints: a pair every rail length (25 m)
      if (speed > 1) {
        voice.clack += dt * speed / 25;
        if (voice.clack >= 1) {
          voice.clack %= 1;
          const loud = level * (train.kind === 'tram' ? 0.12 : 0.22);
          this.burstAt(0, { type: 'bandpass', from: 1500, to: 700, q: 3, level: loud, length: 0.05 }, s.pan);
          this.burstAt(0.11, { type: 'bandpass', from: 1300, to: 600, q: 3, level: loud * 0.85, length: 0.05 }, s.pan);
        }
      }
      // steam: four chuffs per wheel turn (2 m driving wheels), even standing a little
      if (steam) {
        voice.chuff += dt * Math.max(0.6, speed / (Math.PI * 2) * 4);
        if (voice.chuff >= 1) {
          voice.chuff %= 1;
          this.burstAt(0, { type: 'bandpass', from: 900, to: 300, q: 0.7, level: level * 0.3, length: 0.22, attack: 0.02 }, s.pan);
        }
        if (!voice.whistled && s.d < 250) {
          voice.whistled = true;
          this.whistle(level, s.pan, s.doppler);
        }
      }
      // an old tram rings now and then when close
      if (train.kind === 'tram' && train.vintage && s.d < 120 && t - voice.rang > 7) {
        voice.rang = t;
        for (const at of [0, 0.32]) this.bell(at, level, s.pan);
      }
    }
  }

  private whistle(level: number, pan: number, doppler: number) {
    const ctx = this.ctx!, t = ctx.currentTime;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.master!);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * level + 0.0001, t + 0.15);
    g.gain.setValueAtTime(0.12 * level + 0.0001, t + 1.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    g.connect(p);
    // a chord of three pipes
    for (const f of [440, 554, 659]) {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f * doppler;
      o.connect(g); o.start(t); o.stop(t + 1.6);
    }
  }

  private bell(at: number, level: number, pan: number) {
    const ctx = this.ctx!, t = ctx.currentTime + at;
    const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(this.master!);
    for (const [f, l] of [[1180, 1], [2950, 0.4]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12 * level * l + 0.0001, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g); g.connect(p); o.start(t); o.stop(t + 1);
    }
  }

  // ---- one-shots -----------------------------------------------------------

  private burstAt(at: number, opts: { type: BiquadFilterType; from: number; to: number; q?: number; level: number; length: number; attack?: number }, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || opts.level < 0.002) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const filter = ctx.createBiquadFilter(); filter.type = opts.type; filter.Q.value = opts.q ?? 1;
    filter.frequency.setValueAtTime(opts.from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + opts.length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.level, t + (opts.attack ?? 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.length);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    src.connect(filter); filter.connect(gain); gain.connect(p); p.connect(this.master!);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.length + 0.05);
  }


  private burst(opts: { type: BiquadFilterType; from: number; to: number; q?: number; level: number; length: number; attack?: number }) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const filter = ctx.createBiquadFilter(); filter.type = opts.type; filter.Q.value = opts.q ?? 1;
    filter.frequency.setValueAtTime(opts.from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + opts.length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(opts.level, t + (opts.attack ?? 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.length);
    src.connect(filter); filter.connect(gain); gain.connect(this.master!);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.length + 0.05);
  }

  private tone(freq: number, at: number, length: number, level: number, type: OscillatorType = 'sine', to?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator(); osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(level, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain); gain.connect(this.master!);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  /** a coin picked up: a bright two-note chime */
  coin() {
    const k = this.nearness;
    this.tone(1320, 0, 0.09, 0.16 * k);
    this.tone(1980, 0.07, 0.16, 0.13 * k);
  }

  /** hitting a car or a wall; `strength` 0 … 1 */
  crash(strength: number) {
    const s = clamp(strength, 0.1, 1), k = this.nearness;
    this.burst({ type: 'lowpass', from: 1800 + s * 2500, to: 200, level: (0.12 + s * 0.4) * k, length: 0.25 + s * 0.35 });
    this.tone(70 + s * 30, 0, 0.18 + s * 0.2, (0.15 + s * 0.3) * k, 'sine', 40);
  }

  /** into the water */
  splash() {
    const k = this.nearness;
    this.burst({ type: 'bandpass', from: 1400, to: 300, q: 0.8, level: 0.4 * k, length: 0.9, attack: 0.02 });
    this.burst({ type: 'lowpass', from: 500, to: 120, level: 0.3 * k, length: 1.2, attack: 0.04 });
  }

  /** one shot of our guns (the hose: a soft hiss) */
  shot(kind: 'gun' | 'water') {
    const k = this.nearness;
    if (kind === 'water') {
      this.burst({ type: 'highpass', from: 2500, to: 1800, level: 0.03 * k, length: 0.08 });
      return;
    }
    this.burst({ type: 'bandpass', from: 2400, to: 400, q: 1.2, level: 0.18 * k, length: 0.07 });
    this.tone(160, 0, 0.05, 0.08 * k, 'square', 60);
  }

  /** the horn held / let go */
  hornOn(on: boolean) {
    if (!this.ctx || !this.horn) return;
    this.horn.gain.setTargetAtTime(on ? 0.09 * this.nearness : 0, this.ctx.currentTime, 0.015);
  }
}
