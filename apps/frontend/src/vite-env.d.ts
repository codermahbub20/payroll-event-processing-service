/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the API origin when the UI is not served same-origin. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
