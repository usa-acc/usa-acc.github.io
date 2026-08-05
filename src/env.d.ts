/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SIGNUP_ENDPOINT?: string;
  readonly PUBLIC_SIGNUP_SOURCE?: string;
  readonly PUBLIC_SUPABASE_URL?: string;
  readonly PUBLIC_SUPABASE_ANON_KEY?: string;
  readonly PUBLIC_SUPPORT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
