/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />

/** Build version baked in by vite.config.ts (`define`) — the package.json version at build time. */
declare const __APP_VERSION__: string

/** GitHub releases URL derived from package.json's repository at build time. */
declare const __APP_RELEASES_URL__: string
