# Cortana Monitor

Monitor de publicaciones de Facebook y de `burbujapolitica.com`. Permite
comparar ambas fuentes, sugerir correcciones, notificar al otro usuario y
registrar las copias de enlaces que se marcan como publicados en X.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.

## MongoDB

La aplicación guarda en MongoDB las publicaciones, notificaciones, correcciones,
estado de publicaciones en X y el historial de copias. Configura estas variables
en el entorno del servidor:

```env
MONGODB_URI=mongodb+srv://...
MONGODB_DB_NAME=cortana
```

No pongas la cadena de conexión directamente en el código ni la publiques en el
repositorio.

## Render

En Render crea un Web Service para Node y configura:

- Build Command: `npm install && npm run build`
- Start Command: `node .output/server/index.mjs`
- Environment: `MONGODB_URI`, `MONGODB_DB_NAME` y las variables de Facebook

El puerto lo proporciona Render mediante `PORT`; Nitro lo utiliza al iniciar el
servidor de producción.

## Facebook

For reliable current Facebook posts, configure `FACEBOOK_ACCESS_TOKEN` (or
`FACEBOOK_PAGE_ACCESS_TOKEN`) and the numeric `FACEBOOK_PAGE_ID` in the
deployment environment. The application uses the Graph API first and the
public HTML scraper only as a fallback.

Las correcciones y notificaciones se sincronizan mediante MongoDB, por lo que no
requieren Vercel KV ni Upstash Redis.
