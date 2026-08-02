const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bcrypt = require("bcrypt");
const supabase = require("./supabase"); // Puxando nossa conexão com o Supabase
const gameLogic = require('./gameLogic');
const { buildMatchResultSummary } = require('./matchResultUtils');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' , methods: ['GET', 'POST'] }
});

// engine.io low-level logging to help debug client handshake/transport issues
if (io.engine) {
  io.engine.on('connection', (engineSocket) => {
    console.log('engine connected:', engineSocket.id, 'transport=', engineSocket.transport && engineSocket.transport.name);
    engineSocket.on('close', (reason) => console.log('engine close:', reason));
    engineSocket.on('upgrade', (to) => console.log('engine upgrade to:', to && to.name));
  });
}

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const REMOVED_TOKEN_TTL = 60000; // ms to keep a token marked as "removed"
const rooms = {};
const activeSessionsByToken = {};

function getPrivateChatKey(userA, userB) {
  const ids = [Number(userA), Number(userB)].sort((a, b) => a - b);
  return `${ids[0]}:${ids[1]}`;
}

function getPlayerSockets(playerId) {
  return Array.from(io.sockets.sockets.values()).filter((s) => s.data.player?.id === playerId);
}

// 🤝 Atualizado para o Supabase! Verifica se os usuários são amigos
async function areFriends(userId, friendId) {
  if (!userId || !friendId) return false;

  const { data, error } = await supabase
    .from('friendships') // Nome da tabela que usaremos futuramente
    .select('id')
    .eq('user_id', userId)
    .eq('friend_id', friendId)
    .maybeSingle();

  if (error) {
    console.error("Erro ao verificar amizade no Supabase:", error.message);
    return false;
  }

  return Boolean(data);
}

function createRoom(name, isBotRoom = false) {
  return {
    name,
    players: [],
    waitingPlayers: [],
    deck: [],
    discard: [],
    currentTurn: 0,
    playerHasDrawn: {},
    hands: {},
    melds: {},
    scores: {},
    started: false,
    winner: null,
    hostId: null,
    message: 'Aguardando jogadores...',
    privateMessages: {},
    finishedPlayers: [],
    endGameConfirmations: {},
    pendingDisconnects: {},
    resetting: false,
    removedTokens: {},
    chatHistory: [],
    nextStartingPlayerId: null,
    lastWinnerId: null,
    lastWinnerPlayerId: null,
    lastWinnerUsername: null,
    isBotRoom
  };
}

function getRoomById(roomId) {
  return rooms[roomId] || null;
}

function getRoomBySocket(socket) {
  return socket.data.room ? rooms[socket.data.room] : null;
}

function removePlayerFromRoom(room, socket) {
  if (!room || !socket) return false;
  const roomId = socket.data.room;
  const playerIndex = room.players.findIndex((player) => player.id === socket.id);
  const waitingIndex = room.waitingPlayers.findIndex((player) => player.id === socket.id);
  let playerName = null;

  if (playerIndex !== -1) {
    const player = room.players[playerIndex];
    playerName = player.name;
    if (player.token && room.pendingDisconnects[player.token]) {
      clearTimeout(room.pendingDisconnects[player.token].timer);
      delete room.pendingDisconnects[player.token];
    }

    room.players.splice(playerIndex, 1);
    delete room.hands[socket.id];
    delete room.melds[socket.id];
    delete room.playerHasDrawn[socket.id];
    delete room.privateMessages[socket.id];
    room.finishedPlayers = room.finishedPlayers.filter((id) => id !== socket.id);

    if (room.hostId === socket.id) {
      gameLogic.transferHostToActivePlayer(room, socket.id);
    }

    if (room.players.length > 0) {
      if (room.currentTurn >= room.players.length) {
        room.currentTurn = 0;
      }
      const currentPlayer = room.players[room.currentTurn];
      if (!currentPlayer || room.finishedPlayers.includes(currentPlayer.id) || currentPlayer.disconnected) {
        const firstActive = getFirstActiveOnlinePlayerIndex(room);
        room.currentTurn = firstActive === -1 ? 0 : firstActive;
      }
      room.message = `${playerName} saiu da mesa.`;
      if (roomId) broadcastState(room);
    } else {
      if (roomId && (room.isBotRoom || room.name.startsWith('Bot Room'))) {
        delete rooms[roomId];
      } else if (room) {
        room.started = false;
        room.winner = null;
        room.deck = [];
        room.discard = [];
        room.currentTurn = 0;
        room.finishedPlayers = [];
        room.resetting = false;
        if (room.waitingPlayers.length === 0) {
          room.chatHistory = [];
          room.privateMessages = {};
          room.message = 'Aguardando jogadores...';
        }
        if (roomId) processWaitingPlayers(io, room, roomId);
      }
    }

    if (roomId) {
      socket.leave(roomId);
      socket.leave(`${roomId}-waiting`);
    }
    return true;
  }

  if (waitingIndex !== -1) {
    const waitingPlayer = room.waitingPlayers[waitingIndex];
    playerName = waitingPlayer.name;
    if (waitingPlayer.token && room.pendingDisconnects[waitingPlayer.token]) {
      clearTimeout(room.pendingDisconnects[waitingPlayer.token].timer);
      delete room.pendingDisconnects[waitingPlayer.token];
    }
    room.waitingPlayers.splice(waitingIndex, 1);
    room.message = `${playerName} saiu da fila de espera.`;
    if (roomId) {
      io.to(roomId).emit('update-waiting-count', room.waitingPlayers.length);
      socket.leave(`${roomId}-waiting`);
      broadcastState(room);
    }
    return true;
  }

  return false;
}

const SALT_ROUNDS = 10;

// 💡 Nota da Lia: As antigas funções dbGet e dbRun duplicadas foram removidas daqui de baixo com sucesso!
async function findPlayerByUsername(username) {
  const normalizedUser = String(username || '').trim().toLowerCase();
  if (!normalizedUser) return null;

  // Busca na tabela 'usuarios' ignorando maiúsculas/minúsculas
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, username, password, vitorias, derrotas, pergunta_seguranca, resposta_seguranca, avatar')
    .ilike('username', normalizedUser) // ilike não diferencia maiúscula de minúscula
    .maybeSingle(); // Retorna o objeto do usuário ou null se não achar

  if (error) {
    console.error("Erro ao buscar usuário por username no Supabase:", error.message);
    return null;
  }

  // Mapeia os nomes das colunas do Supabase para o formato que seu jogo já usa
  if (data) {
    return {
      id: data.id,
      username: data.username,
      password_hash: data.password, // sua senha criptografada
      wins: data.vitorias,
      losses: data.derrotas,
      security_question: data.pergunta_seguranca,
      security_answer_hash: data.resposta_seguranca,
      avatar: data.avatar
    };
  }
  return null;
}

// Buscar jogador por ID no Supabase
async function findPlayerById(id) {
  if (!id) return null;

  const { data, error } = await supabase
    .from('usuarios')
    .select('id, username, password, vitorias, derrotas, pergunta_seguranca, resposta_seguranca, avatar')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error("Erro ao buscar usuário por ID no Supabase:", error.message);
    return null;
  }

  if (data) {
    return {
      id: data.id,
      username: data.username,
      password_hash: data.password,
      wins: data.vitorias,
      losses: data.derrotas,
      security_question: data.pergunta_seguranca,
      security_answer_hash: data.resposta_seguranca,
      avatar: data.avatar
    };
  }
  return null;
}

// Verifica se o amigo está online no Socket.io (continua igualzinha!)
async function getFriendStatus(playerId) {
  if (!playerId) return 'Offline';

  const sockets = Array.from(io.sockets.sockets.values()).filter((s) => s.data.player?.id === playerId);
  if (sockets.length === 0) return 'Offline';

  let hasLobby = false;
  for (const clientSocket of sockets) {
    const room = getRoomBySocket(clientSocket);
    if (!room) {
      continue;
    }
    if (room.started) {
      return 'Em partida';
    }
    hasLobby = true;
  }

  return hasLobby ? 'Online' : 'No lobby';
}


async function listFriends(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from('friendships')
      .select('friend_id')
      .eq('user_id', userId);

    if (error) {
      console.error('Erro ao listar amigos no Supabase:', error.message || error);
      return [];
    }

    const friends = await Promise.all(
      (data || []).map(async (row) => {
        const friend = await findPlayerById(row.friend_id);
        if (!friend) return null;
        return {
          id: friend.id,
          username: friend.username,
          status: await getFriendStatus(friend.id),
        };
      })
    );

    return friends.filter(Boolean);
  } catch (err) {
    console.error('Erro inesperado em listFriends:', err);
    return [];
  }
}

async function addFriend(userId, friendUsername) {
  if (!userId || !friendUsername) {
    return { success: false, message: 'Nome de usuário inválido.' };
  }

  const friend = await findPlayerByUsername(friendUsername);
  if (!friend) {
    return { success: false, message: 'Usuário não encontrado.' };
  }
  if (friend.id === userId) {
    return { success: false, message: 'Não é possível adicionar você mesmo.' };
  }

  try {
      const { data: existing, error: existingErr } = await supabase
        .from('friendships')
        .select('id')
        .or(`and(user_id.eq.${userId},friend_id.eq.${friend.id}),and(user_id.eq.${friend.id},friend_id.eq.${userId})`)
        .limit(1);

      if (existingErr) {
        console.error('Erro ao verificar amizade existente:', existingErr);
        return { success: false, message: 'Erro no servidor.' };
      }
      if (Array.isArray(existing) && existing.length > 0) {
        return { success: false, message: 'Esse usuário já está na sua lista de amigos.' };
      }

      const { error: insertErr } = await supabase.from('friendships').insert([
        { user_id: userId, friend_id: friend.id },
        { user_id: friend.id, friend_id: userId },
      ]);

      if (insertErr) {
        if (insertErr.code === '23505' || insertErr.details?.includes('duplicate key')) {
          return { success: false, message: 'Esse usuário já está na sua lista de amigos.' };
        }
        console.error('Erro ao adicionar amigo no Supabase:', insertErr);
        return { success: false, message: insertErr.message || 'Falha ao adicionar amigo.' };
      }
    return { success: true, friend: { id: friend.id, username: friend.username } };
  } catch (err) {
    console.error('addFriend error:', err);
    return { success: false, message: 'Erro no servidor.' };
  }
}

