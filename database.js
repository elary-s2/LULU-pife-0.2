const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Erro: SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY não foram encontradas no arquivo .env!");
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
console.log("🚀 Conexão com o Supabase configurada com sucesso!");

// 🔄 TRADUTOR: Simula o comportamento do db.get() do SQLite, mas busca no Supabase!
async function get(sql, params = [], callback = () => {}) {
    try {
        const query = sql.toLowerCase();
        
        // 1. Intercepta busca por username ou ID na tabela de jogadores
        if (query.includes('from players') || query.includes('from usuarios')) {
            let result;
            
            // ✨ LIA: Em vez de .select('*'), listamos as colunas exatas existentes no Supabase.
            // Isso ignora completamente qualquer tentativa de buscar a coluna física 'matches'.
            const colunasReais = 'id, username, password, vitorias, derrotas, pergunta_seguranca, resposta_seguranca, avatar';

            if (query.includes('id = ?')) {
                // Busca por ID
                const { data } = await supabase.from('usuarios').select(colunasReais).eq('id', params[0]).maybeSingle();
                result = data;
            } else {
                // Busca por Username (LOWER)
                const usernameParam = String(params[0] || '').trim().toLowerCase();
                const { data } = await supabase.from('usuarios').select(colunasReais).ilike('username', usernameParam).maybeSingle();
                result = data;
            }

            if (result) {
                // Traduz os nomes das colunas do Supabase para o formato que seu server.js espera
                const formattedRow = {
                    id: result.id,
                    username: result.username,
                    password_hash: result.password,
                    wins: result.vitorias || 0,
                    losses: result.derrotas || 0,
                    // ✨ LIA: Calculamos dinamicamente os matches para o servidor receber o dado sem dar erro de banco!
                    matches: (result.vitorias || 0) + (result.derrotas || 0),
                    security_question: result.pergunta_seguranca,
                    security_answer_hash: result.resposta_seguranca,
                    avatar: result.avatar
                };
                return callback(null, formattedRow);
            }
            return callback(null, null);
        }

        // 2. Intercepta busca por amizades
        if (query.includes('from friendships')) {
            const { data } = await supabase.from('friendships').select('id').eq('user_id', params[0]).eq('friend_id', params[1]).maybeSingle();
            return callback(null, data ? { '1': 1 } : null);
        }

        callback(null, null);
    } catch (err) {
        console.error("Erro interno no GET do tradutor:", err);
        callback(err, null);
    }
}

// 🔄 TRADUTOR: Simula o comportamento do db.run() do SQLite, mas salva no Supabase!
async function run(sql, params = [], callback = () => {}) {
    try {
        const query = sql.toLowerCase();

        // 1. Intercepta criação de conta (INSERT)
        if (query.includes('insert into players') || query.includes('insert into usuarios')) {
            const { data, error } = await supabase.from('usuarios').insert([{
                username: params[0],
                password: params[1],
                pergunta_seguranca: params[2],
                resposta_seguranca: params[3],
                vitorias: 0,
                derrotas: 0,
                avatar: 'avatar1'
            }]).select('id').single();

            if (error) return callback(error);
            
            const context = { lastID: data.id };
            return callback.call(context, null);
        }

        // 2. Intercepta atualização de senha ou segurança (UPDATE)
        if (query.includes('update players') || query.includes('update usuarios')) {
            let updateData = {};
            let userId = params[params.length - 1]; 

            if (query.includes('password_hash = ?') && query.includes('security_question = ?')) {
                updateData = { password: params[0], pergunta_seguranca: params[1], resposta_seguranca: params[2] };
            } else if (query.includes('password_hash = ?')) {
                updateData = { password: params[0] };
            } else if (query.includes('wins = ?')) {
                updateData = { vitorias: params[0], derrotas: params[1] };
            }

            const { error } = await supabase.from('usuarios').update(updateData).eq('id', userId);
            if (error) return callback(error);
            return callback(null);
        }

        callback(null);
    } catch (err) {
        console.error("Erro interno no RUN do tradutor:", err);
        callback(err);
    }
}

// Exporta tudo empacotado simulando o sqlite3 tradicional
module.exports = {
    get,
    run,
    all: async function(sql, callback) {
        try {
            // Buscamos apenas o que existe na tabela para evitar o erro de coluna ausente
            const { data, error } = await supabase
                .from('usuarios')
                .select('username, vitorias, derrotas')
                .order('vitorias', { ascending: false })
                .limit(50);

            if (error) {
                console.error("Erro ao buscar records no Supabase:", error);
                return callback(error, null);
            }

            // Traduz e calcula as partidas dinamicamente em tempo de execução
            const formatted = (data || []).map(r => ({
                username: r.username,
                wins: r.vitorias || 0,
                losses: r.derrotas || 0,
                matches: (r.vitorias || 0) + (r.derrotas || 0)
            }));

            callback(null, formatted);
        } catch (err) {
            console.error("Erro interno na função all do tradutor:", err);
            callback(err, null);
        }
    }
};