import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

let client = null;
let configurationError = "";

if (!supabaseUrl || !publishableKey) {
  configurationError = "Public content is unavailable until VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are configured.";
} else {
  try {
    client = createClient(supabaseUrl, publishableKey, {
      auth: { autoRefreshToken: true, detectSessionInUrl: true, persistSession: true },
    });
  } catch (error) {
    configurationError = `Supabase configuration is invalid: ${error.message}`;
  }
}

export const supabase = client;
export const supabaseError = configurationError;
