/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" forces the in-browser mock API, "0" forces the real API. */
  readonly VITE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
