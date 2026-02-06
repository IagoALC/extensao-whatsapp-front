import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    // Force escaped output to avoid noncharacters (e.g. U+FFFF) in generated bundles.
    esbuild: {
      charset: 'ascii',
    },
  }),
  manifest: {
    name: 'WA Copilot',
    short_name: 'WACopilot',
    description: 'Resumo, sugestoes e relatorios no WhatsApp Web.',
    permissions: ['storage'],
    host_permissions: [
      'https://web.whatsapp.com/*',
      'http://localhost:8080/*',
      'https://api.wacopilot.app/*',
    ],
    action: {
      default_title: 'WA Copilot',
    },
  },
});