async function removeFriend(userId, friendId) {
  if (!userId || !friendId) {
    return { success: false, message: 'ID de amigo inválido.' };
  }
  try {
    const { error } = await supabase
      .from('friendships')
      .delete()
      .or(`and(user_id.eq.${userId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${userId})`);

    if (error) {
      console.error('Erro ao remover amizade no Supabase:', error);
      return { success: false, message: 'Falha ao remover amigo.' };
    }

    return { success: true };
  } catch (err) {
    console.error('removeFriend error:', err);
    return { success: false, message: 'Erro no servidor.' };
  }
}

async function createPlayerRecord(username, passwordHash, securityQuestion, securityAnswerHash) {
  const { data, error } = await supabase
    .from('usuarios')
    .insert({
      username,
      password: passwordHash,
      pergunta_seguranca: securityQuestion,
      resposta_seguranca: securityAnswerHash,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('Erro ao criar registro de jogador no Supabase:', error);
    throw error;
  }

  return data?.id;
}

async function updatePlayerPassword(playerId, passwordHash) {
  if (!playerId || !passwordHash) return;
  const { error } = await supabase.from('usuarios').update({ password: passwordHash }).eq('id', playerId);
  if (error) console.error('Erro ao atualizar senha no Supabase:', error);
}

async function updatePlayerSecuritySetup(playerId, securityQuestion, securityAnswerHash) {
  if (!playerId || !securityQuestion || !securityAnswerHash) return;
  const { error } = await supabase
    .from('usuarios')
    .update({ pergunta_seguranca: securityQuestion, resposta_seguranca: securityAnswerHash })
    .eq('id', playerId);
  if (error) console.error('Erro ao atualizar dados de segurança no Supabase:', error);
}

async function updatePlayerStats(playerId, winsDelta = 0, lossesDelta = 0, matchDelta = 0) {
  if (!playerId) return;
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('vitorias, derrotas, matches')
      .eq('id', playerId)
      .maybeSingle();

    if (error) {
      console.error('Erro ao obter stats do jogador no Supabase:', error);
      return;
    }

    const newWins = (data?.vitorias || 0) + winsDelta;
    const newLosses = (data?.derrotas || 0) + lossesDelta;
    const newMatches = (data?.matches || 0) + matchDelta;

    const { error: updateErr } = await supabase
      .from('usuarios')
      .update({ vitorias: newWins, derrotas: newLosses, matches: newMatches })
      .eq('id', playerId);

    if (updateErr) console.error('Erro ao atualizar stats no Supabase:', updateErr);
  } catch (err) {
    console.error('updatePlayerStats error:', err);
  }
}

function persistPlayerWin(playerId) {
  if (!playerId) return;
  updatePlayerStats(playerId, 1, 0, 1).catch((err) => {
    console.error('Falha ao persistir vitória do jogador:', err);
  });
}

function persistPlayerLoss(playerId) {
  if (!playerId) return;
  updatePlayerStats(playerId, 0, 1, 1).catch((err) => {
    console.error('Falha ao persistir derrota do jogador:', err);
  });
}

function persistMatchResults(room, winnerId) {
  const result = buildMatchResultSummary(room, winnerId);
  if (!result.winner && result.losers.length === 0) {
    return;
  }

  if (result.winner?.playerId) {
    persistPlayerWin(result.winner.playerId);
  }

  result.losers.forEach((player) => {
    if (player.playerId) {
      persistPlayerLoss(player.playerId);
    }
  });
}

function buildRoomPlayerEntry(socket, name) {
  return {
    id: socket.id,
    name,
    token: socket.data.playerToken,
    playerId: socket.data.player?.id || null,
  };
}

function updateCurrentRoomPlayerFromLogin(socket) {
  if (!socket.data.player || !socket.data.room) return;
  const room = getRoomBySocket(socket);
  if (!room) return;
  const player = room.players.find((entry) => entry.id === socket.id) || room.waitingPlayers.find((entry) => entry.id === socket.id);
  if (player) {
    player.name = socket.data.player.username;
    player.playerId = socket.data.player.id;
  }
}

function isPlayerOnline(room, player) {
  return Boolean(player && !room.finishedPlayers.includes(player.id) && !player.disconnected);
}

function getFirstActiveOnlinePlayerIndex(room) {
  if (!Array.isArray(room.players) || room.players.length === 0) return -1;
  const finishedSet = new Set(room.finishedPlayers);
  for (let i = 0; i < room.players.length; i += 1) {
    const player = room.players[i];
    if (player && !finishedSet.has(player.id) && !player.disconnected) {
      return i;
    }
  }
  return -1;
}

function getNextActiveOnlinePlayerIndex(room) {
  if (!Array.isArray(room.players) || room.players.length === 0) return -1;
  const totalPlayers = room.players.length;
  const finishedSet = new Set(room.finishedPlayers);
  for (let i = 1; i <= totalPlayers; i += 1) {
    const nextIndex = (room.currentTurn + i) % totalPlayers;
    const player = room.players[nextIndex];
    if (player && !finishedSet.has(player.id) && !player.disconnected) {
      return nextIndex;
    }
  }
  return -1;
}

function getRoomList() {
  closeEmptyRooms();
  return Object.entries(rooms)
    .filter(([, room]) => !room.isBotRoom)
    .map(([id, room]) => ({
      id,
      name: room.name,
      players: room.players.length,
      waiting: room.waitingPlayers.length,
      started: room.started,
      maxPlayers: MAX_PLAYERS
    }));
}

function closeEmptyRooms() {
  Object.entries(rooms).forEach(([id, room]) => {
    const hasHuman = room.players.some((player) => !isBotPlayerId(player.id));
    if (id !== 'mesa-1' && room.players.length === 0) {
      delete rooms[id];
    }
    if (room.isBotRoom && !hasHuman && room.players.length === 0) {
      delete rooms[id];
    }
  });
}

