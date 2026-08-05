import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '';

let client: SupabaseClient | null = null;

export const isSupabaseConfigured = (): boolean =>
  Boolean(supabaseUrl && supabaseAnonKey);

/**
 * Returns a lazily created browser Supabase client, or `null` when the
 * PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY build-time variables are not
 * configured. The anon key is a publishable client credential; never place
 * service-role or other secret keys here.
 */
export const getSupabaseClient = (): SupabaseClient | null => {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        // Static-site friendly defaults: persist the session in localStorage
        // and complete magic-link sign-in from the redirect URL fragment.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return client;
};
