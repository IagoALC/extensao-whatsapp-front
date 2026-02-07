import { defineConfig } from 'wxt';

const DEFAULT_API_BASE_URL = 'http://localhost:8080';

function toHostPermission(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

const hostPermissions = [
  'https://web.whatsapp.com/*',
  'http://localhost/*',
  'http://127.0.0.1/*',
  'https://localhost/*',
  'https://127.0.0.1/*',
  'https://api.wacopilot.app/*',
];

const apiHostPermission = toHostPermission(
  process.env.WXT_API_BASE_URL ??
    process.env.VITE_API_BASE_URL ??
    DEFAULT_API_BASE_URL,
);

if (apiHostPermission && !hostPermissions.includes(apiHostPermission)) {
  hostPermissions.push(apiHostPermission);
}

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
    host_permissions: hostPermissions,
    action: {
      default_title: 'WA Copilot',
    },
  },
});