function generatePlayerToken() {
  return `player-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function isBotPlayerId(id) {
  return typeof id === 'string' && id.startsWith('bot-');
}

function findPlayerByToken(token) {
  if (!token) return null;
  for (const room of Object.values(rooms)) {
    // If this token was marked as removed recently, signal that back to caller
    if (room.removedTokens && room.removedTokens[token]) {
      return { room, removed: true, tokenInfo: room.removedTokens[token] };
    }

    const playerIndex = room.players.findIndex((player) => player.token === token);
    if (playerIndex !== -1) {
      return { room, player: room.players[playerIndex], playerIndex };
    }
    const waitingIndex = room.waitingPlayers.findIndex((player) => player.token === token);
    if (waitingIndex !== -1) {
      return { room, player: room.waitingPlayers[waitingIndex], waitingIndex, isWaiting: true };
    }
  }
  return null;
}

function transferPlayerState(room, oldId, newId) {
  if (oldId === newId) return;
  room.hands[newId] = room.hands[oldId] || [];
  room.melds[newId] = room.melds[oldId] || [];
  room.playerHasDrawn[newId] = room.playerHasDrawn[oldId] || false;
  room.scores[newId] = room.scores[oldId] || 0;
  delete room.hands[oldId];
  delete room.melds[oldId];
  delete room.playerHasDrawn[oldId];
  delete room.scores[oldId];
  room.finishedPlayers = room.finishedPlayers.map((id) => (id === oldId ? newId : id));
  if (room.hostId === oldId) room.hostId = newId;
}

function cleanupDisconnectedPlayer(room, oldId) {
  const disconnectInfo = Object.values(room.pendingDisconnects).find((info) => info.oldId === oldId);
  if (!disconnectInfo) return;
  const playerIndex = room.players.findIndex((player) => player.id === oldId);
  if (playerIndex === -1) {
    delete room.pendingDisconnects[disconnectInfo.token || oldId];
    return;
  }

  const playerName = room.players[playerIndex].name;
  room.players.splice(playerIndex, 1);
  delete room.hands[oldId];
  delete room.melds[oldId];
  delete room.playerHasDrawn[oldId];
  delete room.privateMessages[oldId];
  room.finishedPlayers = room.finishedPlayers.filter((id) => id !== oldId);

  if (room.hostId === oldId) {
    gameLogic.transferHostToActivePlayer(room, oldId);
  }

  if (room.players.length > 0) {
    if (room.currentTurn >= room.players.length) {
      room.currentTurn = 0;
    }
    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer || room.finishedPlayers.includes(currentPlayer.id) || currentPlayer.disconnected) {
      const firstActive = getFirstActiveOnlinePlayerIndex(room);
      room.currentTurn = firstActive === -1 ? 0 : firstActive;
    }
    room.message = `${playerName} não retornou a tempo e foi removido.`;
    broadcastState(room);
  }

  delete room.pendingDisconnects[disconnectInfo.token || oldId];

  // If the disconnected player had a token, mark it as removed for a short TTL
  const removedToken = disconnectInfo.token;
  if (removedToken) {
    room.removedTokens = room.removedTokens || {};
    room.removedTokens[removedToken] = { removedAt: Date.now() };
    setTimeout(() => {
      if (room.removedTokens && room.removedTokens[removedToken]) {
        delete room.removedTokens[removedToken];
      }
    }, REMOVED_TOKEN_TTL);
  }

  if (room.players.length === 0) {
    if (room.isBotRoom || room.name.startsWith('Bot Room')) {
      const roomId = Object.keys(rooms).find((id) => rooms[id] === room);
      if (roomId) delete rooms[roomId];
      return;
    }
    room.started = false;
    room.winner = null;
    room.deck = [];
    room.discard = [];
    room.currentTurn = 0;
    room.finishedPlayers = [];
    room.resetting = false;
  }
}

function restoreDisconnectedPlayer(socket, tokenInfo) {
  const { room, player, playerIndex, isWaiting } = tokenInfo;
  const oldId = player.id;
  player.id = socket.id;
  player.disconnected = false;
  socket.data.room = Object.keys(rooms).find((key) => rooms[key] === room);
  if (socket.data.room) socket.join(socket.data.room);
  if (room.pendingDisconnects[player.token]) {
    clearTimeout(room.pendingDisconnects[player.token].timer);
    delete room.pendingDisconnects[player.token];
  }

  if (isWaiting) {
    player.id = socket.id;
    socket.join(`${socket.data.room}-waiting`);
    room.message = `${player.name} reconectou na sala de espera.`;
    io.to(`${socket.data.room}-waiting`).emit('waiting-count', room.waitingPlayers.length);
    return;
  }

  transferPlayerState(room, oldId, socket.id);
  room.players[playerIndex].id = socket.id;
  room.players[playerIndex].disconnected = false;
  room.message = `${player.name} reconectou.`;
  broadcastState(room);
}

function createBotId(room, index) {
  const safeRoom = String(room.name || 'bot').replace(/\W+/g, '-').toLowerCase();
  return `bot-${safeRoom}-${Date.now()}-${index}`;
}

function getBotPlayers(room) {
  return room.players.filter((player) => isBotPlayerId(player.id));
}

function addBotPlayers(room, count) {
  for (let i = 1; i <= count; i += 1) {
    const botId = createBotId(room, i);
    room.players.push({ id: botId, name: `Lulu-bot ${i}` });
    room.hands[botId] = [];
    room.melds[botId] = [];
    room.playerHasDrawn[botId] = false;
    room.scores[botId] = room.scores[botId] || 0;
  }
}

function clearBotTimer(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

function scheduleBotTurn(room) {
  clearBotTimer(room);
  if (!room.started || room.winner) return;
  const currentPlayer = room.players[room.currentTurn];
  if (!currentPlayer || !isBotPlayerId(currentPlayer.id)) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!room.started || room.winner) return;
    const nextPlayer = room.players[room.currentTurn];
    if (!nextPlayer || !isBotPlayerId(nextPlayer.id)) return;
    performBotTurn(room, nextPlayer.id);
  }, Math.floor(Math.random() * 1500) + 2000);
}

function getDiscardTop(room) {
  return room.discard.length > 0 ? room.discard[room.discard.length - 1] : null;
}

function isCardUsefulForMelds(hand, card) {
  const tempHand = [...hand, card];
  const byValue = {};
  tempHand.forEach((c) => {
    const parsed = parseCarta(c);
    byValue[parsed.valor] = byValue[parsed.valor] || [];
    byValue[parsed.valor].push(c);
  });
  if (Object.values(byValue).some((group) => group.length >= 3)) return true;

  const bySuit = {};
  tempHand.forEach((c) => {
    const parsed = parseCarta(c);
    bySuit[parsed.naipe] = bySuit[parsed.naipe] || [];
    bySuit[parsed.naipe].push(parsed.index);
  });
  return Object.values(bySuit).some((indices) => {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    for (let i = 0; i <= sorted.length - 3; i += 1) {
      if (sorted[i + 1] === sorted[i] + 1 && sorted[i + 2] === sorted[i] + 2) {
        return true;
      }
    }
    return false;
  });
}

function findValidMeldsForHand(hand) {
  const melds = [];
  
  const byValue = {};
  hand.forEach((c) => {
    const parsed = parseCarta(c);
    byValue[parsed.valor] = byValue[parsed.valor] || [];
    byValue[parsed.valor].push(c);
  });
  Object.values(byValue).forEach((cards) => {
    if (cards.length >= 3) {
      melds.push(cards.slice(0, cards.length));
    }
  });

  const bySuit = {};
  hand.forEach((c) => {
    const parsed = parseCarta(c);
    bySuit[parsed.naipe] = bySuit[parsed.naipe] || [];
    bySuit[parsed.naipe].push({ card: c, index: parsed.index });
  });
  Object.values(bySuit).forEach((cards) => {
    const sorted = cards.sort((a, b) => a.index - b.index);
    let run = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].index === sorted[i - 1].index + 1) {
        run.push(sorted[i]);
      } else {
        if (run.length >= 3) {
          melds.push(run.map((item) => item.card));
        }
        run = [sorted[i]];
      }
    }
    if (run.length >= 3) melds.push(run.map((item) => item.card));
    
    // Verifica se há Q, K, A (11, 12, 0 nos índices)
    const indices = sorted.map((item) => item.index);
    if (indices.includes(0) && indices.includes(11) && indices.includes(12)) {
      const qka = sorted.filter((item) => [0, 11, 12].includes(item.index));
      if (qka.length === 3) {
        melds.push(qka.map((item) => item.card));
      }
    }
  });

  return melds;
}

function chooseBotDiscardCard(hand) {
  const potential = new Set();
  const melds = findValidMeldsForHand(hand);
  melds.forEach((meld) => meld.forEach((c) => potential.add(c)));
  const candidates = hand.filter((c) => !potential.has(c));
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return hand[Math.floor(Math.random() * hand.length)];
}

function performBotTurn(room, botId) {
  if (!room.started || room.winner) return;
  const botHand = room.hands[botId];
  if (!botHand) return;

  const discardTop = getDiscardTop(room);
  if (!room.playerHasDrawn[botId]) {
    if (discardTop && isCardUsefulForMelds(botHand, discardTop)) {
      room.discard.pop();
      botHand.push(discardTop);
      room.playerHasDrawn[botId] = true;
      room.message = `${room.players[room.currentTurn]?.name || 'Jogador'} comprou do descarte.`;
    } else {
      // Se o baralho está vazio, tenta reembaralhar
      if (room.deck.length === 0) {
        reembaralharDescarte(room);
      }
      
      if (room.deck.length > 0) {
        const card = room.deck.pop();
        botHand.push(card);
        room.playerHasDrawn[botId] = true;
        room.message = `${room.players[room.currentTurn]?.name || 'Jogador'} comprou do baralho.`;
      }
    }
  }

  const melds = findValidMeldsForHand(botHand);
  if (melds.length > 0) {
    melds.forEach((meld) => {
      if (meld.every((c) => botHand.includes(c))) {
        meld.forEach((c) => {
          const idx = botHand.indexOf(c);
          if (idx !== -1) botHand.splice(idx, 1);
        });
        room.melds[botId].push(meld);
      }
    });
    room.message = `${room.players[room.currentTurn]?.name || 'Jogador'} declarou conjunto(s).`;
  }

  const canBotWin = canBatWithHandAndMelds(room, botId);
  if (canBotWin) {
    room.currentTurn = room.players.findIndex((p) => p.id === botId);
    const finishResult = gameLogic.markPlayerFinished(room, botId);
    if (finishResult.gameEnded) {
      room.winner = finishResult.winner;
      setNextStartingPlayer(room, finishResult.winner);
      recordWin(room, room.winner);
      persistMatchResults(room, room.winner);
      room.message = `🎉🎈 ${finishResult.winnerName} venceu! 🎈🎉`;
      clearBotTimer(room);
      broadcastState(room);
      return;
    }
    const nextIdx = nextPlayerIndex(room);
    room.currentTurn = nextIdx !== -1 ? nextIdx : getFirstActiveIndex(room);
    room.message = `${room.players.find((p) => p.id === botId)?.name || 'Bot'} bateu e foi finalizado.`;
    recordWin(room, botId);
    persistMatchResults(room, botId);
    clearBotTimer(room);
    broadcastState(room);
    return;
  }

  if (room.playerHasDrawn[botId]) {
    const cardToDiscard = chooseBotDiscardCard(botHand);
    const index = botHand.indexOf(cardToDiscard);
    if (index !== -1) {
      botHand.splice(index, 1);
      room.discard.push(cardToDiscard);
    }
    room.playerHasDrawn[botId] = false;
    const nextIdx = nextPlayerIndex(room);
    room.currentTurn = nextIdx !== -1 ? nextIdx : getFirstActiveIndex(room);
    room.message = `${room.players.find((p) => p.id === botId)?.name || 'Bot'} descartou ${cardToDiscard}.`;
    clearBotTimer(room);
    broadcastState(room);
    return;
  }

  broadcastState(room);
}

rooms['mesa-1'] = createRoom('Mesa 1');

app.use(express.static(__dirname));

function criarBaralho(numPlayers = 2) {
  const naipes = ['♠', '♥', '♦', '♣'];
  const valores = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  
  // Ajuste do número de baralhos com base na quantidade de jogadores e cartas necessárias
  // - 1-5 jogadores: 1 baralho (52 cartas)
  // - 6-8 jogadores: 2 baralhos (104 cartas)
  // - 9-10 jogadores: 3 baralhos (156 cartas)
  let decksNeeded = 1;
  if (numPlayers >= 9) decksNeeded = 3;
  else if (numPlayers >= 6) decksNeeded = 2;
  
  for (let d = 0; d < decksNeeded; d += 1) {
    for (const naipe of naipes) {
      for (const valor of valores) {
        deck.push(`${valor}${naipe}`);
      }
    }
  }
  return deck;
}

function embaralhar(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * Reembaralha o descarte de volta ao baralho quando o baralho acaba
 * Deixa a última carta do descarte como base (não adiciona ao baralho)
 * Retorna true se conseguiu reembaralhar, false se o descarte tem menos de 2 cartas
 */
function reembaralharDescarte(room) {
  // Se o descarte tem pelo menos 2 cartas (mantém 1 como base)
  if (room.discard.length < 2) {
    return false;
  }
  
  // Tira a última carta do descarte (a que fica como base)
  const lastCard = room.discard.pop();
  
  // Move todas as outras cartas do descarte para o baralho
  while (room.discard.length > 0) {
    room.deck.push(room.discard.pop());
  }
  
  // Reembaralha o baralho
  embaralhar(room.deck);
  
  // Coloca a carta base de volta no descarte
  room.discard.push(lastCard);
  
  return true;
}

function processWaitingPlayers(io, room, roomId) {
  if (room.waitingPlayers.length === 0) return;
  const availableSlots = MAX_PLAYERS - room.players.length;
  for (let i = 0; i < availableSlots && room.waitingPlayers.length > 0; i++) {
    const waitingPlayer = room.waitingPlayers.shift();
    room.players.push(waitingPlayer);
  }
  if (room.waitingPlayers.length > 0) {
    io.to(`${roomId}-waiting`).emit('waiting-count', room.waitingPlayers.length);
  }
}

function buildPublicState(room, socketId = null) {
  const finishedSet = new Set(room.finishedPlayers || []);
  const currentPlayerId = room.players[room.currentTurn]?.id || null;
  const activeCount = gameLogic.countActivePlayers(room);
  const { canOfferEndGame } = gameLogic.canOfferEndGame(room);
  const waitingPlayers = (room.waitingPlayers || []).map((player) => ({
    id: player.id,
    name: player.name,
  }));
  const isWaiting = socketId ? waitingPlayers.some((player) => player.id === socketId) : false;
  const waitingPosition = isWaiting ? waitingPlayers.findIndex((player) => player.id === socketId) + 1 : null;
  
  return {
    roomName: room.name,
    waitingPlayers,
    waitingPosition,
    isWaiting,
    players: room.players.map((player, index) => {
      const finished = finishedSet.has(player.id);
      return {
        id: player.id,
        name: player.name,
        finished,
        offline: Boolean(player.disconnected),
        handCount: room.hands[player.id]?.length || 0,
        melds: room.melds[player.id] || [],
        publicHand: room.winner || finished ? (room.hands[player.id] || []) : null,
        seat: index,
        score: room.scores[player.id] || 0
      };
    }),
    currentTurn: room.currentTurn,
    currentTurnPlayerId: currentPlayerId,
    currentPlayerHasDrawn: Boolean(room.playerHasDrawn[currentPlayerId]),
    deckCount: room.deck.length,
    discardTop: room.discard.length > 0 ? room.discard[room.discard.length - 1] : null,
    started: room.started,
    winner: room.winner,
    finishedPlayers: room.finishedPlayers,
    activePlayersCount: activeCount,
    canOfferEndGame,
    activeCount,
    hostId: room.hostId,
    message: room.message,
    isBotRoom: room.isBotRoom,
    maxPlayers: MAX_PLAYERS,
    chatHistory: room.chatHistory || []
  };
}

function sendStateTo(socketId) {
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return;
  const room = getRoomBySocket(socket);
  if (!room) return;
  const privateMessage = room.privateMessages[socketId] || null;
  delete room.privateMessages[socketId];
  socket.emit('state', {
    ...buildPublicState(room, socketId),
    myId: socketId,
    myHand: room.hands[socketId] || [],
    privateMessage
  });
}

function broadcastState(room) {
  room.players.forEach((player) => sendStateTo(player.id));
  room.waitingPlayers.forEach((player) => sendStateTo(player.id));
  if (room.started && !room.winner) {
    scheduleBotTurn(room);
  } else {
    clearBotTimer(room);
  }
}

function getActivePlayerIds(room) {
  return room.players.filter((player) => !room.finishedPlayers.includes(player.id)).map((player) => player.id);
}

function isPlayerFinished(room, socketId) {
  return room.finishedPlayers.includes(socketId);
}

function getFirstActiveIndex(room) {
  return gameLogic.findFirstActivePlayerIndex(room);
}

function nextPlayerIndex(room) {
  return gameLogic.findNextActivePlayerIndex(room);
}

function startGame(room) {
  room.deck = criarBaralho(room.players.length);
  embaralhar(room.deck);
  room.discard = [];
  room.currentTurn = getNextStartingPlayerIndex(room);
  room.nextStartingPlayerId = null;
  room.winner = null;
  room.started = true;
  room.finishedPlayers = [];
  room.endGameConfirmations = {};
  room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;

  room.players.forEach((player) => {
    room.hands[player.id] = [];
    room.melds[player.id] = [];
    room.playerHasDrawn[player.id] = false;
  });

  for (let i = 0; i < 9; i++) {
    room.players.forEach((player) => {
      room.hands[player.id].push(room.deck.pop());
    });
  }

  room.discard.push(room.deck.pop());
  room.finishedPlayers = [];
  clearBotTimer(room);
  broadcastState(room);
}

function parseCarta(carta) {
  const naipe = carta.slice(-1);
  const valor = carta.slice(0, -1);
  const valores = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return { valor, naipe, label: carta, index: valores.indexOf(valor) };
}

function verificarBater(hand) {
  const parsed = hand.map(parseCarta);
  const naipes = ['♠', '♥', '♦', '♣'];
  const ordenado = [...parsed].sort((a, b) => {
    if (a.naipe === b.naipe) return a.index - b.index;
    return naipes.indexOf(a.naipe) - naipes.indexOf(b.naipe);
  });

  function recusar(cartas) {
    if (cartas.length === 0) return [];
    const first = cartas[0];
    const igualRank = cartas.filter((c) => c.valor === first.valor);
    if (igualRank.length >= 3) {
      const resto = cartas.filter((c) => c.valor !== first.valor);
      const proximo = recusar(resto);
      if (proximo) return [[...igualRank.map((c) => c.label)], ...proximo];
    }

    const mesmosNaipe = cartas.filter((c) => c.naipe === first.naipe);
    const indices = mesmosNaipe.map((c) => c.index);
    for (let start = 0; start < indices.length; start++) {
      for (let end = start + 3; end <= indices.length; end++) {
        const slice = indices.slice(start, end);
        if (slice.length < 3) continue;
        let valido = true;
        
        // Verifica sequência padrão (índices consecutivos)
        for (let i = 1; i < slice.length; i++) {
          if (slice[i] !== slice[i - 1] + 1) {
            valido = false;
            break;
          }
        }
        
        // Se não é sequência padrão, verifica se é Q, K, A (11, 12, 0)
        if (!valido && slice.length === 3) {
          const sorted = slice.sort((a, b) => a - b);
          if (sorted[0] === 0 && sorted[1] === 11 && sorted[2] === 12) {
            valido = true;
          }
        }
        
        if (!valido) continue;
        const meld = mesmosNaipe.slice(start, end);
        const restantes = cartas.filter((c) => !meld.includes(c));
        const proximo = recusar(restantes);
        if (proximo) return [[...meld.map((c) => c.label)], ...proximo];
      }
    }
    return null;
  }

  const ensamblado = recusar(ordenado);
  return {
    success: Boolean(ensamblado),
    melds: ensamblado || []
  };
}

function validarMeld(cards) {
  if (!Array.isArray(cards) || cards.length < 3) return false;
  if (new Set(cards).size !== cards.length) return false;
  const parsed = cards.map(parseCarta);
  // all same rank (trinca)
  const sameRank = parsed.every((c) => c.valor === parsed[0].valor);
  if (sameRank) return true;
  // or same suit and consecutive (sequência)
  const sameSuit = parsed.every((c) => c.naipe === parsed[0].naipe);
  if (!sameSuit) return false;
  const indices = parsed.map((c) => c.index).sort((a, b) => a - b);
  
  // Verifica sequência padrão (ex: 2, 3, 4 ou J, Q, K)
  let sequenciaPadrao = true;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      sequenciaPadrao = false;
      break;
    }
  }
  if (sequenciaPadrao) return true;
  
  // Caso especial: Q, K, A (11, 12, 0) = sequência válida
  if (indices.length === 3 && indices[0] === 0 && indices[1] === 11 && indices[2] === 12) {
    return true;
  }
  
  return false;
}

function getPlayerIndex(room, socketId) {
  return room.players.findIndex((player) => player.id === socketId);
}

function getCurrentPlayerId(room) {
  return room.players[room.currentTurn]?.id;
}

function getNextStartingPlayerIndex(room) {
  // Primeiro, tenta usar o último vencedor (persistente através de reinícios)
  if (room.lastWinnerId) {
    // Tenta casar com socket id atual
    let nextIndex = room.players.findIndex((player) => player.id === room.lastWinnerId && !player.disconnected);
    if (nextIndex !== -1) return nextIndex;

    // Se não encontrar, tenta casar com playerId (ID persistente do usuário no banco)
    if (room.lastWinnerPlayerId) {
      nextIndex = room.players.findIndex((player) => String(player.playerId) === String(room.lastWinnerPlayerId) && !player.disconnected);
      if (nextIndex !== -1) return nextIndex;
    }
  }
  
  // Fallback: usar nextStartingPlayerId se disponível
  if (room.nextStartingPlayerId) {
    // Tenta casar com socket id atual
    let nextIndex = room.players.findIndex((player) => player.id === room.nextStartingPlayerId && !player.disconnected);
    if (nextIndex !== -1) return nextIndex;

    // Se não encontrar, tenta casar com token (reconexão mantém token)
    nextIndex = room.players.findIndex((player) => player.token === room.nextStartingPlayerId && !player.disconnected);
    if (nextIndex !== -1) return nextIndex;

    // Por fim, tenta casar com playerId (ID persistente do usuário no banco)
    nextIndex = room.players.findIndex((player) => String(player.playerId) === String(room.nextStartingPlayerId) && !player.disconnected);
    if (nextIndex !== -1) return nextIndex;
  }

  // Fallback: primeiro jogador ativo
  return getFirstActiveIndex(room) === -1 ? 0 : getFirstActiveIndex(room);
}

function recordWin(room, winnerId) {
  if (!room.scores) room.scores = {};
  room.scores[winnerId] = (room.scores[winnerId] || 0) + 1;
}

function setNextStartingPlayer(room, winnerId) {
  if (!room) return;
  // Tenta encontrar o jogador pelo socket id
  let player = room.players.find((p) => p.id === winnerId);
  // Se não encontrar, tenta por playerId (persistente)
  if (!player) player = room.players.find((p) => String(p.playerId) === String(winnerId));
  if (player) {
    // Atualizar propriedades persistentes do último vencedor
    room.lastWinnerId = player.id;
    room.lastWinnerPlayerId = player.playerId || null;
    room.lastWinnerUsername = player.name || null;
    
    if (player.token) {
      room.nextStartingPlayerId = player.token;
      return;
    }
    if (player.playerId) {
      room.nextStartingPlayerId = player.playerId;
      return;
    }
    room.nextStartingPlayerId = player.id;
    return;
  }
  // Fallback: grava o id recebido
  room.nextStartingPlayerId = winnerId;
  room.lastWinnerId = winnerId;
}

function jogadorTemMeldCompleto(room, socketId) {
  const melds = room.melds[socketId] || [];
  const totalCartas = melds.reduce((sum, meld) => sum + (Array.isArray(meld) ? meld.length : 0), 0);
  return totalCartas >= 9;
}

function canBatWithHandAndMelds(room, socketId) {
  const melds = room.melds[socketId] || [];
  const hand = room.hands[socketId] || [];
  
  // Contar cartas já em melds
  const cardsInMelds = melds.reduce((sum, meld) => sum + (Array.isArray(meld) ? meld.length : 0), 0);
  
  // Tentar fazer bat com a mão
  const resultado = verificarBater(hand);
  
  if (resultado.success) {
    // Tem melds na mão
    const cardsInHandMelds = resultado.melds.reduce((sum, meld) => sum + meld.length, 0);
    // Total >= 9 (3 trincas)?
    return cardsInMelds + cardsInHandMelds >= 9;
  }
  
  // Ou já tem 9+ em melds declarados
  return cardsInMelds >= 9;
}

function canBatWithHand(room, socketId) {
  const hand = room.hands[socketId] || [];
  const resultado = verificarBater(hand);
  return resultado.success;
}

io.on('connection', (socket) => {
  const token = socket.handshake.auth.playerToken || generatePlayerToken();
  socket.data.playerToken = token;
  console.log(`Socket conectado: ${socket.id} - ${socket.handshake.address} token=${token}`);

  if (!socket.handshake.auth.playerToken) {
    socket.emit('player-token', token);
  }

  const savedSession = activeSessionsByToken[token];
  if (savedSession) {
    socket.data.player = savedSession;
    socket.emit('player-session-restored', socket.data.player);
  }

  const reconnectInfo = findPlayerByToken(token);
  if (reconnectInfo && !reconnectInfo.removed && reconnectInfo.player) {
    restoreDisconnectedPlayer(socket, reconnectInfo);
  } else if (reconnectInfo && reconnectInfo.removed) {
    // Token was previously removed due to timeout; inform client so it can re-auth if needed
    socket.emit('reconnect-expired');
  }

  socket.on('register', async (payload, callback) => {
    const username = String(payload?.username || '').trim().substring(0, 32);
    const password = String(payload?.password || '');

    if (!username || !password) {
      callback({ success: false, message: 'Nome de usuário e senha são obrigatórios.' });
      return;
    }

    try {
      const existingUser = await findPlayerByUsername(username);
      if (existingUser) {
        callback({ success: false, message: 'Nome de usuário já existe.' });
        return;
      }

      const securityQuestion = String(payload?.securityQuestion || '').trim();
      const securityAnswer = String(payload?.securityAnswer || '').trim();
      if (!securityQuestion || !securityAnswer) {
        callback({ success: false, message: 'Pergunta e resposta de segurança são obrigatórias.' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const securityAnswerHash = await bcrypt.hash(securityAnswer.toLowerCase(), SALT_ROUNDS);
      const playerId = await createPlayerRecord(username, passwordHash, securityQuestion, securityAnswerHash);
      socket.data.player = { id: playerId, username, wins: 0, losses: 0, matches: 0, securityConfigured: true };
      activeSessionsByToken[socket.data.playerToken] = socket.data.player;
      updateCurrentRoomPlayerFromLogin(socket);

      callback({ success: true, player: socket.data.player });
    } catch (error) {
      console.error('register error:', error);
      callback({ success: false, message: 'Erro ao criar conta. Tente novamente.' });
    }
  });

  socket.on('login', async (payload, callback) => {
    const username = String(payload?.username || '').trim().substring(0, 32);
    const password = String(payload?.password || '');

    if (!username || !password) {
      callback({ success: false, message: 'Nome de usuário e senha são obrigatórios.' });
      return;
    }

    try {
      const user = await findPlayerByUsername(username);
      if (!user) {
        callback({ success: false, message: 'Usuário ou senha inválidos.' });
        return;
      }

      const passwordMatches = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatches) {
        callback({ success: false, message: 'Usuário ou senha inválidos.' });
        return;
      }

      socket.data.player = {
        id: user.id,
        username: user.username,
        wins: user.wins,
        losses: user.losses,
        matches: user.matches,
        securityConfigured: Boolean(user.security_question && user.security_answer_hash),
      };
      activeSessionsByToken[socket.data.playerToken] = socket.data.player;
      updateCurrentRoomPlayerFromLogin(socket);

      callback({ success: true, player: socket.data.player });
    } catch (error) {
      console.error('login error:', error);
      callback({ success: false, message: 'Erro ao autenticar. Tente novamente.' });
    }
  });

  socket.on('logout', (callback) => {
    const room = getRoomBySocket(socket);
    const wasRemoved = removePlayerFromRoom(room, socket);
    delete activeSessionsByToken[socket.data.playerToken];
    socket.data.player = null;
    socket.data.room = null;
    if (callback) callback({ success: true, removed: wasRemoved });
  });

  socket.on('validate-session', async (playerData, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    
    if (!playerData || !playerData.username) {
      callback(false);
      return;
    }

    try {
      const user = await findPlayerByUsername(playerData.username);
      if (!user) {
        callback(false);
        return;
      }

      // Sessão válida - restaurar dados do jogador
      socket.data.player = {
        id: user.id,
        username: user.username,
        wins: user.wins,
        losses: user.losses,
        matches: user.matches,
        securityConfigured: Boolean(user.security_question && user.security_answer_hash),
      };
      activeSessionsByToken[socket.data.playerToken] = socket.data.player;
      callback(true);
    } catch (error) {
      console.error('validate-session error:', error);
      callback(false);
    }
  });

  socket.on('change-password', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const currentPassword = String(payload?.currentPassword || '');
    const newPassword = String(payload?.newPassword || '');
    const securityQuestion = String(payload?.securityQuestion || '').trim();
    const securityAnswer = String(payload?.securityAnswer || '').trim();

    if (!socket.data.player || !socket.data.player.id) {
      callback({ success: false, message: 'Faça login para alterar a senha.' });
      return;
    }

    if (!currentPassword || !newPassword) {
      callback({ success: false, message: 'Preencha senha atual e nova senha.' });
      return;
    }

    if (newPassword.length < 6) {
      callback({ success: false, message: 'A senha deve ter pelo menos 6 caracteres.' });
      return;
    }

    try {
      const user = await findPlayerById(socket.data.player.id);
      if (!user) {
        callback({ success: false, message: 'Usuário não encontrado.' });
        return;
      }

      const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash);
      if (!passwordMatches) {
        callback({ success: false, message: 'Senha atual incorreta.' });
        return;
      }

      const needsSecuritySetup = !user.security_question || !user.security_answer_hash;
      if (needsSecuritySetup) {
        if (!securityQuestion || !securityAnswer) {
          callback({
            success: false,
            needsSecuritySetup: true,
            message: 'Sua conta não tem pergunta de segurança. Adicione uma pergunta e resposta para continuar.',
          });
          return;
        }

        const answerHash = await bcrypt.hash(securityAnswer.toLowerCase(), SALT_ROUNDS);
        await updatePlayerSecuritySetup(socket.data.player.id, securityQuestion, answerHash);
      }

      const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      await updatePlayerPassword(socket.data.player.id, newHash);

      socket.data.player.securityConfigured = true;
      callback({ success: true, message: 'Senha alterada com sucesso.' });
    } catch (error) {
      console.error('change-password error:', error);
      callback({ success: false, message: 'Erro ao alterar senha. Tente novamente.' });
    }
  });

  socket.on('request-security-question', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const username = String(payload?.username || '').trim().substring(0, 32);
    if (!username) {
      callback({ success: false, message: 'Informe o nome de usuário.' });
      return;
    }

    try {
      const user = await findPlayerByUsername(username);
      if (!user || !user.security_question) {
        callback({ success: false, message: 'Usuário não encontrado ou pergunta de segurança não configurada.' });
        return;
      }

      callback({ success: true, question: user.security_question });
    } catch (error) {
      console.error('request-security-question error:', error);
      callback({ success: false, message: 'Erro ao buscar pergunta de segurança.' });
    }
  });

  socket.on('reset-password', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const username = String(payload?.username || '').trim().substring(0, 32);
    const securityAnswer = String(payload?.securityAnswer || '').trim();
    const newPassword = String(payload?.newPassword || '');

    if (!username || !securityAnswer || !newPassword) {
      callback({ success: false, message: 'Preencha usuário, resposta e nova senha.' });
      return;
    }

    if (newPassword.length < 6) {
      callback({ success: false, message: 'A nova senha deve ter pelo menos 6 caracteres.' });
      return;
    }

    try {
      const user = await findPlayerByUsername(username);
      if (!user || !user.security_answer_hash) {
        callback({ success: false, message: 'Usuário ou dados de segurança inválidos.' });
        return;
      }

      const answerMatches = await bcrypt.compare(securityAnswer.toLowerCase(), user.security_answer_hash);
      if (!answerMatches) {
        callback({ success: false, message: 'Resposta de segurança incorreta.' });
        return;
      }

      const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
      await updatePlayerPassword(user.id, passwordHash);
      callback({ success: true, message: 'Senha redefinida com sucesso.' });
    } catch (error) {
      console.error('reset-password error:', error);
      callback({ success: false, message: 'Erro ao redefinir senha. Tente novamente.' });
    }
  });

  socket.on('list-rooms', (callback) => {
    callback(getRoomList());
  });

  socket.on('list-friends', async (callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    if (!socket.data.player?.id) {
      callback({ success: false, message: 'Faça login para ver sua lista de amigos.' });
      return;
    }

    try {
      const friends = await listFriends(socket.data.player.id);
      callback({ success: true, friends });
    } catch (error) {
      console.error('list-friends error:', error);
      callback({ success: false, message: 'Não foi possível carregar seus amigos.' });
    }
  });

  socket.on('add-friend', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    if (!socket.data.player?.id) {
      callback({ success: false, message: 'Faça login para adicionar amigos.' });
      return;
    }

    const username = String(payload?.username || '').trim().substring(0, 32);
    if (!username) {
      callback({ success: false, message: 'Informe o nome de usuário do amigo.' });
      return;
    }

    try {
      const result = await addFriend(socket.data.player.id, username);
      if (!result.success) {
        callback(result);
        return;
      }
      const friends = await listFriends(socket.data.player.id);
      callback({ success: true, message: 'Amigo adicionado com sucesso.', friends });
    } catch (error) {
      console.error('add-friend error:', error);
      callback({ success: false, message: 'Erro ao adicionar amigo. Tente novamente.' });
    }
  });

  socket.on('remove-friend', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    if (!socket.data.player?.id) {
      callback({ success: false, message: 'Faça login para remover amigos.' });
      return;
    }

    const friendId = Number(payload?.friendId);
    if (!friendId) {
      callback({ success: false, message: 'ID de amigo inválido.' });
      return;
    }

    try {
      await removeFriend(socket.data.player.id, friendId);
      const friends = await listFriends(socket.data.player.id);
      callback({ success: true, message: 'Amigo removido com sucesso.', friends });
    } catch (error) {
      console.error('remove-friend error:', error);
      callback({ success: false, message: 'Erro ao remover amigo. Tente novamente.' });
    }
  });

  socket.on('get-records', async (callback) => {
    try {
      const { data: records, error } = await supabase
        .from('usuarios')
        .select('username, vitorias, derrotas, matches')
        .order('vitorias', { ascending: false })
        .limit(50);

      if (error) {
        console.error('Erro ao buscar records no Supabase:', error);
        callback({ success: false, message: 'Não foi possível carregar records.' });
        return;
      }

      const formatted = (records || []).map((record) => ({
        username: record.username,
        wins: record.vitorias || 0,
        losses: record.derrotas || 0,
        matches: record.matches || 0,
        winrate: record.matches > 0 ? Number(((record.vitorias / record.matches) * 100).toFixed(2)) : 0,
      }));

      callback({ success: true, records: formatted });
    } catch (error) {
      console.error('get-records error:', error);
      callback({ success: false, message: 'Não foi possível carregar records.' });
    }
  });

  socket.on('create-room', (name, callback) => {
    const roomName = typeof name === 'string' && name.trim() ? name.trim().substring(0, 32) : null;
    let id = 1;
    while (rooms[`mesa-${id}`]) id += 1;
    const roomId = `mesa-${id}`;
    rooms[roomId] = createRoom(roomName || `Mesa ${id}`);

    // If the client provided a name string that appears to be a player name,
    // add the creator to the room immediately to avoid the room being
    // removed by closeEmptyRooms before the client can join.
    if (typeof name === 'string' && name.trim()) {
      const safeName = name.trim().substring(0, 16);
      const room = rooms[roomId];
      socket.data.room = roomId;
      socket.join(roomId);
      const playerName = socket.data.player?.username || safeName;
      room.players.push(buildRoomPlayerEntry(socket, playerName));
      room.hands[socket.id] = [];
      room.melds[socket.id] = [];
      room.playerHasDrawn[socket.id] = false;
      room.scores[socket.id] = room.scores[socket.id] || 0;
      room.hostId = room.hostId || socket.id;
    }

    console.log(`create-room: created ${roomId}. rooms keys: ${Object.keys(rooms).join(',')}`);
    callback({ success: true, roomId });
  });

  socket.on('create-bot-room', (name, botCount, callback) => {
    if (!name || typeof name !== 'string') {
      callback({ success: false, message: 'Nome inválido.' });
      return;
    }
    const safeName = name.trim().substring(0, 16);

    // Global token checks: se o token foi marcado como removido, recusar reconexão automática.
    const tokenInfoGlobal = findPlayerByToken(socket.data.playerToken);
    if (tokenInfoGlobal && tokenInfoGlobal.removed) {
      callback({ success: false, message: 'Reconexão expirou. Faça login novamente.' });
      return;
    }
    // Bloquear reuso do mesmo token em outra mesa ativa
    if (tokenInfoGlobal && tokenInfoGlobal.room && tokenInfoGlobal.room !== room) {
      callback({ success: false, message: 'Token já em uso em outra mesa.' });
      return;
    }
    let id = 1;
    while (rooms[`bot-room-${id}`]) id += 1;
    const roomId = `bot-room-${id}`;
    const room = createRoom(`Bot Room ${id}`, true);
    rooms[roomId] = room;
    socket.data.room = roomId;
    socket.join(roomId);
    const playerName = socket.data.player?.username || safeName;
    room.players.push(buildRoomPlayerEntry(socket, playerName));
    room.hands[socket.id] = [];
    room.melds[socket.id] = [];
    room.playerHasDrawn[socket.id] = false;
    room.scores[socket.id] = room.scores[socket.id] || 0;
    room.hostId = socket.id;

    const minBots = 1;
    const maxBots = Math.min(5, MAX_PLAYERS - 1);
    const requestedCount = Number(botCount);
    const safeBotCount = Number.isInteger(requestedCount)
      ? Math.min(maxBots, Math.max(minBots, requestedCount))
      : minBots;
    addBotPlayers(room, safeBotCount);
    startGame(room);
    callback({ success: true, roomId });
  });

  socket.on('join', (name, roomId, callback) => {
    console.log(`join: requested name=${name} roomId=${roomId} existing=${!!rooms[roomId]}`);
    if (!roomId || !rooms[roomId]) {
      callback({ success: false, message: 'Mesa não encontrada.' });
      return;
    }
    const room = getRoomById(roomId);
    if (!name || typeof name !== 'string') {
      callback({ success: false, message: 'Nome inválido.' });
      return;
    }
    const safeName = name.trim().substring(0, 16);

    const existingByToken = room.players.find((p) => p.token === socket.data.playerToken) || room.waitingPlayers.find((p) => p.token === socket.data.playerToken);
    if (existingByToken) {
      const oldId = existingByToken.id;
      existingByToken.id = socket.id;
      existingByToken.disconnected = false;
      socket.data.room = roomId;
      const wasWaiting = room.waitingPlayers.includes(existingByToken);
      if (wasWaiting) {
        socket.data.room = roomId;
        socket.join(roomId);
        socket.join(`${roomId}-waiting`);
        room.message = `${existingByToken.name} reconectou na sala de espera.`;
        io.to(roomId).emit('update-waiting-count', room.waitingPlayers.length);
        sendStateTo(socket.id);
        callback({ success: true });
        return;
      }
      socket.join(roomId);
      transferPlayerState(room, oldId, socket.id);
      if (room.hostId === oldId) room.hostId = socket.id;
      room.message = `${existingByToken.name} reconectou.`;
      broadcastState(room);
      callback({ success: true });
      return;
    }

    // reconexão por nome se o token não estiver presente
    const existingByName = room.players.find((p) => p.name === safeName) || room.waitingPlayers.find((p) => p.name === safeName);
    if (existingByName) {
      const oldId = existingByName.id;
      existingByName.id = socket.id;
      existingByName.disconnected = false;
      socket.data.room = roomId;
      const wasWaiting = room.waitingPlayers.includes(existingByName);
      if (wasWaiting) {
        socket.data.room = roomId;
        socket.join(roomId);
        socket.join(`${roomId}-waiting`);
        room.message = `${existingByName.name} reconectou na sala de espera.`;
        io.to(roomId).emit('update-waiting-count', room.waitingPlayers.length);
        sendStateTo(socket.id);
        callback({ success: true });
        return;
      }
      socket.join(roomId);
      transferPlayerState(room, oldId, socket.id);
      if (room.hostId === oldId) room.hostId = socket.id;
      room.message = `${safeName} reconectou.`;
      broadcastState(room);
      callback({ success: true });
      return;
    }

    if (room.started) {
      if (room.waitingPlayers.length >= MAX_PLAYERS) {
        callback({ success: false, message: 'Sala de espera cheia. Tente mais tarde.' });
        return;
      }
      const playerName = socket.data.player?.username || safeName;
      socket.data.room = roomId;
      room.waitingPlayers.push(buildRoomPlayerEntry(socket, playerName));
      socket.join(roomId);
      socket.join(`${roomId}-waiting`);
      sendStateTo(socket.id);
      callback({ success: true, message: `Você entrou na sala de espera. Posição: ${room.waitingPlayers.length}` });
      io.to(roomId).emit('update-waiting-count', room.waitingPlayers.length);
      return;
    }

    // novo jogador
    socket.data.room = roomId;
    socket.join(roomId);
    const playerName = socket.data.player?.username || safeName;
    room.players.push(buildRoomPlayerEntry(socket, playerName));
    room.hands[socket.id] = [];
    room.melds[socket.id] = [];
    room.playerHasDrawn[socket.id] = false;
    room.scores[socket.id] = room.scores[socket.id] || 0;

    if (!room.hostId) {
      room.hostId = socket.id;
    }

    room.message = `${playerName} entrou na mesa.`;
    broadcastState(room);
    callback({ success: true });

    if (room.players.length === MAX_PLAYERS) {
      room.message = 'Máximo de jogadores atingido. Iniciando o jogo...';
      startGame(room);
    }
  });

  socket.on('start-game', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.started) return;
    if (room.players.length < 2) {
      room.message = 'É preciso ao menos 2 jogadores para iniciar.';
      broadcastState(room);
      return;
    }
    startGame(room);
  });

  socket.on('draw-card', (source) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started || room.winner) return;
    
    // Validação de permissão
    const validation = gameLogic.validateActionPermission(room, socket.id, 'draw-card');
    if (!validation.allowed) {
      room.privateMessages[socket.id] = validation.reason;
      sendStateTo(socket.id);
      return;
    }

    if (room.playerHasDrawn[socket.id]) {
      room.privateMessages[socket.id] = 'Você já comprou neste turno.';
      sendStateTo(socket.id);
      return;
    }

    if (source === 'deck') {
      // Se o baralho está vazio, tenta reembaralhar o descarte
      if (room.deck.length === 0) {
        if (!reembaralharDescarte(room)) {
          // Se ainda não tem cartas suficientes, baralho realmente acabou
          room.privateMessages[socket.id] = 'Baralho acabou. Compre do descarte se quiser continuar.';
          sendStateTo(socket.id);
          return;
        }
        // Se conseguiu reembaralhar, continua normalmente
        room.message = `Baralho reembaralhado! ${room.players[room.currentTurn]?.name || 'Jogador'} comprou.`;
      }
      
      const carta = room.deck.pop();
      room.hands[socket.id].push(carta);
      room.playerHasDrawn[socket.id] = true;
      room.privateMessages[socket.id] = `Você comprou ${carta} do baralho.`;
      room.message = `Turno de ${room.players[room.currentTurn].name}`;
      broadcastState(room);
      return;
    }

    if (source === 'discard') {
      if (room.discard.length === 0) return;
      const carta = room.discard.pop();
      room.hands[socket.id].push(carta);
      room.playerHasDrawn[socket.id] = true;
      room.privateMessages[socket.id] = `Você comprou ${carta} do descarte.`;
      room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;
      broadcastState(room);
      return;
    }
  });

  socket.on('discard-card', (card) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started || room.winner) return;
    
    // Validação de permissão
    const validation = gameLogic.validateActionPermission(room, socket.id, 'discard-card');
    if (!validation.allowed) {
      room.message = validation.reason;
      broadcastState(room);
      return;
    }

    if (!room.playerHasDrawn[socket.id]) {
      room.message = 'Você precisa comprar uma carta antes de descartar.';
      broadcastState(room);
      return;
    }

    const hand = room.hands[socket.id];
    const index = hand.indexOf(card);
    if (index === -1) {
      room.message = 'Você não possui essa carta.';
      broadcastState(room);
      return;
    }

    hand.splice(index, 1);
    room.discard.push(card);
    room.playerHasDrawn[socket.id] = false;
    
    const nextIdx = nextPlayerIndex(room);
    const activeCount = gameLogic.countActivePlayers(room);

    if (nextIdx === -1) {
      // Nenhum próximo ativo encontrado
      if (activeCount === 1) {
        // Apenas o jogador atual está ativo - ele venceu
        room.winner = socket.id;
        setNextStartingPlayer(room, socket.id);
        recordWin(room, socket.id);
        persistMatchResults(room, socket.id);
        const winnerName = room.players.find(p => p.id === room.winner)?.name || 'Jogador';
        room.message = `🎉🎈 ${winnerName} venceu por eliminação! 🎈🎉`;
      } else if (activeCount === 0) {
        // Todos finalizados - impossível, mas proteção
        const firstActive = getFirstActiveIndex(room);
        room.currentTurn = firstActive === -1 ? 0 : firstActive;
        room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;
      }
    } else {
      room.currentTurn = nextIdx;
      room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;
    }

    room.privateMessages[socket.id] = `Você descartou ${card}.`;
    broadcastState(room);
  });

  socket.on('declare-meld', (cards) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started || room.winner) return;
    
    // Validação de permissão
    const validation = gameLogic.validateActionPermission(room, socket.id, 'declare-meld');
    if (!validation.allowed) {
      room.message = validation.reason;
      broadcastState(room);
      return;
    }

    if (!Array.isArray(cards) || cards.length < 3) {
      console.log(`declare-meld inválido: menos de 3 cartas - player=${socket.id} cards=${JSON.stringify(cards)}`);
      room.message = 'Selecione pelo menos 3 cartas para formar um conjunto.';
      broadcastState(room);
      return;
    }
    if (!validarMeld(cards)) {
      console.log(`declare-meld inválido: conjunto inválido - player=${socket.id} cards=${JSON.stringify(cards)}`);
      room.message = 'Conjunto inválido.';
      broadcastState(room);
      return;
    }

    const hand = room.hands[socket.id];
    const handCounts = {};
    hand.forEach((c) => { handCounts[c] = (handCounts[c] || 0) + 1; });

    for (const c of cards) {
      if (!handCounts[c]) {
        console.log(`declare-meld inválido: carta não na mão - player=${socket.id} carta=${c} mão=${JSON.stringify(hand)} cards=${JSON.stringify(cards)}`);
        room.message = 'Você não possui todas as cartas selecionadas.';
        broadcastState(room);
        return;
      }
      handCounts[c] -= 1;
    }

    for (const c of cards) {
      const idx = hand.indexOf(c);
      if (idx !== -1) hand.splice(idx, 1);
    }
    room.melds[socket.id].push(cards);
    room.privateMessages[socket.id] = 'Você formou um conjunto.';
    room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;
    broadcastState(room);
  });

  socket.on('return-meld-card', ({ meldIndex, card }) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started || room.winner) return;
    
    // Validação de permissão
    const validation = gameLogic.validateActionPermission(room, socket.id, 'return-meld-card');
    if (!validation.allowed) {
      room.message = validation.reason;
      broadcastState(room);
      return;
    }

    const melds = room.melds[socket.id] || [];
    
    if (!Number.isInteger(meldIndex) || meldIndex < 0 || meldIndex >= melds.length) {
      room.message = 'Conjunto inválido.';
      broadcastState(room);
      return;
    }

    if (!Array.isArray(melds[meldIndex]) || melds[meldIndex].length <= 3) {
      room.message = 'Somente conjuntos com mais de 3 cartas podem devolver uma carta.';
      broadcastState(room);
      return;
    }

    const meld = melds[meldIndex];
    const cardIdx = meld.indexOf(card);
    if (cardIdx === -1) {
      room.message = 'Carta não encontrada no conjunto.';
      broadcastState(room);
      return;
    }

    const remainingMeld = meld.filter((_, idx) => idx !== cardIdx);
    if (!validarMeld(remainingMeld)) {
      room.message = 'Não é possível devolver essa carta sem quebrar o conjunto.';
      broadcastState(room);
      return;
    }

    meld.splice(cardIdx, 1);
    room.hands[socket.id].push(card);
    room.privateMessages[socket.id] = `Você devolveu ${card} para a mão.`;
    room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;
    broadcastState(room);
  });

  socket.on('return-meld-all', ({ meldIndex }) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started || room.winner) return;

    const validation = gameLogic.validateActionPermission(room, socket.id, 'return-meld-card');
    if (!validation.allowed) {
      room.message = validation.reason;
      broadcastState(room);
      return;
    }

    const melds = room.melds[socket.id] || [];
    if (!Number.isInteger(meldIndex) || meldIndex < 0 || meldIndex >= melds.length) {
      room.message = 'Conjunto inválido.';
      broadcastState(room);
      return;
    }

    const meld = melds[meldIndex];
    if (!Array.isArray(meld) || meld.length < 3) {
      room.message = 'Somente conjuntos com 3 ou mais cartas podem devolver todas as cartas.';
      broadcastState(room);
      return;
    }

    room.hands[socket.id].push(...meld);
    room.melds[socket.id].splice(meldIndex, 1);
    room.privateMessages[socket.id] = 'Você devolveu todas as cartas do conjunto para a mão.';
    room.message = `Turno de ${room.players[room.currentTurn]?.name || 'Jogador'}`;
    broadcastState(room);
  });

  socket.on('bat', () => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started || room.winner) return;
    
    // Validação de permissão
    const validation = gameLogic.validateActionPermission(room, socket.id, 'bat');
    if (!validation.allowed) {
      room.message = validation.reason;
      broadcastState(room);
      return;
    }

    const canBatCombined = canBatWithHandAndMelds(room, socket.id);
    
    // Pode bater se: consegue fazer 9+ cartas em melds (mão + declarados)
    if (!canBatCombined && !room.playerHasDrawn[socket.id]) {
      room.message = 'Você precisa ter 3 trincas (9+ cartas) em melds para bater, ou comprar uma carta.';
      broadcastState(room);
      return;
    }

    const hand = room.hands[socket.id];
    const resultado = verificarBater(hand);

    if (canBatCombined || resultado.success) {
      if (resultado.success) {
        room.melds[socket.id] = resultado.melds;
      }

      // Marcar como finalizado
      const finishResult = gameLogic.markPlayerFinished(room, socket.id);
      
      const resultWinnerId = finishResult.gameEnded ? finishResult.winner : socket.id;

      if (finishResult.gameEnded) {
        // Jogo terminou - registrar estatísticas imediatamente
        room.winner = finishResult.winner;
        setNextStartingPlayer(room, finishResult.winner);
        recordWin(room, room.winner);
        room.message = `🎉🎈 ${finishResult.winnerName} bateu e venceu! 🎈🎉`;
      } else {
        // Jogador bateu mas a partida continua; ainda assim registramos o resultado do bate.
        const activeCount = gameLogic.countActivePlayers(room);
        const winnerName = room.players.find(p => p.id === socket.id)?.name || 'Jogador';

        if (activeCount > 1) {
          recordWin(room, socket.id);
          room.message = `🎉🎈 ${winnerName} bateu e venceu a rodada! 🎈🎉`;
          const nextIdx = nextPlayerIndex(room);
          if (nextIdx !== -1) {
            room.currentTurn = nextIdx;
          } else {
            // Fallback: retorna para primeiro ativo
            const firstActive = getFirstActiveIndex(room);
            room.currentTurn = firstActive === -1 ? 0 : firstActive;
          }
        }
      }

      persistMatchResults(room, resultWinnerId);

      broadcastState(room);
    } else {
      room.message = 'Ainda não é possível bater.';
      broadcastState(room);
    }
  });

  socket.on('chat-message', (payload, callback) => {
    const room = getRoomBySocket(socket);
    if (!room) {
      if (callback) callback({ success: false, message: 'Não está em nenhuma sala.' });
      return;
    }

    const text = String(payload?.text || '').trim();
    const MAX_CHAT_LENGTH = 200;
    if (!text) {
      if (callback) callback({ success: false, message: 'Mensagem vazia.' });
      return;
    }
    if (text.length > MAX_CHAT_LENGTH) {
      if (callback) callback({ success: false, message: `A mensagem deve ter no máximo ${MAX_CHAT_LENGTH} caracteres.` });
      return;
    }

    const senderName = socket.data.player?.username || room.players.find((p) => p.id === socket.id)?.name || 'Jogador';
    const senderId = socket.id;
    const createdAt = new Date().toISOString();
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chatEntry = {
      id: messageId,
      username: senderName,
      text,
      time: createdAt,
      senderId,
    };

    room.chatHistory = room.chatHistory || [];
    room.chatHistory.push(chatEntry);
    if (room.chatHistory.length > 100) {
      room.chatHistory.shift();
    }

    io.to(socket.data.room).emit('chat-message', chatEntry);

    if (callback) callback({ success: true });
  });

  socket.on('get-private-chat-history', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    if (!socket.data.player?.id) {
      callback({ success: false, message: 'Faça login para abrir o chat privado.' });
      return;
    }

    const friendId = Number(payload?.friendId);
    if (!friendId) {
      callback({ success: false, message: 'ID de amigo inválido.' });
      return;
    }

    try {
      if (!(await areFriends(socket.data.player.id, friendId))) {
        callback({ success: false, message: 'Somente amigos podem conversar em privado.' });
        return;
      }

      // Histórico agora é mantido apenas no cliente (localStorage)
      callback({ success: true, history: [] });
    } catch (error) {
      console.error('get-private-chat-history error:', error);
      callback({ success: false, message: 'Erro ao carregar histórico de chat privado.' });
    }
  });

  socket.on('send-private-message', async (payload, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    if (!socket.data.player?.id) {
      callback({ success: false, message: 'Faça login para enviar mensagem privada.' });
      return;
    }

    const friendId = Number(payload?.friendId);
    const text = String(payload?.text || '').trim();
    const MAX_PRIVATE_CHAT_LENGTH = 200;

    if (!friendId || !text) {
      callback({ success: false, message: 'Informe o amigo e a mensagem.' });
      return;
    }
    if (text.length > MAX_PRIVATE_CHAT_LENGTH) {
      callback({ success: false, message: `A mensagem deve ter no máximo ${MAX_PRIVATE_CHAT_LENGTH} caracteres.` });
      return;
    }

    try {
      if (!(await areFriends(socket.data.player.id, friendId))) {
        callback({ success: false, message: 'Somente amigos podem conversar em privado.' });
        return;
      }

      const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const chatEntry = {
        id: messageId,
        senderId: socket.data.player.id,
        recipientId: friendId,
        username: socket.data.player.username,
        text,
        time: createdAt,
      };

      // Servidor apenas transmite em tempo real, sem armazenar em memória
      const recipientSockets = getPlayerSockets(friendId);
      recipientSockets.forEach((recipientSocket) => {
        recipientSocket.emit('private-chat-message', chatEntry);
      });

      if (callback) callback({ success: true, message: 'Mensagem enviada.' });
    } catch (error) {
      console.error('send-private-message error:', error);
      callback({ success: false, message: 'Erro ao enviar mensagem privada.' });
    }
  });

  socket.on('edit-room-name', (name, callback) => {
    const room = getRoomBySocket(socket);
    if (!room) {
      if (callback) callback({ success: false, message: 'Não está em nenhuma sala.' });
      return;
    }
    if (room.hostId !== socket.id) {
      if (callback) callback({ success: false, message: 'Apenas o host pode alterar o nome da sala.' });
      return;
    }
    const nick = typeof name === 'string' ? name.trim().substring(0, 32) : '';
    if (!nick) {
      if (callback) callback({ success: false, message: 'Nome da mesa inválido.' });
      return;
    }
    room.name = nick;
    broadcastState(room);
    if (callback) callback({ success: true, roomName: room.name });
  });

  socket.on('request-state', () => {
    sendStateTo(socket.id);
  });

  socket.on('end-game-confirm', (confirmed) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.started) return;
    
    // Validar que jogador ainda está ativo
    if (room.finishedPlayers.includes(socket.id)) {
      room.privateMessages[socket.id] = 'Você já finalizou esta partida.';
      sendStateTo(socket.id);
      return;
    }

    // Registrar confirmação
    const result = gameLogic.recordEndGameConfirmation(room, socket.id, confirmed);
    const { activeCount } = gameLogic.canOfferEndGame(room);
    
    if (confirmed) {
      room.privateMessages[socket.id] = 'Você confirmou encerramento da partida.';
    } else {
      room.privateMessages[socket.id] = 'Você deseja continuar jogando.';
    }

    // Se todos confirmam, encerrar jogo
    if (result.shouldEnd) {
      if (activeCount === 1) {
        room.message = 'Partida encerrada. Não houve vencedor.';
        room.winner = null;
        room.started = false;
        room.endGameConfirmations = {};
      } else {
        room.winner = room.players.find(p => !room.finishedPlayers.includes(p.id))?.id || null;
        if (room.winner) {
          setNextStartingPlayer(room, room.winner);
          recordWin(room, room.winner);
          persistMatchResults(room, room.winner);
          const winnerName = room.players.find(p => p.id === room.winner)?.name || 'Jogador';
          room.message = `🎉🎈 ${winnerName} venceu por votação! 🎈🎉`;
        }
      }
    } else if (result.reason === 'Alguém deseja continuar jogando') {
      // Se alguém nega, continuar o jogo
      room.message = 'Partida continua! Alguns jogadores desejam continuar.';
    }

    broadcastState(room);
  });

  socket.on('leave-room', (callback) => {
    const room = getRoomBySocket(socket);
    if (!room) {
      if (callback) callback({ success: false });
      return;
    }
    const removed = removePlayerFromRoom(room, socket);
    socket.data.room = null;
    if (callback) callback({ success: removed });
  });

  socket.on('reset-room', () => {
    const room = getRoomBySocket(socket);
    if (!room) {
      console.log('Reset request: room not found for socket', socket.id);
      return;
    }
    const roomId = socket.data.room;
    console.log(`Reset request from ${socket.id} in room ${roomId}:`, {
      roomExists: !!room,
      roomName: room.name,
      hasWinner: !!room.winner,
      finishedCount: room.finishedPlayers.length,
      isResetting: room.resetting,
      started: room.started
    });

    // Validação de reset
    const resetValidation = gameLogic.validateReset(room, socket.id);
    if (!resetValidation.allowed) {
      console.log(`Reset blocked: ${resetValidation.reason}`);
      room.privateMessages[socket.id] = resetValidation.reason;
      sendStateTo(socket.id);
      return;
    }

    // Apenas host, vencedor ou jogadores finalizados podem resetar
    const isHost = socket.id === room.hostId;
    const isWinner = room.winner === socket.id;
    const isFinished = room.finishedPlayers.includes(socket.id);
    
    console.log(`Reset permission check: isHost=${isHost}, isWinner=${isWinner}, isFinished=${isFinished}`);
    
    if (!isHost && !isWinner && !isFinished) {
      console.log('Reset blocked: player not authorized');
      room.privateMessages[socket.id] = 'Apenas o host, vencedor ou jogadores que terminaram podem reiniciar.';
      sendStateTo(socket.id);
      return;
    }

    console.log('Reset proceeding...');
    // Proteger contra reset concorrente
    room.resetting = true;
    try {
      room.started = false;
      room.winner = null;
      // Preservar informações do último vencedor durante reinício
      // room.lastWinnerId permanece inalterado
      // room.lastWinnerPlayerId permanece inalterado
      // room.lastWinnerUsername permanece inalterado
      processWaitingPlayers(io, room, roomId);
      room.deck = [];
      room.discard = [];
      room.currentTurn = 0;
      room.finishedPlayers = [];
      room.endGameConfirmations = {};
      room.nextStartingPlayerId = null;

      room.players.forEach((p) => {
        room.hands[p.id] = [];
        room.melds[p.id] = [];
        room.playerHasDrawn[p.id] = false;
      });

      room.message = 'Aguardando jogadores...';
      console.log('Room reset completed');
      broadcastState(room);
    } finally {
      room.resetting = false;
    }
  });

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket);
    if (!room) return;

    const playerIndex = getPlayerIndex(room, socket.id);
    if (playerIndex === -1) return;

    const player = room.players[playerIndex];
    player.disconnected = true;
    const tokenKey = player.token || socket.id;
    if (room.pendingDisconnects[tokenKey]) {
      clearTimeout(room.pendingDisconnects[tokenKey].timer);
    }
    room.pendingDisconnects[tokenKey] = {
      oldId: socket.id,
      token: player.token,
      timer: setTimeout(() => cleanupDisconnectedPlayer(room, socket.id), 60000)
    };

    // Não avançar o turno aqui — manter estado temporário para permitir reconexão
    // A limpeza e eventual avanço de turno ocorre em cleanupDisconnectedPlayer
    room.message = `${player.name} desconectou. A partida continua enquanto ele tenta reconectar.`;
    broadcastState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor iniciado em http://localhost:${PORT}`);
});
