import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

import { romCatalog } from './src/integrations/rom-catalog.js';

export default defineConfig({
  integrations: [tailwind(), romCatalog()],
  base: '/nes-console/',
});
