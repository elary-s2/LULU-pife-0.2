const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Erro: SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY não foram encontradas no arquivo .env!');
}

if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('✅ Supabase: usando SUPABASE_SERVICE_ROLE_KEY para conexões de servidor.');
} else {
  console.warn('⚠️ Supabase: usando SUPABASE_KEY. Inserções podem falhar se Row Level Security estiver ativo.');
}

// Inicializa o cliente do Supabase
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// Exporta o cliente para ser usado em outros arquivos do projeto
module.exports = supabase;