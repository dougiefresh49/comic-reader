import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | undefined;

function getClient(): SupabaseClient {
  _client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // Supabase-Vercel integration uses ANON_KEY; local .env uses PUBLISHABLE_KEY
    (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
  );
  return _client;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop: string | symbol) {
    return getClient()[prop as keyof SupabaseClient];
  },
});
