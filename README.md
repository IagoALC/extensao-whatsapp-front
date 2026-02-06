# WA Copilot Extension (Front)

## Configuracao por `.env`

1. Crie o arquivo `.env` na pasta `extensao-whatsapp-front`:

```env
WXT_API_BASE_URL=http://localhost:8080
WXT_API_AUTH_TOKEN=dev-token
```

2. Build da extensao:

```bash
npm run build
```

As variaveis sao lidas em `src/core/settings.ts` via `import.meta.env`.
