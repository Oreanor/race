import type { NextConfig } from 'next';

const config: NextConfig = {
  // the dev server opened through a tunnel to server/multiplayer.ts (docs/multiplayer.md)
  allowedDevOrigins: ['*.trycloudflare.com', '*.ngrok-free.app', '*.ngrok.app', '*.ngrok.io', '*.loca.lt'],
};

export default config;
