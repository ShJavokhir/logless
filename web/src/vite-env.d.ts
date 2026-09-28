/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" forces the in-browser mock API, "0" forces the real API. */
  readonly VITE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** PRESENTER_KEY from the repo's .env on the dev server; empty in production builds. */
declare const __DEV_PRESENTER_KEY__: string | undefined
