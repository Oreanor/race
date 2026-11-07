import type { NextConfig } from 'next';

const tauri = Boolean(process.env.TAURI || process.env.TAURI_ENV_PLATFORM);
const isProd = process.env.NODE_ENV === 'production';
const internalHost = process.env.TAURI_DEV_HOST || 'localhost';

const config: NextConfig = {
  // the dev server opened through a tunnel to server/multiplayer.ts (docs/multiplayer.md)
  allowedDevOrigins: ['*.trycloudflare.com', '*.ngrok-free.app', '*.ngrok.app', '*.ngrok.io', '*.loca.lt'],
  ...(tauri
    ? {
        // Tauri embeds a static site; no Node server in the desktop binary
        output: 'export' as const,
        images: { unoptimized: true },
        // dev: assets resolve through the Next server; prod: relative paths inside the bundle
        assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
      }
    : {}),
};

export default config;
