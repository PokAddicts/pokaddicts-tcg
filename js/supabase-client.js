/* ==========================================================================
   PokAddicts - Supabase Project Connection
   Fill these in from Project Settings -> API in your Supabase dashboard.
   ========================================================================== */

const SUPABASE_URL = 'https://pdhjrifvfnrhsebhvyvk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nvKflzLJTUeCTqt_C76_ZQ_uNpwtOfP';

window.supabaseClient = (SUPABASE_URL.startsWith('http'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (!window.supabaseClient) {
  console.warn('Supabase is not configured yet - fill in SUPABASE_URL / SUPABASE_ANON_KEY in js/supabase-client.js. Falling back to local-only mode.');
}
