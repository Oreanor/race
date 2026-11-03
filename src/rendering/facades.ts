import { CanvasTexture, SRGBColorSpace, RepeatWrapping, LinearFilter, LinearMipmapLinearFilter, type Texture } from 'three';

function channels(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mixColor(from: string, to: string, amount: number) {
  const a = channels(from);
  const b = channels(to);
  return `#${a.map((channel, index) => Math.round(channel * (1 - amount) + b[index] * amount).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// One bay, 8 m wide and one 3.2 m floor. Repeated in meters on the wall mesh.
export function paintFacade(canvas: HTMLCanvasElement, wall: string) {
  const width = canvas.width;
  const height = canvas.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const dark = luminance(wall) < 0.42;
  const frame = dark ? '#f6f1e6' : '#fffaf3';
  const glass = dark ? '#ffcf86' : '#1c2740';
  const shine = dark ? '#fff1cc' : '#e7f2fb';
  context.clearRect(0, 0, width, height);
  context.fillStyle = wall;
  context.fillRect(0, 0, width, height);
  context.fillStyle = mixColor(wall, '#000000', 0.2);
  context.fillRect(0, height - 7, width, 7);
  context.fillStyle = mixColor(wall, '#000000', 0.1);
  context.fillRect(0, 0, 4, height);
  const windows = [10, 48, 86, 124];
  for (const x of windows) {
    context.fillStyle = frame;
    context.fillRect(x, 8, 30, 42);
    context.fillStyle = glass;
    context.fillRect(x + 4, 12, 22, 34);
    context.fillStyle = frame;
    context.fillRect(x + 14, 12, 2, 34);
    context.fillRect(x + 4, 27, 22, 2);
    context.fillStyle = shine;
    context.fillRect(x + 6, 15, 6, 8);
  }
}

export function facadeTexture(wall: string): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 64;
  paintFacade(canvas, wall);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
