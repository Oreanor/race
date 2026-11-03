import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('public/vendor',{recursive:true});
for(const name of ['maplibre-gl-worker.mjs','maplibre-gl-shared.mjs'])copyFileSync(`node_modules/maplibre-gl/dist/${name}`,`public/vendor/${name}`);
