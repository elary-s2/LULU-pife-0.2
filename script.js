const PLAYER_TOKEN_KEY = 'lulu_player_token';
const LAST_ROOM_KEY = 'lulu_last_room';
const LAST_NAME_KEY = 'lulu_player_name';
const PLAYER_DATA_KEY = 'lulu_player_data';
const OFFLINE_GAME_STATE_KEY = 'lulu_offline_game_state';
const OFFLINE_MODE_ENABLED_KEY = 'lulu_offline_mode_enabled';
const OFFLINE_ROOM_ID = 'offline-bot-room';
window.player = null;
window.isLoggedIn = false;
window.isGuest = false;
window.isOfflineMode = false;
window.currentRoom = null;
let hasAttemptedAutoReconnect = false;

function getOrCreatePlayerToken() {
  let token = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (token) return token;
  token = `player-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  localStorage.setItem(PLAYER_TOKEN_KEY, token);
  return token;
}

const playerToken = getOrCreatePlayerToken();

function createOfflineSocket() {
  const handlers = {};
  return {
    connected: false,
    on(event, callback) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(callback);
      return this;
    },
    emit(event, ...args) {
      const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      if (event === 'list-rooms') {
        if (callback) callback([]);
        return;
      }
      if (event === 'request-state') {
        if (callback) callback(null);
        return;
      }
      if (event === 'validate-session') {
        if (callback) callback(false);
        return;
      }
      if (callback) callback({ success: false, message: 'Offline mode não suporta servidor.' });
    }
  };
}

const preferOffline = localStorage.getItem(OFFLINE_MODE_ENABLED_KEY) === '1';
const canUseSocketIO = !preferOffline && typeof io === 'function' && navigator.onLine;
const socket = canUseSocketIO ? io({ auth: { playerToken } }) : createOfflineSocket();
let sessionRestoredFromStorage = false;

const socketEventHandlers = {};
const originalSocketOn = typeof socket.on === 'function' ? socket.on.bind(socket) : null;
socket.on = function(event, callback) {
  if (!socketEventHandlers[event]) {
    socketEventHandlers[event] = [];
  }
  socketEventHandlers[event].push(callback);
  if (originalSocketOn) {
    return originalSocketOn(event, callback);
  }
  return this;
};

function triggerSocketEvent(event, ...args) {
  const handlers = socketEventHandlers[event];
  if (!Array.isArray(handlers)) return;
  handlers.forEach((callback) => {
    try {
      callback(...args);
    } catch (error) {
      console.error(`Erro no handler de evento '${event}':`, error);
    }
  });
}

function saveOfflineMode(enabled) {
  localStorage.setItem(OFFLINE_MODE_ENABLED_KEY, enabled ? '1' : '0');
  window.isOfflineMode = enabled;
}

function loadOfflineMode() {
  return localStorage.getItem(OFFLINE_MODE_ENABLED_KEY) === '1';
}

function saveOfflineGameState() {
  if (!offlineGame) return;
  const clone = JSON.parse(JSON.stringify({ ...offlineGame, botTimer: null }));
  localStorage.setItem(OFFLINE_GAME_STATE_KEY, JSON.stringify(clone));
}

function loadOfflineGameState() {
  const raw = localStorage.getItem(OFFLINE_GAME_STATE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      data.botTimer = null;
      return data;
    }
  } catch (error) {
    console.warn('Falha ao carregar estado offline:', error);
  }
  return null;
}

function clearOfflineGameState() {
  localStorage.removeItem(OFFLINE_GAME_STATE_KEY);
}

function sendAction(event, ...args) {
  const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
  if (window.isGuest) {
    handleOfflineAction(event, args, callback);
    return;
  }
  if (socket && typeof socket.emit === 'function') {
    if (callback) {
      socket.emit(event, ...args, callback);
    } else {
      socket.emit(event, ...args);
    }
  }
}

let offlineGame = null;
const OFFLINE_PLAYER_ID = 'offline-player';
const OFFLINE_BOT_ID_PREFIX = 'offline-bot-';

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function createOfflineDeck(numPlayers = 2) {
  const suits = ['♣', '♦', '♥', '♠'];
  const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  let decksNeeded = 1;
  if (numPlayers >= 9) decksNeeded = 3;
  else if (numPlayers >= 6) decksNeeded = 2;

  for (let d = 0; d < decksNeeded; d += 1) {
    suits.forEach((suit) => {
      values.forEach((value) => {
        deck.push(`${value}${suit}`);
      });
    });
  }
  shuffleArray(deck);
  return deck;
}

function getOfflinePlayerIdByIndex(index) {
  return index === 0 ? OFFLINE_PLAYER_ID : `${OFFLINE_BOT_ID_PREFIX}${index}`;
}

function getOfflineCurrentPlayerId(game) {
  return game.playerOrder[game.currentTurn];
}

function getOfflineNextActivePlayerIndex(game, startIndex = game.currentTurn + 1) {
  const total = game.playerOrder.length;
  for (let i = 0; i < total; i += 1) {
    const nextIndex = (startIndex + i) % total;
    const nextId = game.playerOrder[nextIndex];
    if (!game.finishedPlayers.includes(nextId)) {
      return nextIndex;
    }
  }
  return -1;
}

function getOfflinePlayerMeldCards(game, playerId) {
  return (game.melds[playerId] || []).flat();
}

function getOfflineActivePlayerCount(game) {
  return game.playerOrder.filter((id) => !game.finishedPlayers.includes(id)).length;
}

function buildOfflineState(game) {
  const players = game.playerOrder.map((id, index) => ({
    id,
    name: game.names[id],
    finished: game.finishedPlayers.includes(id),
    offline: id !== OFFLINE_PLAYER_ID,
    handCount: (game.hands[id] || []).length,
    melds: game.melds[id] || [],
    publicHand: game.winner || game.finishedPlayers.includes(id) ? (game.hands[id] || []) : null,
    seat: index,
    score: game.scores[id] || 0,
  }));

  return {
    roomName: game.roomName,
    players,
    currentTurn: game.currentTurn,
    currentTurnPlayerId: getOfflineCurrentPlayerId(game),
    currentPlayerHasDrawn: Boolean(game.playerHasDrawn[getOfflineCurrentPlayerId(game)]),
    deckCount: game.deck.length,
    discardTop: game.discard[game.discard.length - 1] || null,
    started: game.started,
    winner: game.winner,
    finishedPlayers: [...game.finishedPlayers],
    activePlayersCount: getOfflineActivePlayerCount(game),
    canOfferEndGame: false,
    activeCount: getOfflineActivePlayerCount(game),
    hostId: OFFLINE_PLAYER_ID,
    message: game.message,
    isBotRoom: true,
    maxPlayers: 10,
    chatHistory: [],
    isWaiting: false,
    myId: OFFLINE_PLAYER_ID,
    myHand: [...(game.hands[OFFLINE_PLAYER_ID] || [])],
  };
}



function broadcastOfflineState() {
  if (!offlineGame) return;
  triggerSocketEvent('state', buildOfflineState(offlineGame));
  saveOfflineGameState();
}

function clearOfflineBotTimer() {
  if (!offlineGame || !offlineGame.botTimer) return;
  clearTimeout(offlineGame.botTimer);
  offlineGame.botTimer = null;
}

function scheduleOfflineBotTurn() {
  if (!offlineGame || !offlineGame.started || offlineGame.winner) return;
  const currentPlayerId = getOfflineCurrentPlayerId(offlineGame);
  if (!currentPlayerId || currentPlayerId === OFFLINE_PLAYER_ID) return;
  clearOfflineBotTimer();
  offlineGame.botTimer = setTimeout(() => {
    offlineGame.botTimer = null;
    performOfflineBotTurn();
  }, Math.floor(Math.random() * 1200) + 800);
}

function canBatWithHandAndMelds(game, playerId) {
  const hand = game.hands[playerId] || [];
  const meldCards = getOfflinePlayerMeldCards(game, playerId);
  if (meldCards.length >= 9) {
    return true;
  }
  return verificarBaterClient(hand);
}

function markOfflinePlayerFinished(playerId) {
  if (!offlineGame || offlineGame.winner) return { gameEnded: false };
  if (offlineGame.finishedPlayers.includes(playerId)) return { gameEnded: false };
  offlineGame.finishedPlayers.push(playerId);
  offlineGame.winner = playerId;
  offlineGame.nextStartingPlayerId = playerId;
  return {
    gameEnded: true,
    winner: playerId,
    winnerName: offlineGame.names[playerId],
  };
}

function addOfflineBots(game, botCount) {
  for (let i = 1; i <= botCount; i += 1) {
    const botId = getOfflinePlayerIdByIndex(i);
    game.playerOrder.push(botId);
    game.names[botId] = `Lulu-bot ${i}`;
    game.hands[botId] = [];
    game.melds[botId] = [];
    game.playerHasDrawn[botId] = false;
    game.scores[botId] = 0;
  }
}

function createOfflineGame(playerName, botCount) {
  const safeName = (playerName || 'Convidado').trim().substring(0, 16) || 'Convidado';
  const game = {
    roomName: 'Partida Offline',
    playerOrder: [OFFLINE_PLAYER_ID],
    names: { [OFFLINE_PLAYER_ID]: safeName },
    hands: { [OFFLINE_PLAYER_ID]: [] },
    melds: { [OFFLINE_PLAYER_ID]: [] },
    playerHasDrawn: { [OFFLINE_PLAYER_ID]: false },
    scores: { [OFFLINE_PLAYER_ID]: 0 },
    deck: [],
    discard: [],
    currentTurn: 0,
    started: false,
    winner: null,
    nextStartingPlayerId: null,
    finishedPlayers: [],
    message: '',
    botTimer: null,
  };

  const safeBotCount = Number.isInteger(botCount) ? Math.min(5, Math.max(1, botCount)) : 1;
  addOfflineBots(game, safeBotCount);
  game.deck = createOfflineDeck(game.playerOrder.length);

  for (let i = 0; i < 9; i += 1) {
    game.playerOrder.forEach((playerId) => {
      const card = game.deck.pop();
      game.hands[playerId].push(card);
    });
  }

  game.discard.push(game.deck.pop());
  game.started = true;
  game.currentTurn = 0;
  game.message = `Turno de ${game.names[getOfflineCurrentPlayerId(game)]}`;
  return game;
}

function reshuffleOfflineDiscard() {
  if (!offlineGame || offlineGame.discard.length < 2) return false;
  const keep = offlineGame.discard.pop();
  offlineGame.deck.push(...offlineGame.discard.splice(0));
  shuffleArray(offlineGame.deck);
  offlineGame.discard.push(keep);
  return true;
}

function isOfflineBotId(playerId) {
  return playerId && playerId.startsWith(OFFLINE_BOT_ID_PREFIX);
}

function isCardUsefulForMeldsOffline(hand, card) {
  if (!Array.isArray(hand)) return false;
  const tempHand = [...hand, card];
  const byValue = {};
  tempHand.forEach((c) => {
    const parsed = parseCartaClient(c);
    byValue[parsed.valor] = byValue[parsed.valor] || [];
    byValue[parsed.valor].push(c);
  });
  if (Object.values(byValue).some((group) => group.length >= 3)) return true;

  const bySuit = {};
  tempHand.forEach((c) => {
    const parsed = parseCartaClient(c);
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
    const parsed = parseCartaClient(c);
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
    const parsed = parseCartaClient(c);
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
        if (run.length >= 3) melds.push(run.map((item) => item.card));
        run = [sorted[i]];
      }
    }
    if (run.length >= 3) melds.push(run.map((item) => item.card));
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

function chooseOfflineDiscardCard(hand) {
  const potential = new Set();
  const melds = findValidMeldsForHand(hand);
  melds.forEach((meld) => meld.forEach((c) => potential.add(c)));
  const candidates = hand.filter((c) => !potential.has(c));
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return hand[Math.floor(Math.random() * hand.length)];
}

function performOfflineBotTurn() {
  if (!offlineGame || !offlineGame.started || offlineGame.winner) return;
  const currentId = getOfflineCurrentPlayerId(offlineGame);
  if (!currentId || !isOfflineBotId(currentId)) return;
  const hand = offlineGame.hands[currentId];
  if (!hand) return;

  const discardTop = offlineGame.discard[offlineGame.discard.length - 1];
  if (!offlineGame.playerHasDrawn[currentId]) {
    if (discardTop && isCardUsefulForMeldsOffline(hand, discardTop)) {
      offlineGame.discard.pop();
      hand.push(discardTop);
      offlineGame.playerHasDrawn[currentId] = true;
      offlineGame.message = `${offlineGame.names[currentId]} comprou do descarte.`;
    } else {
      if (offlineGame.deck.length === 0) {
        reshuffleOfflineDiscard();
      }
      if (offlineGame.deck.length > 0) {
        hand.push(offlineGame.deck.pop());
        offlineGame.playerHasDrawn[currentId] = true;
        offlineGame.message = `${offlineGame.names[currentId]} comprou do baralho.`;
      }
    }
  }

  const melds = findValidMeldsForHand(hand);
  if (melds.length > 0) {
    melds.forEach((meld) => {
      if (meld.every((c) => hand.includes(c))) {
        meld.forEach((c) => {
          const index = hand.indexOf(c);
          if (index !== -1) hand.splice(index, 1);
        });
        offlineGame.melds[currentId].push(meld);
      }
    });
    offlineGame.message = `${offlineGame.names[currentId]} declarou conjunto(s).`;
  }

  if (canBatWithHandAndMelds(offlineGame, currentId)) {
    const finishResult = markOfflinePlayerFinished(currentId);
    if (finishResult.gameEnded) {
      offlineGame.message = `🎉🎈 ${finishResult.winnerName} venceu! 🎈🎉`;
      offlineGame.currentTurn = offlineGame.playerOrder.findIndex((id) => id === currentId);
      clearOfflineBotTimer();
      broadcastOfflineState();
      return;
    }
  }

  if (offlineGame.playerHasDrawn[currentId]) {
    const cardToDiscard = chooseOfflineDiscardCard(hand);
    const index = hand.indexOf(cardToDiscard);
    if (index !== -1) {
      hand.splice(index, 1);
      offlineGame.discard.push(cardToDiscard);
    }
    offlineGame.playerHasDrawn[currentId] = false;
    offlineGame.currentTurn = getOfflineNextActivePlayerIndex(offlineGame, offlineGame.currentTurn + 1);
    offlineGame.message = `${offlineGame.names[currentId]} descartou ${cardToDiscard}.`;
    broadcastOfflineState();
    scheduleOfflineBotTurn();
    return;
  }

  broadcastOfflineState();
  scheduleOfflineBotTurn();
}

function handleOfflineRoomAction(action, args, callback) {
  if (action === 'create-bot-room') {
    const name = String(args[0] || '').trim();
    const botCount = Number(args[1]) || 1;
    if (!name) {
      if (callback) callback({ success: false, message: 'Nome inválido.' });
      return;
    }
    offlineGame = createOfflineGame(name, botCount);
    meuNome = name;
    localStatusMessage = '';
    saveOfflineMode(true);
    habilitaArea();
    broadcastOfflineState();
    scheduleOfflineBotTurn();
    if (callback) callback({ success: true, roomId: OFFLINE_ROOM_ID });
    return;
  }

  if (!offlineGame) {
    if (callback) callback({ success: false, message: 'Nenhuma partida offline ativa.' });
    return;
  }

  switch (action) {
    case 'draw-card': {
      const source = args[0];
      const currentId = getOfflineCurrentPlayerId(offlineGame);
      if (currentId !== OFFLINE_PLAYER_ID) {
        if (callback) callback({ success: false, message: 'Ainda não é sua vez.' });
        return;
      }
      if (offlineGame.playerHasDrawn[currentId]) {
        if (callback) callback({ success: false, message: 'Você já comprou uma carta.' });
        return;
      }
      if (source === 'discard') {
        const top = offlineGame.discard.pop();
        if (!top) {
          if (callback) callback({ success: false, message: 'Descarte vazio.' });
          return;
        }
        offlineGame.hands[currentId].push(top);
        offlineGame.playerHasDrawn[currentId] = true;
        offlineGame.message = 'Você comprou do descarte.';
      } else {
        if (offlineGame.deck.length === 0) {
          reshuffleOfflineDiscard();
        }
        if (offlineGame.deck.length === 0) {
          if (callback) callback({ success: false, message: 'Baralho vazio.' });
          return;
        }
        offlineGame.hands[currentId].push(offlineGame.deck.pop());
        offlineGame.playerHasDrawn[currentId] = true;
        offlineGame.message = 'Você comprou do baralho.';
      }
      broadcastOfflineState();
      if (callback) callback({ success: true });
      return;
    }
    case 'discard-card': {
      const card = args[0];
      const currentId = getOfflineCurrentPlayerId(offlineGame);
      if (currentId !== OFFLINE_PLAYER_ID) {
        if (callback) callback({ success: false, message: 'Ainda não é sua vez.' });
        return;
      }
      if (!offlineGame.playerHasDrawn[currentId]) {
        if (callback) callback({ success: false, message: 'Você precisa comprar primeiro.' });
        return;
      }
      const hand = offlineGame.hands[currentId];
      const index = hand.indexOf(card);
      if (index === -1) {
        if (callback) callback({ success: false, message: 'Carta não encontrada.' });
        return;
      }
      hand.splice(index, 1);
      offlineGame.discard.push(card);
      offlineGame.playerHasDrawn[currentId] = false;
      offlineGame.currentTurn = getOfflineNextActivePlayerIndex(offlineGame, offlineGame.currentTurn + 1);
      offlineGame.message = 'Você descartou uma carta.';
      broadcastOfflineState();
      scheduleOfflineBotTurn();
      if (callback) callback({ success: true });
      return;
    }
    case 'bat': {
      const currentId = getOfflineCurrentPlayerId(offlineGame);
      if (currentId !== OFFLINE_PLAYER_ID) {
        if (callback) callback({ success: false, message: 'Ainda não é sua vez.' });
        return;
      }
      if (!canBatWithHandAndMelds(offlineGame, currentId)) {
        if (callback) callback({ success: false, message: 'Ainda não é possível bater.' });
        return;
      }
      const finishResult = markOfflinePlayerFinished(currentId);
      if (finishResult.gameEnded) {
        offlineGame.message = `🎉🎈 ${finishResult.winnerName} venceu! 🎈🎉`;
        clearOfflineBotTimer();
        broadcastOfflineState();
        if (callback) callback({ success: true });
        return;
      }
      if (callback) callback({ success: true });
      return;
    }
    case 'declare-meld': {
      const cards = args[0];
      if (!Array.isArray(cards) || cards.length < 3) {
        if (callback) callback({ success: false, message: 'Conjunto inválido.' });
        return;
      }
      if (!validarMeldClient(cards)) {
        if (callback) callback({ success: false, message: 'Conjunto inválido.' });
        return;
      }
      const currentId = getOfflineCurrentPlayerId(offlineGame);
      if (currentId !== OFFLINE_PLAYER_ID) {
        if (callback) callback({ success: false, message: 'Ainda não é sua vez.' });
        return;
      }
      const hand = offlineGame.hands[currentId];
      const missingCard = cards.some((card) => hand.indexOf(card) === -1);
      if (missingCard) {
        if (callback) callback({ success: false, message: 'Carta não encontrada na mão.' });
        return;
      }
      cards.forEach((card) => {
        const index = hand.indexOf(card);
        if (index !== -1) hand.splice(index, 1);
      });
      offlineGame.melds[currentId].push(cards.slice());
      offlineGame.message = 'Você declarou um conjunto.';
      broadcastOfflineState();
      if (callback) callback({ success: true });
      return;
    }
    case 'return-meld-card': {
      const meldIndex = args[0]?.meldIndex;
      const card = args[0]?.card;
      const currentId = getOfflineCurrentPlayerId(offlineGame);
      if (currentId !== OFFLINE_PLAYER_ID) {
        if (callback) callback({ success: false, message: 'Ainda não é sua vez.' });
        return;
      }
      const meld = offlineGame.melds[currentId][meldIndex];
      if (!Array.isArray(meld) || meld.length < 1) {
        if (callback) callback({ success: false, message: 'Conjunto inválido.' });
        return;
      }
      const cardIndex = meld.indexOf(card);
      if (cardIndex === -1) {
        if (callback) callback({ success: false, message: 'Carta não encontrada no conjunto.' });
        return;
      }
      meld.splice(cardIndex, 1);
      offlineGame.hands[currentId].push(card);
      offlineGame.message = 'Você retornou uma carta do conjunto para a mão.';
      broadcastOfflineState();
      if (callback) callback({ success: true });
      return;
    }
    case 'return-meld-all': {
      const meldIndex = args[0]?.meldIndex;
      const currentId = getOfflineCurrentPlayerId(offlineGame);
      if (currentId !== OFFLINE_PLAYER_ID) {
        if (callback) callback({ success: false, message: 'Ainda não é sua vez.' });
        return;
      }
      const meld = offlineGame.melds[currentId][meldIndex];
      if (!Array.isArray(meld) || meld.length < 3) {
        if (callback) callback({ success: false, message: 'Conjunto inválido.' });
        return;
      }
      offlineGame.hands[currentId].push(...meld);
      offlineGame.melds[currentId].splice(meldIndex, 1);
      offlineGame.message = 'Você devolveu todas as cartas do conjunto para a mão.';
      broadcastOfflineState();
      if (callback) callback({ success: true });
      return;
    }
    case 'reset-room':
    case 'leave-room': {
      offlineGame = null;
      clearOfflineBotTimer();
      desabilitaArea();
      clearOfflineGameState();
      joinMessage.textContent = action === 'leave-room' ? 'Você saiu da partida offline.' : 'Partida offline reiniciada.';
      if (action === 'leave-room') {
        clearReconnectInfo();
      }
      if (callback) callback({ success: true });
      return;
    }
    default:
      if (callback) callback({ success: false, message: 'Ação offline desconhecida.' });
  }
}

function handleOfflineAction(event, args, callback) {
  handleOfflineRoomAction(event, args, callback);
}
  window.addEventListener('load', async () => {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      registrations.forEach((registration) => {
        registration.unregister();
      });
    } catch (error) {
      console.warn('Falha ao limpar service workers antigos:', error);
    }

    const offlineModeEnabled = loadOfflineMode();
    if (offlineModeEnabled) {
      setGuestMode(true);
      hideAuth();
      showLobbyTab();
      offlineGame = loadOfflineGameState();
      if (offlineGame) {
        broadcastOfflineState();
        if (!offlineGame.winner) {
          scheduleOfflineBotTurn();
        }
      }
    }

    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        console.log('Service Worker registrado com sucesso:', registration.scope);
      })
      .catch((error) => {
        console.warn('Falha ao registrar Service Worker:', error);
      });
  });

const joinArea = document.getElementById('joinArea');
const authArea = document.getElementById('authArea');
const authUsernameInput = document.getElementById('authUsername');
const authPasswordInput = document.getElementById('authPassword');
const authSecurityQuestion = document.getElementById('authSecurityQuestion');
const authSecurityAnswer = document.getElementById('authSecurityAnswer');
const authRegisterBtn = document.getElementById('authRegisterBtn');
const authLoginBtn = document.getElementById('authLoginBtn');
const guestAccessBtn = document.getElementById('guestAccessBtn');
const authShowRegisterBtn = document.getElementById('authShowRegisterBtn');
const authCancelRegisterBtn = document.getElementById('authCancelRegisterBtn');
const registerFields = document.getElementById('registerFields');
const authMessage = document.getElementById('authMessage');
const onlineRoomControls = document.getElementById('onlineRoomControls');
const forgotPasswordBtn = document.getElementById('forgotPasswordBtn');
const forgotPasswordArea = document.getElementById('forgotPasswordArea');
const forgotUsernameInput = document.getElementById('forgotUsernameInput');
const getSecurityQuestionBtn = document.getElementById('getSecurityQuestionBtn');
const securityQuestionBlock = document.getElementById('securityQuestionBlock');
const securityQuestionText = document.getElementById('securityQuestionText');
const securityAnswerRow = document.getElementById('securityAnswerRow');
const securityAnswerInput = document.getElementById('securityAnswerInput');
const resetPasswordFields = document.getElementById('resetPasswordFields');
const forgotNewPasswordInput = document.getElementById('forgotNewPasswordInput');
const forgotConfirmPasswordInput = document.getElementById('forgotConfirmPasswordInput');
const resetPasswordBtn = document.getElementById('resetPasswordBtn');
const forgotPasswordMessage = document.getElementById('forgotPasswordMessage');
const logoutBtn = document.getElementById('logoutBtn');
const playerUsername = document.getElementById('playerUsername');
const lobbyTabBtn = document.getElementById('lobbyTabBtn');
const profileTabBtn = document.getElementById('profileTabBtn');
const friendsTabBtn = document.getElementById('friendsTabBtn');
const joinContent = document.getElementById('joinContent');
const profileArea = document.getElementById('profileArea');
const friendsArea = document.getElementById('friendsArea');
const profileName = document.getElementById('profileName');
const friendUsernameInput = document.getElementById('friendUsernameInput');
const addFriendBtn = document.getElementById('addFriendBtn');
const friendsList = document.getElementById('friendsList');
const refreshFriendsBtn = document.getElementById('refreshFriendsBtn');
const privateMessagesBtn = document.getElementById('privateMessagesBtn');
const privateMessagesBadge = document.getElementById('privateMessagesBadge');
const friendActionMessage = document.getElementById('friendActionMessage');
const profileWins = document.getElementById('profileWins');
const profileLosses = document.getElementById('profileLosses');
const profileMatches = document.getElementById('profileMatches');
const profileWinrate = document.getElementById('profileWinrate');
const currentPasswordInput = document.getElementById('currentPasswordInput');
const newPasswordInput = document.getElementById('newPasswordInput');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
const changePasswordBtn = document.getElementById('changePasswordBtn');
const profileSecuritySetup = document.getElementById('profileSecuritySetup');
const profileSecurityQuestion = document.getElementById('profileSecurityQuestion');
const profileSecurityAnswer = document.getElementById('profileSecurityAnswer');
const passwordChangeMessage = document.getElementById('passwordChangeMessage');
const refreshProfileBtn = document.getElementById('refreshProfileBtn');
const rankingBody = document.getElementById('rankingBody');
const rankingStatus = document.getElementById('rankingStatus');
const roomArea = document.getElementById('roomArea');
const sharedRoomControls = document.getElementById('sharedRoomControls');
const gameArea = document.getElementById('gameArea');
const playerNameInput = document.getElementById('playerName');
const mesaSelect = document.getElementById('mesaSelect');
const refreshRoomsBtn = document.getElementById('refreshRoomsBtn');
const createRoomBtn = document.getElementById('createRoomBtn');
const playBotBtn = document.getElementById('playBotBtn');
const botCountSelect = document.getElementById('botCountSelect');
const joinBtn = document.getElementById('joinBtn');
const joinMessage = document.getElementById('joinMessage');
const connectionStatus = document.getElementById('connectionStatus');
const playersArea = document.getElementById('playersArea');
const lobbyPanel = document.getElementById('lobbyPanel');
const roomExitBtn = document.getElementById('roomExitBtn');
const lobbyRoomName = document.getElementById('lobbyRoomName');
const lobbyStatusMessage = document.getElementById('lobbyStatusMessage');
const lobbyPlayerCount = document.getElementById('lobbyPlayerCount');
const lobbyMaxPlayers = document.getElementById('lobbyMaxPlayers');
const lobbyPlayerList = document.getElementById('lobbyPlayerList');
const lobbyStartBtn = document.getElementById('lobbyStartBtn');
const lobbyHelpText = document.getElementById('lobbyHelpText');
const waitingPanel = document.getElementById('waitingPanel');
const waitingRoomName = document.getElementById('waitingRoomName');
const waitingStatusText = document.getElementById('waitingStatusText');
const waitingCount = document.getElementById('waitingCount');
const waitingPosition = document.getElementById('waitingPosition');
const waitingPlayerList = document.getElementById('waitingPlayerList');
const baralhoDiv = document.getElementById('baralho');
const descarteDiv = document.getElementById('descarte');
const maoDiv = document.getElementById('maoJogador');
const statusDiv = document.getElementById('status');

function createAudio(src, loop = false) {
  const audio = new Audio(src);
  audio.loop = loop;
  audio.preload = 'auto';
  audio.load();
  return audio;
}

const somComprar = createAudio("sons/comprar.mp3");
const somDescartar = createAudio("sons/descartar.mp3");
const somDeclarar = createAudio("sons/declarar.mp3");
const somMover = createAudio("sons/mover.mp3");
const somClique = createAudio("sons/click.mp3");
const somSuaVez = createAudio("sons/sua vez.mp3");
const somVenceu = createAudio("sons/venceu.mp3");
const somPerdeu = createAudio("sons/voce perdeu.mp3");
const somNovaMensagem = createAudio("sons/nova mensagem.mp3");

// Gerenciador de músicas
const MUSICAS_DISPONIVEIS = [
  { arquivo: "sons/game song.mp3", nome: "Game Song" },
  { arquivo: "sons/game song (2).mp3", nome: "Game Song 2" },
  { arquivo: "sons/game song (3).mp3", nome: "Game Song 3" },
  { arquivo: "sons/game song (4).mp3", nome: "Game Song 4" },
  { arquivo: "sons/game song (5).mp3", nome: "Game Song 5" },
  { arquivo: "sons/game song (6).mp3", nome: "Game Song 6" },
  { arquivo: "sons/game song (7).mp3", nome: "Game Song 7" },
  { arquivo: "sons/game song (8).mp3", nome: "Game Song 8" }
];

const CHAVE_MUSICA_SELECIONADA = 'lulu_musica_selecionada';

let musicaJogo = null;
let musicaSelecionada = localStorage.getItem(CHAVE_MUSICA_SELECIONADA) || MUSICAS_DISPONIVEIS[0].arquivo;

function criarOuAtualizarMusica(arquivo) {
  if (musicaJogo) {
    musicaJogo.pause();
    musicaJogo.currentTime = 0;
  }
  musicaJogo = createAudio(arquivo, true);
  musicaJogo.volume = 0.2;
  return musicaJogo;
}

function trocarMusica(arquivo) {
  musicaSelecionada = arquivo;
  localStorage.setItem(CHAVE_MUSICA_SELECIONADA, arquivo);
  criarOuAtualizarMusica(arquivo);
  if (musicEnabled) {
    tryPlayBackgroundMusic();
  }
}

function obterNomeMusica() {
  const musica = MUSICAS_DISPONIVEIS.find((m) => m.arquivo === musicaSelecionada);
  return musica ? musica.nome : "Game Song";
}

// Inicializar música
criarOuAtualizarMusica(musicaSelecionada);

function tocarSom(som) {
  if (!soundEnabled) return;
  if (!som) return;
  
  try {
    som.currentTime = 0;
    const playPromise = som.play();
    
    // Tratar a promessa retornada por .play()
    if (playPromise !== undefined) {
      playPromise
        .catch((error) => {
          console.warn('Som bloqueado ou falhou na primeira tentativa:', error.name);
          // Retry com delay para contornar políticas de autoplay
          setTimeout(() => {
            try {
              som.currentTime = 0;
              som.play().catch(() => {});
            } catch (e) {}
          }, 50);
        });
    }
  } catch (error) {
    console.warn('Erro ao tentar tocar som:', error);
  }
}

if (connectionStatus && window.location.protocol === 'file:') {
  connectionStatus.textContent = 'Abra a página usando http://localhost:3000, não direto do arquivo.';
}
const jogadorInfo = document.getElementById('jogadorInfo');
const baterBtn = document.getElementById('baterBtn');
const startGameBtn = document.getElementById('startGameBtn');
const exitRoomBtn = document.getElementById('exitRoomBtn');
const meldsJogadorDiv = document.getElementById('meldsJogador');
const resetBtn = document.getElementById('resetBtn');
const topoSection = document.getElementById('topo');
const infosSection = document.getElementById('infos');
const mesaSection = document.getElementById('mesa');
const meldsSection = document.getElementById('melds');
const finalButtons = document.querySelector('.botoes-finais');
const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatPanel = document.getElementById('chatPanel');
const chatHeaderTitle = document.querySelector('#chatPanel .chat-panel-header span');
const chatPreview = document.getElementById('chatPreview');
const chatCloseBtn = document.getElementById('chatCloseBtn');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const privateChatArea = document.getElementById('privateChatArea');
const privateChatTitle = document.getElementById('privateChatTitle');
const privateChatSubtitle = document.getElementById('privateChatSubtitle');
const closePrivateChatBtn = document.getElementById('closePrivateChatBtn');
const clearPrivateChatBtn = document.getElementById('clearPrivateChatBtn');
const privateChatMessages = document.getElementById('privateChatMessages');
const privateChatInput = document.getElementById('privateChatInput');
const sendPrivateChatBtn = document.getElementById('sendPrivateChatBtn');
const privateChatNotice = document.getElementById('privateChatNotice');
const contactsPanel = document.getElementById('contactsPanel');
const contactsSearchInput = document.getElementById('contactsSearchInput');
const contactsList = document.getElementById('contactsList');
const closeContactsBtn = document.getElementById('closeContactsBtn');
const contactsSubtitle = document.getElementById('contactsSubtitle');
const privateMessagesUnreadByFriend = {};
let totalUnreadPrivateMessages = 0;
let allFriendsCache = [];
const editRoomNameBtn = document.getElementById('editRoomNameBtn');
const editWaitingRoomNameBtn = document.getElementById('editWaitingRoomNameBtn');
const CHAT_MAX_LENGTH = 200;
const chatMessageIds = new Set();

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    console.log('Reset button clicked, emitting reset-room');
    if (window.isGuest) {
      sendAction('reset-room');
    } else {
      socket.emit('reset-room');
    }
  });
}

const toggleSoundBtn = document.getElementById('toggleSoundBtn');
const toggleMusicBtn = document.getElementById('toggleMusicBtn');
const musicSelectBtn = document.getElementById('musicSelectBtn');
const currentMusicName = document.getElementById('currentMusicName');
const musicDropdown = document.getElementById('musicDropdown');
const musicList = document.getElementById('musicList');
let soundEnabled = true;
let musicEnabled = true;

function atualizarBotoesSom() {
  if (toggleSoundBtn) toggleSoundBtn.textContent = `Efeitos: ${soundEnabled ? 'On' : 'Off'}`;
  if (toggleMusicBtn) toggleMusicBtn.textContent = `🎵 ${musicEnabled ? 'ON' : 'OFF'}`;
  if (currentMusicName) currentMusicName.textContent = obterNomeMusica();
}

function setSoundEnabled(enabled) {
  soundEnabled = enabled;
  atualizarBotoesSom();
}

function setMusicEnabled(enabled) {
  musicEnabled = enabled;
  atualizarBotoesSom();
  if (!musicEnabled) {
    musicaJogo.pause();
  } else {
    tryPlayBackgroundMusic();
  }
}

function tryPlayBackgroundMusic() {
  if (!musicEnabled) return;
  musicaJogo.play().catch(() => {});
}

// Inicializar dropdown de músicas
function inicializarDropdownMusicas() {
  musicList.innerHTML = '';
  MUSICAS_DISPONIVEIS.forEach((musica) => {
    const item = document.createElement('div');
    item.className = 'music-item';
    if (musica.arquivo === musicaSelecionada) {
      item.classList.add('selected');
    }
    item.textContent = musica.nome;
    item.addEventListener('click', () => {
      trocarMusica(musica.arquivo);
      fecharDropdownMusicas();
      atualizarBotoesSom();
    });
    musicList.appendChild(item);
  });
}

function abrirDropdownMusicas() {
  if (musicDropdown.classList.contains('hidden')) {
    musicDropdown.classList.remove('hidden');
    musicDropdown.setAttribute('aria-hidden', 'false');
  }
}

function fecharDropdownMusicas() {
  if (!musicDropdown.classList.contains('hidden')) {
    musicDropdown.classList.add('hidden');
    musicDropdown.setAttribute('aria-hidden', 'true');
  }
}

// Event listeners para o dropdown
if (musicSelectBtn && musicDropdown) {
  musicSelectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    inicializarDropdownMusicas();
    abrirDropdownMusicas();
  });

  // Fechar ao clicar fora do dropdown
  document.addEventListener('click', (ev) => {
    if (musicDropdown.classList.contains('hidden')) return;
    if (musicSelectBtn.contains(ev.target) || musicDropdown.contains(ev.target)) return;
    fecharDropdownMusicas();
  });

  // Previne fechamento ao clicar dentro do dropdown
  musicDropdown.addEventListener('click', (ev) => ev.stopPropagation());
}

if (toggleSoundBtn || toggleMusicBtn) {
  const savedSound = localStorage.getItem('lulu_sound_enabled');
  const savedMusic = localStorage.getItem('lulu_music_enabled');
  if (savedSound !== null) soundEnabled = savedSound === 'true';
  if (savedMusic !== null) musicEnabled = savedMusic === 'true';
  atualizarBotoesSom();

  if (toggleSoundBtn) {
    toggleSoundBtn.addEventListener('click', () => {
      setSoundEnabled(!soundEnabled);
      localStorage.setItem('lulu_sound_enabled', String(soundEnabled));
    });
  }
  if (toggleMusicBtn) {
    toggleMusicBtn.addEventListener('click', () => {
      setMusicEnabled(!musicEnabled);
      localStorage.setItem('lulu_music_enabled', String(musicEnabled));
    });
  }

  document.addEventListener('click', tryPlayBackgroundMusic, { once: true });
  document.addEventListener('keydown', tryPlayBackgroundMusic, { once: true });
  tryPlayBackgroundMusic();
}

// Painel de configurações de som (abrir/fechar)
const settingsBtn = document.getElementById('settingsBtn');
const soundPanel = document.getElementById('soundPanel');
function showSoundPanel(show) {
  if (!soundPanel) return;
  soundPanel.classList.toggle('hidden', !show);
  soundPanel.setAttribute('aria-hidden', String(!show));
}

if (settingsBtn && soundPanel) {
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = soundPanel.classList.contains('hidden');
    showSoundPanel(isHidden);
  });

  // fecha ao clicar fora
  document.addEventListener('click', (ev) => {
    if (!soundPanel || soundPanel.classList.contains('hidden')) return;
    if (ev.target === settingsBtn || soundPanel.contains(ev.target)) return;
    showSoundPanel(false);
  });

  // previne fechamento ao clicar dentro do painel
  soundPanel.addEventListener('click', (ev) => ev.stopPropagation());
}

function isButtonExcludedForClickSound(id) {
  return ['comprarBaralho', 'comprarDescarte', 'declararMeldBtn', 'autoDeclararBtn', 'toggleSoundBtn', 'toggleMusicBtn'].includes(id);
}

function setupButtonClickSounds() {
  document.querySelectorAll('button').forEach((button) => {
    if (!button.id || isButtonExcludedForClickSound(button.id)) return;
    button.addEventListener('click', () => {
      tocarSom(somClique);
    });
  });
}

setupButtonClickSounds();

// Authentication UI helpers
function showAuthMessage(msg, isError = true) {
  if (!authMessage) return;
  authMessage.textContent = msg || '';
  authMessage.style.color = isError ? '#ffcccc' : '#bfffcf';
}

function showAuth() {
  if (authArea) authArea.classList.remove('hidden');
  if (joinArea) joinArea.classList.add('hidden');
}

function hideAuth() {
  if (authArea) authArea.classList.add('hidden');
  if (joinArea) joinArea.classList.remove('hidden');
}

function setGuestMode(enabled) {
  window.isLoggedIn = !enabled;
  window.isGuest = enabled;
  saveOfflineMode(enabled);
  if (playerUsername) {
    playerUsername.textContent = enabled ? '👤 Convidado' : (window.player ? `👤 ${window.player.username} (${window.player.wins || 0}V - ${window.player.losses || 0}D)` : '');
  }
  if (profileTabBtn) profileTabBtn.classList.toggle('hidden', enabled);
  if (friendsTabBtn) friendsTabBtn.classList.toggle('hidden', enabled);
  if (privateMessagesBtn) privateMessagesBtn.classList.toggle('hidden', enabled);
  if (onlineRoomControls) onlineRoomControls.classList.toggle('hidden', enabled);
  if (joinMessage) {
    joinMessage.textContent = enabled ? 'Modo convidado: apenas Jogar com Bot funciona sem login.' : '';
  }
  if (guestAccessBtn) guestAccessBtn.textContent = enabled ? 'Voltar ao login' : 'Jogar como convidado';
  if (connectionStatus) {
    connectionStatus.textContent = enabled ? 'Offline: modo convidado ativo.' : 'Conectado ao servidor.';
  }
}

function handleAuthSuccess(player) {
  setGuestMode(false);
  window.player = player;
  window.currentRoom = null;
  savePlayerToStorage(player);
  if (player && player.username && playerNameInput) {
    playerNameInput.value = player.username;
  }
  if (player && player.username && playerUsername) {
    playerUsername.textContent = `👤 ${player.username} (${player.wins || 0}V - ${player.losses || 0}D)`;
  }
  showAuthMessage('Autenticado com sucesso.', false);
  hideAuth();
  showLobbyTab();
}

let rankingRecords = [];
let isProfileLoading = false;

function formatWinrate(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '0%';
  return `${Number(value).toFixed(2)}%`;
}

function setActiveTab(activeTab) {
  if (!lobbyTabBtn || !profileTabBtn || !friendsTabBtn || !joinContent || !profileArea || !friendsArea) return;
  const isProfile = activeTab === 'profile';
  const isFriends = activeTab === 'friends';
  lobbyTabBtn.classList.toggle('active', !isProfile && !isFriends);
  profileTabBtn.classList.toggle('active', isProfile);
  friendsTabBtn.classList.toggle('active', isFriends);
  joinContent.style.display = isProfile || isFriends ? 'none' : 'block';
  profileArea.classList.toggle('active', isProfile);
  profileArea.classList.toggle('hidden', !isProfile);
  friendsArea.classList.toggle('active', isFriends);
  friendsArea.classList.toggle('hidden', !isFriends);
}

function showLobbyTab() {
  setActiveTab('lobby');
}

function showProfileTab() {
  setActiveTab('profile');
  renderProfileStats();
  clearPasswordChangeForm();
  showProfileSecuritySetup(!window.player?.securityConfigured);
  loadRanking(true);
}

let activePrivateFriend = null;
const privateChatHistory = {};

function showFriendsTab() {
  setActiveTab('friends');
  loadFriendsList();
}

function updatePrivateMessagesBadge() {
  totalUnreadPrivateMessages = Object.values(privateMessagesUnreadByFriend).reduce((sum, count) => sum + count, 0);
  if (!privateMessagesBadge || !privateMessagesBtn) return;
  if (totalUnreadPrivateMessages > 0) {
    privateMessagesBadge.textContent = totalUnreadPrivateMessages > 99 ? '99+' : String(totalUnreadPrivateMessages);
    privateMessagesBadge.classList.remove('hidden');
    privateMessagesBtn.classList.add('new-message');
  } else {
    privateMessagesBadge.textContent = '0';
    privateMessagesBadge.classList.add('hidden');
    privateMessagesBtn.classList.remove('new-message');
  }
}

function clearUnreadMessagesForFriend(friendId) {
  if (!friendId) return;
  delete privateMessagesUnreadByFriend[friendId];
  updatePrivateMessagesBadge();
}

function getLastMessagePreview(friendId) {
  const history = privateChatHistory[friendId] || [];
  if (!history.length) return 'Sem conversa ainda.';
  const last = history[history.length - 1];
  const text = String(last.text || '');
  const excerpt = text.length > 36 ? `${text.slice(0, 36)}...` : text;
  const sender = last.username || 'Amigo';
  return `${sender}: ${excerpt}`;
}

function renderContactsList(friends) {
  if (!contactsList) return;
  const query = contactsSearchInput?.value.trim().toLowerCase() || '';
  const filtered = (friends || []).filter((friend) => {
    const name = friend.username.toLowerCase();
    const preview = getLastMessagePreview(friend.id).toLowerCase();
    return name.includes(query) || preview.includes(query);
  });

  contactsList.innerHTML = '';
  if (!filtered.length) {
    contactsList.innerHTML = '<p class="empty-state">Nenhum amigo encontrado.</p>';
    return;
  }

  filtered.forEach((friend) => {
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.dataset.friendId = friend.id;
    row.dataset.friendName = friend.username;
    const preview = getLastMessagePreview(friend.id);
    row.innerHTML = `
      <div class="contact-main">
        <div class="contact-name-row">
          <span class="contact-name">${friend.username}</span>
          ${privateMessagesUnreadByFriend[friend.id] ? `<span class="friend-unread-badge">${privateMessagesUnreadByFriend[friend.id]}</span>` : ''}
        </div>
        <span class="contact-preview">${preview}</span>
      </div>
    `;
    contactsList.appendChild(row);
  });
}

function showContactsPanel() {
  if (!contactsPanel) return;
  contactsPanel.classList.remove('hidden');
  if (privateChatArea) privateChatArea.classList.add('hidden');
  if (contactsSearchInput) contactsSearchInput.parentElement?.classList.remove('hidden');
  if (contactsSubtitle) {
    contactsSubtitle.textContent = 'Buscar amigos e conversas.';
    contactsSubtitle.classList.remove('hidden');
  }
  renderContactsList(allFriendsCache);
}

function closeContactsPanel() {
  if (!contactsPanel) return;
  contactsPanel.classList.add('hidden');
  closePrivateChat(false);
}

function openContactList() {
  if (!contactsPanel) return;
  const isOpen = !contactsPanel.classList.contains('hidden');
  if (isOpen) {
    closeContactsPanel();
    return;
  }
  showContactsPanel();
  if (!window.player || !socket || !socket.connected) return;
  loadFriendsList();
}

function showFriendMessage(msg, isError = true) {
  if (!friendActionMessage) return;
  friendActionMessage.textContent = msg || '';
  friendActionMessage.style.color = isError ? '#ffcccc' : '#bfffcf';
}

function clearFriendActionMessage() {
  if (!friendActionMessage) return;
  friendActionMessage.textContent = '';
}

function showPrivateChatNotice(msg, isError = true) {
  if (!privateChatNotice) return;
  privateChatNotice.textContent = msg || '';
  privateChatNotice.style.color = isError ? '#ffcccc' : '#bfffcf';
}

function clearPrivateChatNotice() {
  if (!privateChatNotice) return;
  privateChatNotice.textContent = '';
}

function getFriendStatusBadge(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'em partida') return 'friend-status-battle';
  if (normalized === 'online') return 'friend-status-online';
  if (normalized === 'no lobby') return 'friend-status-lobby';
  return 'friend-status-offline';
}

function renderFriendsList(friends) {
  if (!friendsList) return;
  friendsList.innerHTML = '';
  if (!Array.isArray(friends) || friends.length === 0) {
    friendsList.innerHTML = '<p class="empty-state">Nenhum amigo adicionado ainda.</p>';
    return;
  }

  friends.forEach((friend) => {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.dataset.friendId = friend.id;
    row.dataset.friendName = friend.username;
    row.innerHTML = `
      <div class="friend-main">
        <span class="friend-status-indicator ${getFriendStatusBadge(friend.status)}" aria-hidden="true"></span>
        <div class="friend-details">
          <span class="friend-name">${friend.username}</span>
          <span class="friend-status-text">${friend.status || 'Offline'}</span>
        </div>
      </div>
      <div class="friend-actions">
        ${privateMessagesUnreadByFriend[friend.id] ? `<span class="friend-unread-badge">${privateMessagesUnreadByFriend[friend.id]}</span>` : ''}
        <button type="button" class="botao-acao pequena friend-remove-btn" data-friend-id="${friend.id}">Remover</button>
      </div>
    `;
    friendsList.appendChild(row);
  });
}

function loadFriendsList() {
  if (!window.player || !socket || !socket.connected) {
    renderFriendsList([]);
    renderContactsList([]);
    return;
  }

  socket.emit('list-friends', (res) => {
    if (res && res.success) {
      allFriendsCache = res.friends || [];
      renderFriendsList(allFriendsCache);
      renderContactsList(allFriendsCache);
      clearFriendActionMessage();
      return;
    }
    showFriendMessage(res?.message || 'Não foi possível carregar seus amigos.');
  });
}

function handleAddFriend() {
  if (!friendUsernameInput) return;
  const username = friendUsernameInput.value.trim();
  if (!username) {
    showFriendMessage('Digite o nome de usuário do amigo.');
    return;
  }
  if (!socket || !socket.connected) {
    showFriendMessage('Conexão perdida. Tente novamente.');
    return;
  }

  socket.emit('add-friend', { username }, (res) => {
    if (res && res.success) {
      renderFriendsList(res.friends || []);
      friendUsernameInput.value = '';
      showFriendMessage(res.message || 'Amigo adicionado com sucesso.', false);
      return;
    }
    showFriendMessage(res?.message || 'Erro ao adicionar amigo.');
  });
}

function handleRemoveFriend(friendId) {
  if (!socket || !socket.connected) {
    showFriendMessage('Conexão perdida. Tente novamente.');
    return;
  }

  socket.emit('remove-friend', { friendId }, (res) => {
    if (res && res.success) {
      renderFriendsList(res.friends || []);
      showFriendMessage(res.message || 'Amigo removido com sucesso.', false);
      if (activePrivateFriend?.id === friendId) {
        closePrivateChat();
      }
      return;
    }
    showFriendMessage(res?.message || 'Erro ao remover amigo.');
  });
}

function openPrivateChat(friend) {
  if (!friend || !friend.id) return;
  activePrivateFriend = friend;
  if (privateChatTitle) privateChatTitle.textContent = `Chat com ${friend.username}`;
  if (privateChatSubtitle) privateChatSubtitle.textContent = `Conversa privada com ${friend.username}`;
  if (privateChatArea) privateChatArea.classList.remove('hidden');
  if (contactsPanel) contactsPanel.classList.add('hidden');
  if (privateChatInput) privateChatInput.focus();
  clearPrivateChatNotice();
  clearUnreadMessagesForFriend(friend.id);
  loadPrivateChatHistory(friend.id);
}

function getPrivateChatStorageKey(friendId) {
  return 'chat_' + friendId;
}

function closePrivateChat(reopenContacts = false) {
  activePrivateFriend = null;
  if (privateChatArea) privateChatArea.classList.add('hidden');
  if (privateChatMessages) privateChatMessages.innerHTML = '';
  if (privateChatTitle) privateChatTitle.textContent = 'Chat privado';
  if (privateChatSubtitle) privateChatSubtitle.textContent = 'Selecione um amigo para iniciar uma conversa.';
  clearPrivateChatNotice();
  if (reopenContacts) {
    showContactsPanel();
  }
}

function appendPrivateChatMessage({ id, username, text, time, isOwn }) {
  if (!privateChatMessages) return;
  const messageEl = document.createElement('div');
  messageEl.className = `chat-message private-chat-message ${isOwn ? 'own' : 'other'}`;
  const nameEl = document.createElement('strong');
  nameEl.textContent = username || 'Jogador';
  const textEl = document.createElement('span');
  textEl.textContent = String(text || '');
  const timeEl = document.createElement('span');
  timeEl.style.fontSize = '0.75rem';
  timeEl.style.opacity = '0.7';
  timeEl.textContent = time ? ` ${new Date(time).toLocaleTimeString()}` : '';
  messageEl.appendChild(nameEl);
  messageEl.appendChild(textEl);
  messageEl.appendChild(timeEl);
  privateChatMessages.appendChild(messageEl);
  privateChatMessages.scrollTop = privateChatMessages.scrollHeight;
}

function renderPrivateChatHistory(history) {
  if (!privateChatMessages) return;
  privateChatMessages.innerHTML = '';
  (history || []).forEach((entry) => {
    appendPrivateChatMessage({
      id: entry.id,
      username: entry.username,
      text: entry.text,
      time: entry.time,
      isOwn: entry.senderId === window.player?.id
    });
  });
}

function loadPrivateChatHistory(friendId) {
  const storageKey = getPrivateChatStorageKey(friendId);
  const history = JSON.parse(localStorage.getItem(storageKey)) || [];
  privateChatHistory[friendId] = history;
  renderPrivateChatHistory(history);
}

function sendPrivateChatMessage() {
  if (!activePrivateFriend || !activePrivateFriend.id) {
    showPrivateChatNotice('Selecione um amigo para conversar.');
    return;
  }
  if (!privateChatInput || !privateChatInput.value) return;
  const rawText = String(privateChatInput.value).trim();
  if (!rawText) return;
  if (rawText.length > CHAT_MAX_LENGTH) {
    showPrivateChatNotice(`A mensagem deve ter no máximo ${CHAT_MAX_LENGTH} caracteres.`);
    return;
  }
  const friendId = activePrivateFriend.id;

  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: window.player?.id,
    recipientId: activePrivateFriend.id,
    username: window.player?.username || 'Você',
    text: rawText,
    time: new Date().toISOString()
  };
  if (!privateChatHistory[friendId]) privateChatHistory[friendId] = [];
  privateChatHistory[friendId].push(message);
  const storageKey = getPrivateChatStorageKey(friendId);
  localStorage.setItem(storageKey, JSON.stringify(privateChatHistory[friendId]));

  socket.emit('send-private-message', { friendId: activePrivateFriend.id, text: rawText }, (res) => {
    if (res && res.success) {
      renderPrivateChatHistory(privateChatHistory[activePrivateFriend.id]);
      privateChatInput.value = '';
      clearPrivateChatNotice();
      return;
    }
    showPrivateChatNotice(res?.message || 'Erro ao enviar mensagem privada.');
  });
}

function showPasswordChangeMessage(msg, isError = true) {
  if (!passwordChangeMessage) return;
  passwordChangeMessage.textContent = msg || '';
  passwordChangeMessage.style.color = isError ? '#ffcccc' : '#bfffcf';
}

function clearPrivateChatHistory() {
  if (!activePrivateFriend || !activePrivateFriend.id) {
    showPrivateChatNotice('Nenhum chat selecionado.');
    return;
  }
  if (!confirm('Tem certeza que deseja limpar este chat?')) return;
  
  const friendId = activePrivateFriend.id;
  const storageKey = getPrivateChatStorageKey(friendId);
  localStorage.removeItem(storageKey);
  privateChatHistory[friendId] = [];
  if (privateChatMessages) privateChatMessages.innerHTML = '';
  showPrivateChatNotice('Chat limpo com sucesso!');
}

function clearPasswordChangeForm() {
  if (currentPasswordInput) currentPasswordInput.value = '';
  if (newPasswordInput) newPasswordInput.value = '';
  if (confirmPasswordInput) confirmPasswordInput.value = '';
  if (profileSecurityQuestion) profileSecurityQuestion.value = '';
  if (profileSecurityAnswer) profileSecurityAnswer.value = '';
  if (profileSecuritySetup) profileSecuritySetup.classList.add('hidden');
  if (passwordChangeMessage) passwordChangeMessage.textContent = '';
}

function showProfileSecuritySetup(show) {
  if (!profileSecuritySetup) return;
  profileSecuritySetup.classList.toggle('hidden', !show);
  if (show && profileSecurityQuestion) profileSecurityQuestion.focus();
}

function handleChangePassword(event) {
  if (event?.preventDefault) event.preventDefault();
  const currentPassword = currentPasswordInput?.value || '';
  const newPassword = newPasswordInput?.value || '';
  const confirmPassword = confirmPasswordInput?.value || '';
  const securityQuestion = profileSecurityQuestion?.value || '';
  const securityAnswer = profileSecurityAnswer?.value?.trim() || '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    showPasswordChangeMessage('Preencha todos os campos.');
    return;
  }

  if (newPassword !== confirmPassword) {
    showPasswordChangeMessage('A nova senha e a confirmação não correspondem.');
    return;
  }

  if (newPassword.length < 6) {
    showPasswordChangeMessage('A senha deve ter pelo menos 6 caracteres.');
    return;
  }

  if (!socket || !socket.connected) {
    showPasswordChangeMessage('Conexão perdida. Tente novamente.');
    return;
  }

  socket.emit('change-password', { currentPassword, newPassword, securityQuestion, securityAnswer }, (res) => {
    if (res && res.success) {
      showPasswordChangeMessage(res.message || 'Senha alterada com sucesso.', false);
      clearPasswordChangeForm();
      if (window.player) window.player.securityConfigured = true;
    } else if (res && res.needsSecuritySetup) {
      showPasswordChangeMessage(res.message || 'Informe pergunta e resposta de segurança.', true);
      showProfileSecuritySetup(true);
    } else {
      showPasswordChangeMessage(res?.message || 'Falha ao alterar senha.');
    }
  });
}

function updateProfileStatsFromRecord(record) {
  if (!record) return;
  profileWins.textContent = record.wins ?? 0;
  profileLosses.textContent = record.losses ?? 0;
  profileMatches.textContent = record.matches ?? 0;
  profileWinrate.textContent = formatWinrate(record.winrate ?? 0);
}

function renderProfileStats() {
  if (!profileName) return;
  const playerName = window.player?.username || 'Carregando...';
  profileName.textContent = playerName;
  const record = rankingRecords.find((item) => String(item.username).toLowerCase() === String(playerName).toLowerCase());
  if (record) {
    updateProfileStatsFromRecord(record);
    return;
  }

  if (window.player) {
    profileWins.textContent = window.player.wins ?? 0;
    profileLosses.textContent = window.player.losses ?? 0;
    profileMatches.textContent = window.player.matches ?? '—';
    const matches = window.player.matches ?? 0;
    const wins = window.player.wins ?? 0;
    profileWinrate.textContent = matches > 0 ? formatWinrate((wins / matches) * 100) : '—';
    return;
  }

  profileWins.textContent = '—';
  profileLosses.textContent = '—';
  profileMatches.textContent = '—';
  profileWinrate.textContent = '—';
}

function renderRanking(records) {
  if (!rankingBody || !rankingStatus) return;
  rankingBody.innerHTML = '';
  if (!records || records.length === 0) {
    rankingStatus.textContent = 'Sem dados disponíveis.';
    return;
  }
  rankingStatus.textContent = `Top ${records.length}`;
  const playerName = window.player?.username?.toLowerCase();
  records.forEach((record, index) => {
    const tr = document.createElement('tr');
    if (index < 3) tr.classList.add('top-three');
    if (playerName && record.username?.toLowerCase() === playerName) {
      tr.classList.add('highlighted');
    }
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${record.username || '—'}</td>
      <td>${record.wins ?? 0}</td>
      <td>${record.losses ?? 0}</td>
      <td>${formatWinrate(record.winrate ?? 0)}</td>
    `;
    rankingBody.appendChild(tr);
  });
}

function loadRanking(force = false) {
  if (!profileArea || profileArea.classList.contains('hidden')) return;
  if (isProfileLoading) return;
  if (!force && rankingRecords.length > 0) {
    renderRanking(rankingRecords);
    renderProfileStats();
    return;
  }
  if (!rankingStatus) return;
  rankingStatus.textContent = 'Carregando...';
  isProfileLoading = true;
  socket.emit('get-records', (response) => {
    isProfileLoading = false;
    if (response && response.success && Array.isArray(response.records)) {
      rankingRecords = response.records;
      renderRanking(rankingRecords);
      renderProfileStats();
      return;
    }
    rankingStatus.textContent = response?.message || 'Falha ao carregar ranking.';
  });
}

function logout() {
  if (socket && socket.connected) {
    socket.emit('logout', (res) => {
      if (!res || !res.success) {
        console.warn('Logout não confirmado pelo servidor', res);
      }
    });
  }
  window.player = null;
  window.isLoggedIn = false;
  window.isGuest = false;
  window.currentRoom = null;
  clearPlayerStorage();
  clearReconnectInfo();
  if (playerUsername) playerUsername.textContent = '';
  if (authUsernameInput) authUsernameInput.value = '';
  if (authPasswordInput) authPasswordInput.value = '';
  if (playerNameInput) playerNameInput.value = '';
  desabilitaArea();
  setGuestMode(false);
  showAuthMessage('Você saiu. Faça login novamente.', false);
  showAuth();
}

// Register / Login button handlers
if (authRegisterBtn) {
  authRegisterBtn.addEventListener('click', () => {
    const username = authUsernameInput?.value?.trim();
    const password = authPasswordInput?.value || '';
    const securityQuestion = authSecurityQuestion?.value || '';
    const securityAnswer = authSecurityAnswer?.value?.trim() || '';
    if (!username || !password) {
      showAuthMessage('Preencha usuário e senha.');
      return;
    }
    if (!securityQuestion || !securityAnswer) {
      showAuthMessage('Selecione pergunta e resposta de segurança.');
      return;
    }
    socket.emit('register', { username, password, securityQuestion, securityAnswer }, (res) => {
      const ok = res && (res.success || res.ok);
      if (ok) {
        handleAuthSuccess(res.player);
      } else {
        showAuthMessage(res?.message || res?.error || 'Erro ao criar conta.');
      }
    });
  });
}
if (authShowRegisterBtn) {
  authShowRegisterBtn.addEventListener('click', () => {
    if (registerFields) registerFields.classList.remove('hidden');
    if (authShowRegisterBtn) authShowRegisterBtn.classList.add('hidden');
    if (authSecurityQuestion) authSecurityQuestion.focus();
  });
}
if (authCancelRegisterBtn) {
  authCancelRegisterBtn.addEventListener('click', () => {
    if (registerFields) registerFields.classList.add('hidden');
    if (authShowRegisterBtn) authShowRegisterBtn.classList.remove('hidden');
    if (authSecurityQuestion) authSecurityQuestion.value = '';
    if (authSecurityAnswer) authSecurityAnswer.value = '';
    showAuthMessage('');
  });
}

if (authLoginBtn) {
  authLoginBtn.addEventListener('click', () => {
    const username = authUsernameInput?.value?.trim();
    const password = authPasswordInput?.value || '';
    if (!username || !password) {
      showAuthMessage('Preencha usuário e senha.');
      return;
    }
    if (!socket) {
      showAuthMessage('Sem conexão com o servidor. Atualize a página e verifique se o backend está rodando.');
      return;
    }
    if (!socket.connected) {
      showAuthMessage('Conectando ao servidor... seu login será enviado assim que a conexão for estabelecida.', false);
    }
    socket.emit('login', { username, password }, (res) => {
      const ok = res && (res.success || res.ok);
      if (ok) {
        handleAuthSuccess(res.player);
      } else {
        showAuthMessage(res?.message || res?.error || 'Erro ao autenticar.');
      }
    });
  });
}

if (guestAccessBtn) {
  guestAccessBtn.addEventListener('click', () => {
    const isCurrentlyGuest = window.isGuest === true;
    if (isCurrentlyGuest) {
      window.isGuest = false;
      setGuestMode(false);
      clearOfflineGameState();
      showAuth();
      return;
    }
    window.player = null;
    window.currentRoom = null;
    setGuestMode(true);
    hideAuth();
    showLobbyTab();
    showAuthMessage('Modo convidado ativado. Use apenas Jogar com Bot para jogar offline.', false);
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    logout();
  });
}

if (lobbyTabBtn) {
  lobbyTabBtn.addEventListener('click', () => showLobbyTab());
}
if (profileTabBtn) {
  profileTabBtn.addEventListener('click', () => showProfileTab());
}
if (friendsTabBtn) {
  friendsTabBtn.addEventListener('click', () => showFriendsTab());
}
if (refreshProfileBtn) {
  refreshProfileBtn.addEventListener('click', () => loadRanking(true));
}
if (refreshFriendsBtn) {
  refreshFriendsBtn.addEventListener('click', () => loadFriendsList());
}
if (privateMessagesBtn) {
  privateMessagesBtn.addEventListener('click', openContactList);
}
if (contactsSearchInput) {
  contactsSearchInput.addEventListener('input', () => renderContactsList(allFriendsCache));
}
if (contactsList) {
  contactsList.addEventListener('click', (event) => {
    const row = event.target.closest('.contact-row');
    if (!row) return;
    const friendId = Number(row.dataset.friendId);
    const friendName = row.dataset.friendName || 'Amigo';
    if (friendId) {
      openPrivateChat({ id: friendId, username: friendName });
    }
  });
}
if (addFriendBtn) {
  addFriendBtn.addEventListener('click', handleAddFriend);
}
if (friendsList) {
  friendsList.addEventListener('click', (event) => {
    const removeButton = event.target.closest('.friend-remove-btn');
    if (removeButton) {
      const friendId = Number(removeButton.dataset.friendId);
      if (!friendId) return;
      handleRemoveFriend(friendId);
      return;
    }

    const row = event.target.closest('.friend-row');
    if (!row) return;
    const friendId = Number(row.dataset.friendId || '0');
    const friendName = row.dataset.friendName || 'Amigo';
    if (friendId) {
      openPrivateChat({ id: friendId, username: friendName });
    }
  });
}
if (sendPrivateChatBtn) {
  sendPrivateChatBtn.addEventListener('click', sendPrivateChatMessage);
}
if (closePrivateChatBtn) {
  closePrivateChatBtn.addEventListener('click', () => closePrivateChat(true));
}
if (clearPrivateChatBtn) {
  clearPrivateChatBtn.addEventListener('click', clearPrivateChatHistory);
}
if (privateChatInput) {
  privateChatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendPrivateChatMessage();
    }
  });
}
if (changePasswordBtn) {
  changePasswordBtn.addEventListener('click', handleChangePassword);
}
if (forgotPasswordBtn) {
  forgotPasswordBtn.addEventListener('click', () => {
    if (!forgotPasswordArea) return;
    forgotPasswordArea.classList.toggle('hidden');
    clearForgotPasswordForm();
  });
}
if (getSecurityQuestionBtn) {
  getSecurityQuestionBtn.addEventListener('click', requestSecurityQuestion);
}
if (resetPasswordBtn) {
  resetPasswordBtn.addEventListener('click', resetPassword);
}
if (chatToggleBtn) {
  chatToggleBtn.addEventListener('click', () => {
    if (!chatPanel) return;
    const isHidden = chatPanel.classList.contains('hidden');
    chatPanel.classList.toggle('hidden');
    if (isHidden) {
      chatToggleBtn.classList.remove('new-message');
      chatInput?.focus();
      hideChatPreview();
    }
  });
}
if (chatCloseBtn) {
  chatCloseBtn.addEventListener('click', () => {
    if (chatPanel) chatPanel.classList.add('hidden');
    hideChatPreview();
  });
}
if (sendChatBtn) {
  sendChatBtn.addEventListener('click', sendChatMessage);
}
if (chatInput) {
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendChatMessage();
    }
  });
}

function showForgotPasswordMessage(msg, isError = true) {
  if (!forgotPasswordMessage) return;
  forgotPasswordMessage.textContent = msg || '';
  forgotPasswordMessage.style.color = isError ? '#ffcccc' : '#bfffcf';
}

function clearForgotPasswordForm() {
  if (forgotUsernameInput) forgotUsernameInput.value = '';
  if (securityQuestionText) securityQuestionText.textContent = '';
  if (securityAnswerInput) securityAnswerInput.value = '';
  if (forgotNewPasswordInput) forgotNewPasswordInput.value = '';
  if (forgotConfirmPasswordInput) forgotConfirmPasswordInput.value = '';
  if (securityQuestionBlock) securityQuestionBlock.classList.add('hidden');
  if (securityAnswerRow) securityAnswerRow.classList.add('hidden');
  if (resetPasswordFields) resetPasswordFields.classList.add('hidden');
  showForgotPasswordMessage('');
}

function appendChatMessage({ id, username, text, time, isOwn }) {
  if (!chatMessages) return;
  if (id && chatMessageIds.has(id)) return;
  if (id) chatMessageIds.add(id);
  const messageEl = document.createElement('div');
  messageEl.className = 'chat-message';
  const nameEl = document.createElement('strong');
  nameEl.textContent = username || 'Jogador';
  const textEl = document.createElement('span');
  textEl.textContent = String(text || '');
  const timeEl = document.createElement('span');
  timeEl.style.fontSize = '0.75rem';
  timeEl.style.opacity = '0.7';
  timeEl.textContent = time ? ` ${time}` : '';
  messageEl.appendChild(nameEl);
  messageEl.appendChild(textEl);
  messageEl.appendChild(timeEl);
  if (isOwn) {
    messageEl.style.opacity = '0.9';
  }
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHistory(history) {
  if (!chatMessages) return;
  chatMessageIds.clear();
  chatMessages.innerHTML = '';
  (history || []).forEach((entry) => {
    appendChatMessage({
      id: entry.id,
      username: entry.username,
      text: entry.text,
      time: entry.time ? new Date(entry.time).toLocaleTimeString() : '',
      isOwn: entry.senderId === myId
    });
  });
}

function sendChatMessage() {
  if (!chatInput || !chatInput.value) return;
  const rawText = String(chatInput.value).trim();
  if (!rawText) return;
  if (rawText.length > CHAT_MAX_LENGTH) {
    alert(`A mensagem deve ter no máximo ${CHAT_MAX_LENGTH} caracteres.`);
    return;
  }
  socket.emit('chat-message', { text: rawText }, (res) => {
    if (!res || !res.success) {
      alert(res?.message || 'Falha ao enviar mensagem.');
      return;
    }
    chatInput.value = '';
  });
}

let chatPreviewTimeout = null;

function showChatPreview(text) {
  if (!chatPreview) return;
  chatPreview.textContent = '';
  const title = document.createElement('strong');
  title.textContent = 'Nova mensagem';
  const messageSpan = document.createElement('span');
  messageSpan.textContent = text;
  chatPreview.appendChild(title);
  chatPreview.appendChild(messageSpan);
  chatPreview.classList.remove('hidden');
  chatPreview.classList.add('show');
  clearTimeout(chatPreviewTimeout);
  chatPreviewTimeout = setTimeout(() => {
    if (chatPreview) {
      chatPreview.classList.remove('show');
      chatPreview.classList.add('hidden');
    }
  }, 4200);
}

function hideChatPreview() {
  if (!chatPreview) return;
  chatPreview.classList.remove('show');
  chatPreview.classList.add('hidden');
  clearTimeout(chatPreviewTimeout);
}

function requestSecurityQuestion() {
  const username = forgotUsernameInput?.value?.trim();
  if (!username) {
    showForgotPasswordMessage('Informe o nome de usuário para buscar a pergunta.');
    return;
  }
  socket.emit('request-security-question', { username }, (res) => {
    if (res && res.success && res.question) {
      if (securityQuestionText) securityQuestionText.textContent = res.question;
      if (securityQuestionBlock) securityQuestionBlock.classList.remove('hidden');
      if (securityAnswerRow) securityAnswerRow.classList.remove('hidden');
      if (resetPasswordFields) resetPasswordFields.classList.remove('hidden');
      showForgotPasswordMessage('Responda à pergunta para redefinir a senha.', false);
    } else {
      showForgotPasswordMessage(res?.message || 'Não foi possível buscar a pergunta.');
    }
  });
}

function resetPassword() {
  const username = forgotUsernameInput?.value?.trim();
  const securityAnswer = securityAnswerInput?.value?.trim() || '';
  const newPassword = forgotNewPasswordInput?.value || '';
  const confirmPassword = forgotConfirmPasswordInput?.value || '';

  if (!username || !securityAnswer || !newPassword || !confirmPassword) {
    showForgotPasswordMessage('Preencha todos os campos para redefinir a senha.');
    return;
  }

  if (newPassword !== confirmPassword) {
    showForgotPasswordMessage('A nova senha e a confirmação não coincidem.');
    return;
  }

  if (newPassword.length < 6) {
    showForgotPasswordMessage('A nova senha deve ter pelo menos 6 caracteres.');
    return;
  }

  socket.emit('reset-password', { username, securityAnswer, newPassword }, (res) => {
    if (res && res.success) {
      showForgotPasswordMessage(res.message || 'Senha redefinida com sucesso.', false);
      clearForgotPasswordForm();
      if (forgotPasswordArea) forgotPasswordArea.classList.add('hidden');
    } else {
      showForgotPasswordMessage(res?.message || 'Falha ao redefinir senha.');
    }
  });
}

// On load, try to restore player from localStorage for auto-login
function restorePlayerFromStorage() {
  const stored = localStorage.getItem(PLAYER_DATA_KEY);
  if (!stored) return false;

  try {
    const player = JSON.parse(stored);
    if (!player || !player.username) {
      localStorage.removeItem(PLAYER_DATA_KEY);
      return false;
    }

    window.player = player;
    window.isLoggedIn = true;
    if (authUsernameInput) authUsernameInput.value = player.username;
    if (playerNameInput) playerNameInput.value = player.username;
    if (playerUsername) {
      playerUsername.textContent = `👤 ${player.username} (${player.wins || 0}V - ${player.losses || 0}D)`;
    }
    hideAuth();
    showLobbyTab();
    return true;
  } catch (e) {
    console.error('Falha ao restaurar dados do jogador:', e);
    localStorage.removeItem(PLAYER_DATA_KEY);
    return false;
  }
}

function savePlayerToStorage(player) {
  if (player && player.username) {
    const storedPlayer = {
      id: player.id,
      username: player.username,
      wins: player.wins || 0,
      losses: player.losses || 0,
      matches: player.matches || 0,
      securityConfigured: Boolean(player.securityConfigured),
    };
    localStorage.setItem(PLAYER_DATA_KEY, JSON.stringify(storedPlayer));
  }
}

function clearPlayerStorage() {
  localStorage.removeItem(PLAYER_DATA_KEY);
}

// On load, require authentication
if (!restorePlayerFromStorage()) {
  showAuth();
  setGuestMode(false);
} else {
  sessionRestoredFromStorage = true;
  hideAuth();
  setGuestMode(false);
  showLobbyTab();
}

// Novo botão para encerrar partida
let endGameBtn = document.getElementById('endGameBtn');
if (!endGameBtn) {
  endGameBtn = document.createElement('button');
  endGameBtn.id = 'endGameBtn';
  endGameBtn.textContent = 'Encerrar Partida';
  endGameBtn.className = 'hidden';
  resetBtn.parentNode.insertBefore(endGameBtn, resetBtn);
}

endGameBtn.addEventListener('click', () => {
  showEndGameModal();
});

function atualizarListaMesas() {
  socket.emit('list-rooms', (rooms) => {
    mesaSelect.innerHTML = '';
    rooms.forEach((room) => {
      const option = document.createElement('option');
      option.value = room.id;
      let status = '';
      if (room.started) {
        status = ` - Em jogo`;
        if (room.waiting > 0) {
          status += ` (${room.waiting} aguardando)`;
        }
      }
      option.textContent = `${room.name} (${room.players}/${room.maxPlayers})${status}`;
      option.disabled = !room.started && (room.started || room.players >= room.maxPlayers);
      mesaSelect.appendChild(option);
    });
    if (!mesaSelect.value && mesaSelect.options.length > 0) {
      mesaSelect.selectedIndex = 0;
    }
  });
}

let myId = null;
let meuNome = '';
let meuHand = [];
let currentState = null;
let cartaSelecionada = null;
let discarding = false;
let selectedForMeld = new Set();
let selectedForMeldCards = new Set();
let detectedMelds = [];
let localStatusMessage = '';
let currentMeldHighlight = -1;
let initialDealAnimationPlayed = false;

const CARD_BACK_FILENAME = '1780335294916.png';

function getCardValueName(valor) {
  const map = {
    A: 'ace',
    J: 'jack',
    Q: 'queen',
    K: 'king',
  };
  return map[valor] || valor;
}

function getCardSuitFolder(naipe) {
  const map = {
    '♣': 'clubs',
    '♦': 'diamonds',
    '♥': 'hearts',
    '♠': 'spades',
  };
  return map[naipe] || '';
}

function getCardSvgPath(card) {
  if (!card) return '';
  if (card === 'back') {
    return `/assets/cards/back/${CARD_BACK_FILENAME}`;
  }

  const parsed = parseCartaClient(card);
  const folder = getCardSuitFolder(parsed.naipe);
  if (!folder || parsed.valor === '') return '';

  const valueName = getCardValueName(parsed.valor);
  return `/assets/cards/${folder}/${valueName}_of_${folder}.svg`;
}

function createCardImageElement(carta, altText) {
  const img = document.createElement('img');
  img.classList.add('carta-img');
  img.src = getCardSvgPath(carta);
  img.alt = altText || String(carta);
  img.loading = 'lazy';
  img.onerror = () => {
    img.style.display = 'none';
  };
  return img;
}

function criarCartaElemento(carta, indexOrOnClick, onClick, faceDown = false) {
  let index = null;
  if (typeof indexOrOnClick === 'function') {
    onClick = indexOrOnClick;
  } else {
    index = indexOrOnClick;
  }

  const div = document.createElement('div');
  div.classList.add('carta');
  div.dataset.card = String(carta);
  div.draggable = true;
  div.appendChild(createCardImageElement(faceDown ? 'back' : carta, String(carta)));

  if (carta === cartaSelecionada && selectedForMeld.size === 0) {
    div.classList.add('selecionada');
  }
  if (index !== null && selectedForMeld.has(index)) div.classList.add('selecionada-meld');
  if (typeof onClick === 'function') {
    div.addEventListener('click', (e) => onClick(carta, index, e));
  }
  return div;
}

function criarMeldElemento(meld, index) {
  const box = document.createElement('div');
  box.classList.add('conjunto');
  box.dataset.meldIndex = index;

  const header = document.createElement('div');
  header.classList.add('conjunto-header');
  const title = document.createElement('span');
  title.textContent = `Conjunto ${index + 1}`;
  header.appendChild(title);

  if (meld.length >= 3) {
    const voltarTodas = document.createElement('button');
    voltarTodas.type = 'button';
    voltarTodas.classList.add('retornar-todas');
    voltarTodas.textContent = 'Voltar todas';
    voltarTodas.title = 'Voltar todas as cartas para a mão';
    voltarTodas.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      returnMeldAll(index);
    });
    header.appendChild(voltarTodas);
  }

  box.appendChild(header);

  const row = document.createElement('div');
  row.classList.add('conjunto-cards');
  meld.forEach((carta) => {
    const cartaEl = criarCartaElemento(carta, () => {});
    cartaEl.classList.add('carta-meld');
    if (meld.length > 3) {
      const remover = document.createElement('button');
      remover.type = 'button';
      remover.classList.add('retornar-carta');
      remover.textContent = '↶';
      remover.title = 'Retornar carta à mão';
      remover.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        returnCardFromMeld(index, carta);
      });
      cartaEl.appendChild(remover);
    }
    row.appendChild(cartaEl);
  });
  box.appendChild(row);

  return box;
}

function animateDeckToHandDraw(previousState, state) {
  const isInitialDeal = (!previousState && state.started && state.myHand && state.myHand.length > 0) || (previousState && !previousState.started && state.started);
  const isNewDraw = previousState && previousState.myHand && state.myHand.length > previousState.myHand.length && state.currentTurnPlayerId === myId && state.currentPlayerHasDrawn && !previousState.currentPlayerHasDrawn;
  if (!isNewDraw || isInitialDeal) return;

  const isDiscardDraw = previousState && state.discardTop !== previousState.discardTop && state.currentPlayerHasDrawn && !previousState.currentPlayerHasDrawn;
  const sourceContainer = isDiscardDraw ? descarteDiv : baralhoDiv;
  const sourceCard = sourceContainer.querySelector('.carta');
  const handCards = maoDiv.querySelectorAll('.carta');
  if (!sourceCard || handCards.length === 0) return;

  const targetCard = handCards[handCards.length - 1];
  const sourceRect = sourceCard.getBoundingClientRect();
  const targetRect = targetCard.getBoundingClientRect();
  if (sourceRect.width === 0 || targetRect.width === 0) return;

  const flyCard = document.createElement('div');
  flyCard.classList.add('carta', 'carta-fly');
  if (isDiscardDraw) flyCard.classList.add('carta-fly-discard');
  flyCard.style.position = 'fixed';
  flyCard.style.top = `${sourceRect.top}px`;
  flyCard.style.left = `${sourceRect.left}px`;
  flyCard.style.width = `${sourceRect.width}px`;
  flyCard.style.height = `${sourceRect.height}px`;
  flyCard.style.margin = '0';
  flyCard.style.transform = 'translate(0, 0) scale(1)';
  flyCard.style.transition = 'transform 0.42s ease, opacity 0.42s ease';
  flyCard.style.pointerEvents = 'none';
  flyCard.style.zIndex = '2500';
  flyCard.appendChild(createCardImageElement('back', 'Verso da carta'));
  document.body.appendChild(flyCard);

  requestAnimationFrame(() => {
    const deltaX = targetRect.left - sourceRect.left;
    const deltaY = targetRect.top - sourceRect.top;
    const scale = targetRect.width / sourceRect.width;
    flyCard.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scale})`;
    flyCard.style.opacity = '0.15';
  });

  const cleanupFlyCard = () => {
    if (flyCard.parentElement) {
      flyCard.remove();
    }
  };

  flyCard.addEventListener('transitionend', cleanupFlyCard, { once: true });
  setTimeout(cleanupFlyCard, 600);
}

function animateInitialDealFromDeck() {
  const deckCard = baralhoDiv.querySelector('.carta');
  const handCards = Array.from(maoDiv.querySelectorAll('.carta-inicial'));
  if (!deckCard || handCards.length === 0) return;

  tocarSom(somMover);

  const deckRect = deckCard.getBoundingClientRect();
  const moveDuration = 400;
  const revealDelay = 90;

  handCards.forEach((card, index) => {
    const targetRect = card.getBoundingClientRect();
    if (targetRect.width === 0 || targetRect.height === 0) return;

    const deltaX = deckRect.left - targetRect.left;
    const deltaY = deckRect.top - targetRect.top;
    const scale = deckRect.width / targetRect.width;
    const delay = index * revealDelay;

    card.style.transition = 'none';
    card.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scale})`;
    card.style.opacity = '0';
    card.style.visibility = 'visible';
    card.style.willChange = 'transform, opacity';

    const revealStart = delay + moveDuration;
    setTimeout(() => {
      const img = card.querySelector('img.carta-img');
      card.style.transition = 'transform 220ms ease, opacity 220ms ease';
      card.style.transform = 'translate(0, 0) scale(1) rotateY(90deg)';
      card.style.opacity = '0.4';

      setTimeout(() => {
        if (img) img.src = getCardSvgPath(card.dataset.card);
        card.style.transform = 'translate(0, 0) scale(1) rotateY(0deg)';
        card.style.opacity = '1';
      }, 220);
    }, revealStart);

    setTimeout(() => {
      card.style.transition = '';
      card.style.willChange = '';
      card.style.transform = '';
      card.style.opacity = '';
      card.style.visibility = '';
      card.classList.remove('carta-inicial');
    }, revealStart + 420);
  });

  requestAnimationFrame(() => {
    handCards.forEach((card, index) => {
      const delay = index * revealDelay;
      card.style.transition = `transform ${moveDuration}ms ease ${delay}ms, opacity ${moveDuration}ms ease ${delay}ms`;
      card.style.transform = 'translate(0, 0) scale(1)';
      card.style.opacity = '1';
    });
  });
}

function animateHandToDiscard(index) {
  const handCards = maoDiv.querySelectorAll('.carta');
  const sourceCard = handCards[index];
  if (!sourceCard || !descarteDiv) return;

  const sourceRect = sourceCard.getBoundingClientRect();
  const targetRect = descarteDiv.getBoundingClientRect();
  if (sourceRect.width === 0 || targetRect.width === 0) return;

  const flyCard = sourceCard.cloneNode(true);
  flyCard.classList.add('carta-fly', 'carta-fly-discard');
  flyCard.style.position = 'fixed';
  flyCard.style.top = `${sourceRect.top}px`;
  flyCard.style.left = `${sourceRect.left}px`;
  flyCard.style.width = `${sourceRect.width}px`;
  flyCard.style.height = `${sourceRect.height}px`;
  flyCard.style.margin = '0';
  flyCard.style.transform = 'translate(0, 0) scale(1) rotate(0deg)';
  flyCard.style.transition = 'transform 0.38s ease, opacity 0.30s ease';
  flyCard.style.pointerEvents = 'none';
  flyCard.style.zIndex = '2500';
  document.body.appendChild(flyCard);

  requestAnimationFrame(() => {
    const deltaX = targetRect.left + targetRect.width / 2 - (sourceRect.left + sourceRect.width / 2);
    const deltaY = targetRect.top + targetRect.height / 2 - (sourceRect.top + sourceRect.height / 2);
    const scale = Math.min(targetRect.width / sourceRect.width, targetRect.height / sourceRect.height, 1);
    flyCard.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scale}) rotate(6deg)`;
    flyCard.style.opacity = '0';
  });

  const cleanupFlyCard = () => {
    if (flyCard.parentElement) {
      flyCard.remove();
    }
  };

  flyCard.addEventListener('transitionend', cleanupFlyCard, { once: true });
  setTimeout(cleanupFlyCard, 600);
}

function atualizaUI(state, previousState) {
  if (!state.started) {
    initialDealAnimationPlayed = false;
  }
  currentState = state;
  jogadorInfo.textContent = `${state.roomName || 'Mesa'} • Sua mão: ${state.myHand.length} cartas`;

  statusDiv.classList.remove('vitoria', 'normal', 'bot-turn', 'seu-turno');

  if (state.privateMessage) {
    statusDiv.textContent = state.privateMessage;
  } else if (localStatusMessage) {
    statusDiv.textContent = localStatusMessage;
  } else if (state.winner || (state.finishedPlayers && state.finishedPlayers.length > 0)) {
    statusDiv.textContent = state.message || 'Fim de jogo';
    statusDiv.classList.add('vitoria');
  } else if (state.started) {
    const currentPlayer = state.players.find((p) => p.id === state.currentTurnPlayerId);
    if (currentPlayer) {
      const isMyTurn = state.currentTurnPlayerId === myId;
      const isBotTurn = currentPlayer.name.startsWith('Lulu-bot');
      if (isMyTurn) {
        statusDiv.textContent = 'Sua vez';
        statusDiv.classList.add('seu-turno');
      } else {
        const indicator = isBotTurn ? '🤖 ' : '';
        statusDiv.textContent = `${indicator}Vez de ${currentPlayer.name}`;
        if (isBotTurn) {
          statusDiv.classList.add('bot-turn');
        }
      }
    } else {
      statusDiv.textContent = state.message || 'Aguardando...';
    }
    statusDiv.classList.add('normal');
  } else {
    statusDiv.textContent = state.message || 'Aguardando...';
    statusDiv.classList.add('normal');
  }

  const isLobbyMode = !state.started && !state.isWaiting;
  const isWaitingMode = state.started && state.isWaiting;
  if (isLobbyMode) {
    hideGamePanels();
    renderLobbyPanel(state);
    return;
  }
  if (isWaitingMode) {
    hideGamePanels();
    renderWaitingPanel(state);
    return;
  }

  if (lobbyPanel) lobbyPanel.classList.add('hidden');
  if (waitingPanel) waitingPanel.classList.add('hidden');
  if (roomExitBtn) roomExitBtn.classList.add('hidden');
  showGamePanels();

  playersArea.innerHTML = '';
  state.players.forEach((player) => {
    const card = document.createElement('div');
    card.classList.add('player-card');
    if (player.id === state.currentTurnPlayerId) card.classList.add('current');
    if (player.id === myId) card.classList.add('meu-jogador');
    if (player.finished) card.classList.add('finished-player');
    let inner = `<div class="player-card-header"><strong>${player.name}`;
    if (player.finished) inner += ' (Vencedor)';
    inner += `</strong><span class="player-score">${player.score || 0} vitória(s)</span></div>`;
    if (player.id === myId || !state.finishedPlayers || state.finishedPlayers.length === 0) {
      inner += `<span>Cartas: ${player.handCount}</span>`;
    }
    inner += `<span>Cadeira: ${player.seat + 1}</span>`;
    // Mostrar melds quando finalizado ou vencedor
    if ((state.winner && player.id === state.winner || player.finished) && Array.isArray(player.melds) && player.melds.length > 0) {
      inner += `<div style="margin-top: 6px; font-size: 0.85rem; color: rgba(255,255,255,0.8);">Conjuntos:</div>`;
      inner += player.melds
        .filter(Array.isArray)
        .map((meld) => {
          if (meld.length === 0) return '';
          return `<div class="small-hand">${meld.map((c) => `<span class="mini-carta"><img src="${getCardSvgPath(c)}" alt="${c}" loading="lazy"></span>`).join('')}</div>`;
        })
        .join('');
    }
    // Mostrar cartas da mão quando finalizado ou vencedor
    if ((state.winner && player.id === state.winner || player.finished) && Array.isArray(player.publicHand) && player.publicHand.length > 0) {
      inner += `<div style="margin-top: 6px; font-size: 0.85rem; color: rgba(255,255,255,0.8);">Mão:</div>`;
      inner += `<div class="small-hand">${player.publicHand.map((c) => `<span class="mini-carta"><img src="${getCardSvgPath(c)}" alt="${c}" loading="lazy"></span>`).join('')}</div>`;
    }
    card.innerHTML = inner;
    playersArea.appendChild(card);
  });

  baralhoDiv.innerHTML = '';
  const baralhoCarta = document.createElement('div');
  baralhoCarta.classList.add('carta');
  if (!state.started) {
    baralhoCarta.style.cursor = 'default';
  } else if (state.deckCount > 0) {
    baralhoCarta.appendChild(createCardImageElement('back', 'Verso da carta'));
    baralhoCarta.style.cursor = 'pointer';
  } else {
    baralhoCarta.textContent = '0';
    baralhoCarta.style.cursor = 'default';
  }
  baralhoDiv.appendChild(baralhoCarta);

  descarteDiv.innerHTML = '';
  if (state.discardTop) {
    descarteDiv.appendChild(criarCartaElemento(state.discardTop, () => {}));
  }

  maoDiv.innerHTML = '';
  const actualPreviousState = previousState ?? currentState;
  const isInitialDeal = !initialDealAnimationPlayed && state.started && state.myHand && state.myHand.length > 0 && ((!actualPreviousState && !currentState) || (actualPreviousState && !actualPreviousState.started && state.started));
  const isNewDraw = actualPreviousState && actualPreviousState.myHand && state.myHand.length > actualPreviousState.myHand.length && state.currentTurnPlayerId === myId && state.currentPlayerHasDrawn && !actualPreviousState.currentPlayerHasDrawn;
  state.myHand.forEach((carta, index) => {
    const cartaEl = criarCartaElemento(carta, index, handleCartaClique, isInitialDeal);
    if (isInitialDeal) {
      cartaEl.classList.add('carta-inicial');
    }
    if (isNewDraw && index === state.myHand.length - 1) {
      cartaEl.classList.add('carta-comprada');
    }
    maoDiv.appendChild(cartaEl);
  });

  if (isInitialDeal) {
    animateInitialDealFromDeck();
    initialDealAnimationPlayed = true;
  }
  animateDeckToHandDraw(actualPreviousState, state);

  meldsJogadorDiv.innerHTML = '';
  const meusMelds = state.players.find((p) => p.id === myId)?.melds || [];
  if (meusMelds.length === 0) {
    const emptyMessage = document.createElement('div');
    emptyMessage.classList.add('conjunto-empty');
    emptyMessage.textContent = 'Nenhuma trinca formada ainda.';
    meldsJogadorDiv.appendChild(emptyMessage);
  } else {
    meusMelds.forEach((meld, index) => {
      meldsJogadorDiv.appendChild(criarMeldElemento(meld, index));
    });
    // if we previously had a highlighted meld index, reapply bounds
    const total = meusMelds.length;
    if (currentMeldHighlight >= total) currentMeldHighlight = -1;
    if (currentMeldHighlight !== -1) highlightMeld(currentMeldHighlight);
  }

  const myMelds = state.players.find((p) => p.id === myId)?.melds || [];
  const cardsInMyMelds = myMelds.reduce((sum, meld) => sum + (Array.isArray(meld) ? meld.length : 0), 0);
  const combinedCards = [...getCurrentPlayerMeldCards(state), ...(Array.isArray(state.myHand) ? state.myHand : [])];

  // Verifica se existe uma carta cuja remoção permite montar exatamente 3 conjuntos
  let canBatEligible = false;
  if (state.currentTurnPlayerId === myId && state.started && !state.winner) {
    for (let i = 0; i < combinedCards.length; i += 1) {
      const remaining = combinedCards.slice(0, i).concat(combinedCards.slice(i + 1));
      const assembled = montarMelds(remaining);
      if (assembled && assembled.length === 3) {
        canBatEligible = true;
        break;
      }
    }
  }

  // Botão Bater sempre visível, mas controlado por disabled
  const canBatWithoutDraw = state.currentTurnPlayerId === myId && verificarBaterClient(state.myHand);
  const canBatWithDiscard = state.currentTurnPlayerId === myId && canBatWithOneDiscard(combinedCards);
  const canBatCombined = canBatWithoutDraw || cardsInMyMelds >= 9 || canBatWithDiscard;
  if (baterBtn) baterBtn.disabled = !state.started || state.currentTurnPlayerId !== myId || state.winner || (!state.currentPlayerHasDrawn && !canBatCombined);
  startGameBtn.classList.toggle('hidden', state.hostId !== myId || state.started);

  if (resetBtn) {
    const isHost = state.hostId === myId;
    const shouldShowReset = state.winner || (state.finishedPlayers && state.finishedPlayers.length > 0) || (state.started && state.activePlayersCount === 1 && isHost);
    resetBtn.classList.toggle('hidden', !shouldShowReset);
  }

  // Mostrar botão de encerrar partida quando há opção
  if (endGameBtn) {
    const shouldShowEndGame = state.canOfferEndGame && state.started && !state.winner && state.activePlayersCount >= 1;
    endGameBtn.classList.toggle('hidden', !shouldShowEndGame);
  }
}

function hideGamePanels() {
  if (playersArea) playersArea.classList.add('hidden');
  if (topoSection) topoSection.classList.add('hidden');
  if (baralhoDiv) baralhoDiv.classList.add('hidden');
  if (descarteDiv) descarteDiv.classList.add('hidden');
  if (maoDiv) maoDiv.classList.add('hidden');
  if (infosSection) infosSection.classList.add('hidden');
  if (mesaSection) mesaSection.classList.add('hidden');
  if (meldsSection) meldsSection.classList.add('hidden');
  if (finalButtons) finalButtons.classList.add('hidden');
  if (baterBtn) baterBtn.classList.add('hidden');
}

function showGamePanels() {
  closeContactsPanel();
  if (roomArea) roomArea.classList.add('hidden');
  if (gameArea) gameArea.classList.remove('hidden');
  if (playersArea) playersArea.classList.remove('hidden');
  if (topoSection) topoSection.classList.remove('hidden');
  if (baralhoDiv) baralhoDiv.classList.remove('hidden');
  if (descarteDiv) descarteDiv.classList.remove('hidden');
  if (maoDiv) maoDiv.classList.remove('hidden');
  if (infosSection) infosSection.classList.remove('hidden');
  if (mesaSection) mesaSection.classList.remove('hidden');
  if (meldsSection) meldsSection.classList.remove('hidden');
  if (finalButtons) finalButtons.classList.remove('hidden');
  if (baterBtn) baterBtn.classList.remove('hidden');
  if (exitRoomBtn) exitRoomBtn.classList.remove('hidden');
}

function renderLobbyPanel(state) {
  closeContactsPanel();
  if (!lobbyPanel) return;
  lobbyPanel.classList.remove('hidden');
  waitingPanel?.classList.add('hidden');
  if (gameArea) gameArea.classList.add('hidden');
  if (roomArea) roomArea.classList.remove('hidden');
  if (playersArea) playersArea.classList.add('hidden');
  if (topoSection) topoSection.classList.add('hidden');
  if (baralhoDiv) baralhoDiv.classList.add('hidden');
  if (descarteDiv) descarteDiv.classList.add('hidden');
  if (maoDiv) maoDiv.classList.add('hidden');
  if (infosSection) infosSection.classList.add('hidden');
  if (chatPreview) chatPreview.classList.add('hidden');
  if (mesaSection) mesaSection.classList.add('hidden');
  if (meldsSection) meldsSection.classList.add('hidden');
  if (finalButtons) finalButtons.classList.add('hidden');
  if (baterBtn) baterBtn.classList.add('hidden');
  if (exitRoomBtn) exitRoomBtn.classList.add('hidden');
  if (roomExitBtn) roomExitBtn.classList.remove('hidden');
  if (editRoomNameBtn) editRoomNameBtn.classList.toggle('hidden', state.hostId !== myId);
  if (chatHeaderTitle) chatHeaderTitle.textContent = 'Chat da mesa';
  lobbyRoomName.textContent = state.roomName || 'Mesa';
  lobbyStatusMessage.textContent = state.started ? 'Partida em andamento' : 'Aguardando início';
  lobbyPlayerCount.textContent = `${state.players.length}`;
  lobbyMaxPlayers.textContent = `${state.maxPlayers || 6}`;
  lobbyPlayerList.innerHTML = '';

  state.players.forEach((player) => {
    const item = document.createElement('li');
    item.className = 'player-list-item';
    item.textContent = player.name;
    if (player.id === state.hostId) {
      const badge = document.createElement('span');
      badge.className = 'player-host-badge';
      badge.textContent = 'Host';
      item.appendChild(badge);
    }
    lobbyPlayerList.appendChild(item);
  });

  const isHost = state.hostId === myId;
  lobbyHelpText.textContent = isHost ? 'Você pode iniciar a partida quando estiver pronto.' : 'Somente o host pode iniciar a partida.';
  lobbyStartBtn.classList.toggle('hidden', !isHost);
}

function renderWaitingPanel(state) {
  if (!waitingPanel) return;
  waitingPanel.classList.remove('hidden');
  lobbyPanel?.classList.add('hidden');
  if (gameArea) gameArea.classList.add('hidden');
  if (roomArea) roomArea.classList.remove('hidden');
  if (playersArea) playersArea.classList.add('hidden');
  if (topoSection) topoSection.classList.add('hidden');
  if (baralhoDiv) baralhoDiv.classList.add('hidden');
  if (descarteDiv) descarteDiv.classList.add('hidden');
  if (maoDiv) maoDiv.classList.add('hidden');
  if (infosSection) infosSection.classList.add('hidden');
  if (chatPreview) chatPreview.classList.add('hidden');
  if (mesaSection) mesaSection.classList.add('hidden');
  if (meldsSection) meldsSection.classList.add('hidden');
  if (finalButtons) finalButtons.classList.add('hidden');
  if (baterBtn) baterBtn.classList.add('hidden');
  if (exitRoomBtn) exitRoomBtn.classList.add('hidden');
  if (roomExitBtn) roomExitBtn.classList.remove('hidden');
  if (editWaitingRoomNameBtn) editWaitingRoomNameBtn.classList.toggle('hidden', state.hostId !== myId);
  if (chatHeaderTitle) chatHeaderTitle.textContent = 'Chat da mesa';

  waitingRoomName.textContent = state.roomName || 'Mesa';
  if (waitingStatusText) {
    waitingStatusText.textContent = state.isWaiting ? 'Partida em andamento' : 'Aguardando a próxima rodada';
  }
  waitingCount.textContent = `${state.waitingPlayers.length}`;
  waitingPosition.textContent = state.waitingPosition ? `#${state.waitingPosition}` : '#-';
  waitingPlayerList.innerHTML = '';

  state.waitingPlayers.forEach((player, index) => {
    const item = document.createElement('li');
    item.className = 'player-list-item';
    item.textContent = player.id === myId ? `${index + 1}. Você` : `${index + 1}. ${player.name}`;
    waitingPlayerList.appendChild(item);
  });
}

if (lobbyStartBtn) {
  lobbyStartBtn.addEventListener('click', () => {
    socket.emit('start-game');
  });
}

if (editRoomNameBtn) {
  editRoomNameBtn.addEventListener('click', () => {
    showEditRoomNameModal();
  });
}
if (editWaitingRoomNameBtn) {
  editWaitingRoomNameBtn.addEventListener('click', () => {
    showEditRoomNameModal();
  });
}

function showEditRoomNameModal() {
  const existingModal = document.getElementById('editRoomNameModal');
  if (existingModal) {
    existingModal.remove();
  }

  const modal = document.createElement('div');
  modal.id = 'editRoomNameModal';
  modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.65); display: flex; justify-content: center; align-items: center; z-index: 10000;`;

  const content = document.createElement('div');
  content.style.cssText = `background: #0f1d37; color: #fff; padding: 24px; border-radius: 16px; width: min(420px, calc(100% - 32px)); max-width: 420px; box-sizing: border-box; box-shadow: 0 10px 30px rgba(0,0,0,0.35);`;
  const currentName = currentState?.roomName || lobbyRoomName?.textContent || waitingRoomName?.textContent || '';
  content.innerHTML = `
    <h2 style="margin:0 0 12px;">Editar nome da mesa</h2>
    <p style="margin:0 0 16px; opacity:0.8;">Somente o host pode alterar o nome da mesa.</p>
    <input id="newRoomNameInput" type="text" maxlength="32" style="width:100%; padding:12px; border-radius:10px; border:1px solid #27406c; background:#07122b; color:#fff; margin-bottom:16px; box-sizing:border-box;" value="${currentName.replace(/"/g, '')}" />
    <div style="display:flex; gap:12px; justify-content:flex-end;">
      <button id="cancelRoomNameBtn" class="botao-acao pequena" type="button" style="background:#4d5c82;">Cancelar</button>
      <button id="saveRoomNameBtn" class="botao-acao pequena" type="button">Salvar</button>
    </div>
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  const input = document.getElementById('newRoomNameInput');
  input?.focus();

  const errorMessage = document.createElement('div');
  errorMessage.id = 'editRoomNameError';
  errorMessage.style.cssText = 'color:#ff6b6b; margin-top:8px; font-size:0.95rem; min-height:20px;';
  content.appendChild(errorMessage);

  const closeModal = () => {
    modal.remove();
  };

  const handleSaveRoomName = () => {
    const newName = input?.value?.trim();
    if (!newName) {
      errorMessage.textContent = 'Informe um nome válido para a mesa.';
      return;
    }
    if (!socket || socket.disconnected) {
      errorMessage.textContent = 'Sem conexão com o servidor. Recarregue a página e tente novamente.';
      return;
    }
    errorMessage.textContent = '';

    socket.emit('edit-room-name', newName, (res) => {
      if (!res || !res.success) {
        errorMessage.textContent = res?.message || 'Falha ao renomear a mesa.';
        console.warn('edit-room-name failed', res);
        return;
      }
      closeModal();
    });
  };

  document.getElementById('cancelRoomNameBtn')?.addEventListener('click', closeModal);
  document.getElementById('saveRoomNameBtn')?.addEventListener('click', handleSaveRoomName);

  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSaveRoomName();
    }
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });
}

function highlightMeld(index) {
  // remove existing highlights
  const boxes = Array.from(meldsJogadorDiv.querySelectorAll('.conjunto'));
  boxes.forEach((b) => b.classList.remove('conjunto-highlight'));
  if (!boxes.length) return;
  const target = boxes.find((b) => Number(b.dataset.meldIndex) === index) || boxes[0];
  if (target) {
    target.classList.add('conjunto-highlight');
    currentMeldHighlight = Number(target.dataset.meldIndex);
  }
}

function showEndGameModal() {
  // Criar modal se não existir
  let modal = document.getElementById('endGameModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'endGameModal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
      background: white;
      padding: 30px;
      border-radius: 10px;
      text-align: center;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      max-width: 400px;
    `;
    
    content.innerHTML = `
      <h2 style="margin: 0 0 20px 0; color: #333;">Encerrar Partida?</h2>
      <p style="margin: 0 0 20px 0; color: #666; font-size: 16px;">
        Restam ${currentState?.activeCount || '?'} jogadores. 
        <br><br>
        Deseja encerrar a partida ou continuar jogando?
      </p>
      <div style="display: flex; gap: 10px; justify-content: center;">
        <button id="endGameYes" style="padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">
          Encerrar
        </button>
        <button id="endGameNo" style="padding: 10px 20px; background: #2196F3; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">
          Continuar
        </button>
      </div>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
    
    // Handlers dos botões
    document.getElementById('endGameYes').addEventListener('click', () => {
      tocarSom(somClique);
      socket.emit('end-game-confirm', true);
      modal.remove();
    });
    
    document.getElementById('endGameNo').addEventListener('click', () => {
      tocarSom(somClique);
      socket.emit('end-game-confirm', false);
      modal.remove();
    });
  } else {
    modal.style.display = 'flex';
  }
}


function toggleMeldSelection(index) {
  if (selectedForMeld.has(index)) {
    selectedForMeld.delete(index);
    const label = meuHand[index];
    if (label) selectedForMeldCards.delete(label);
  } else {
    selectedForMeld.add(index);
    const label = meuHand[index];
    if (label) selectedForMeldCards.add(label);
  }
  localStatusMessage = selectedForMeld.size > 0 ? `Selecionadas ${selectedForMeld.size} carta(s) para meld.` : '';
  atualizaUI(currentState);
}

function handleCartaClique(carta, index, e) {
  if (!currentState || !currentState.started) return;

  tocarSom(somClique);

  if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
    toggleMeldSelection(index);
    return;
  }

  if (currentState.currentTurnPlayerId !== myId || !currentState.currentPlayerHasDrawn) {
    toggleMeldSelection(index);
    return;
  }

  if (cartaSelecionada === carta) {
    animateHandToDiscard(index);
    if (window.isGuest) {
      sendAction('discard-card', carta, (res) => {
        if (res && res.success) {
          tocarSom(somDescartar);
          cartaSelecionada = null;
          localStatusMessage = '';
        }
      });
    } else {
      socket.emit('discard-card', carta);
      tocarSom(somDescartar);
      cartaSelecionada = null;
      localStatusMessage = '';
    }
    return;
  }

  cartaSelecionada = carta;
  localStatusMessage = 'Clique novamente na carta selecionada para descartar.';
  atualizaUI(currentState);
}

function parseCartaClient(carta) {
  const s = String(carta).trim();
  const naipe = s.slice(-1);
  const valor = s.slice(0, -1);
  const valores = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return { valor, naipe, label: carta, index: valores.indexOf(valor) };
}

function validarMeldClient(cards) {
  if (!Array.isArray(cards) || cards.length < 3) return false;
  if (new Set(cards).size !== cards.length) return false;
  const parsed = cards.map(parseCartaClient);
  const sameRank = parsed.every((c) => c.valor === parsed[0].valor);
  if (sameRank) return true;
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

function verificarBaterClient(hand) {
  // Reimplementação que reaproveita a lógica de montagem de melds.
  const montagem = montarMelds(hand);
  return Boolean(montagem);
}

function montarMelds(hand) {
  if (!Array.isArray(hand)) return null;
  const parsed = hand.map(parseCartaClient);
  const naipes = ['♠', '♥', '♦', '♣'];
  const ordered = [...parsed].sort((a, b) => {
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

        for (let i = 1; i < slice.length; i++) {
          if (slice[i] !== slice[i - 1] + 1) {
            valido = false;
            break;
          }
        }

        if (!valido && slice.length === 3) {
          const sorted = slice.slice().sort((a, b) => a - b);
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

  return recusar(ordered);
}

function getCurrentPlayerMeldCards(state) {
  const player = state.players.find((p) => p.id === myId);
  if (!player || !Array.isArray(player.melds)) return [];
  return player.melds.flat().filter(Boolean);
}

function canBatWithOneDiscard(cards) {
  if (!Array.isArray(cards) || cards.length < 4) return false;
  for (let i = 0; i < cards.length; i++) {
    const remaining = cards.slice(0, i).concat(cards.slice(i + 1));
    if (verificarBaterClient(remaining)) {
      return true;
    }
  }
  return false;
}

function detectarMeldsNaMao() {
  const hand = [...meuHand];
  const encontrados = [];

  // trincas por valor
  const byValue = {};
  hand.forEach((c, index) => {
    const p = parseCartaClient(c);
    byValue[p.valor] = byValue[p.valor] || [];
    byValue[p.valor].push(index);
  });
  Object.values(byValue).forEach((arr) => {
    if (arr.length >= 3) {
      encontrados.push(arr.slice(0));
    }
  });

  // sequências por naipe
  const bySuit = {};
  hand.forEach((c, index) => {
    const p = parseCartaClient(c);
    bySuit[p.naipe] = bySuit[p.naipe] || [];
    bySuit[p.naipe].push({ handIndex: index, cardIndex: p.index });
  });
  Object.values(bySuit).forEach((arr) => {
    arr.sort((a, b) => a.cardIndex - b.cardIndex);
    let run = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].cardIndex === arr[i - 1].cardIndex + 1) {
        run.push(arr[i]);
      } else {
        if (run.length >= 3) encontrados.push(run.map((r) => r.handIndex));
        run = [arr[i]];
      }
    }
    if (run.length >= 3) encontrados.push(run.map((r) => r.handIndex));
  });

  // remove overlapping by preferring trincas then sequences
  const used = new Set();
  const final = [];
  encontrados.forEach((meld) => {
    const anyUsed = meld.some((idx) => used.has(idx));
    if (!anyUsed) {
      meld.forEach((idx) => used.add(idx));
      final.push(meld);
    }
  });

  detectedMelds = final;
  selectedForMeld.clear();
  selectedForMeldCards.clear();
  final.forEach((meld) => meld.forEach((idx) => {
    selectedForMeld.add(idx);
    const label = meuHand[idx];
    if (label) selectedForMeldCards.add(label);
  }));
  atualizaUI(currentState);
  statusDiv.textContent = final.length > 0 ? `Detectados ${final.length} conjunto(s).` : 'Nenhum conjunto detectado.';
  return final;
}

function autoDeclararMelds() {
  if (selectedForMeld.size > 0) {
    const cardsFromLabels = Array.from(selectedForMeldCards);
    let cards = cardsFromLabels.length > 0 ? cardsFromLabels.slice() : Array.from(selectedForMeld).sort((a, b) => a - b).map((idx) => meuHand[idx]);
    if (cards.some((c) => c === undefined)) {
      selectedForMeld.clear();
      selectedForMeldCards.clear();
      localStatusMessage = 'Seleção de cartas inválida. Selecione novamente o conjunto.';
      atualizaUI(currentState);
      return;
    }
    if (!validarMeldClient(cards)) {
      localStatusMessage = 'Seleção inválida para conjunto. Use trinca ou sequência.';
      atualizaUI(currentState);
      return;
    }
    const isMyTurn = currentState && currentState.currentTurnPlayerId === myId;
    if (isMyTurn) {
      if (window.isGuest) {
        sendAction('declare-meld', cards, (res) => {
          if (res && res.success) {
            selectedForMeld.clear();
            selectedForMeldCards.clear();
            localStatusMessage = 'Enviando conjunto selecionado...';
            atualizaUI(currentState);
          }
        });
        return;
      }
      socket.emit('declare-meld', cards);
      selectedForMeld.clear();
      selectedForMeldCards.clear();
      localStatusMessage = 'Enviando conjunto selecionado...';
      atualizaUI(currentState);
      return;
    }
    return;
  }

  const melds = detectedMelds.length > 0 ? detectedMelds : detectarMeldsNaMao();
  if (melds.length === 0) {
    localStatusMessage = 'Nenhum conjunto para declarar.';
    atualizaUI(currentState);
    return;
  }
  melds.forEach((meld) => {
    const cards = meld.sort((a, b) => a - b).map((idx) => meuHand[idx]);
    if (window.isGuest) {
      sendAction('declare-meld', cards, () => {});
    } else {
      socket.emit('declare-meld', cards);
    }
  });
  tocarSom(somDeclarar);
  selectedForMeld.clear();
  detectedMelds = [];
  localStatusMessage = 'Enviando conjuntos detectados...';
  atualizaUI(currentState);
}

function returnCardFromMeld(meldIndex, carta) {
  if (window.isGuest) {
    sendAction('return-meld-card', { meldIndex, card: carta });
    return;
  }
  socket.emit('return-meld-card', { meldIndex, card: carta });
}

function returnMeldAll(meldIndex) {
  if (window.isGuest) {
    sendAction('return-meld-all', { meldIndex });
    return;
  }
  socket.emit('return-meld-all', { meldIndex });
}

function reordenarMao(oldIndex, newIndex) {
  if (oldIndex === newIndex) return;
  const carta = meuHand.splice(oldIndex, 1)[0];
  meuHand.splice(newIndex, 0, carta);
  atualizaUI({ ...currentState, myHand: meuHand });
}

function habilitaArea() {
  closeContactsPanel();
  joinArea.classList.add('hidden');
  if (sharedRoomControls) sharedRoomControls.classList.remove('hidden');
}

function saveReconnectInfo(roomId, playerName) {
  window.currentRoom = roomId;
  if (!window.isGuest && roomId !== 'offline-bot-room') {
    localStorage.setItem(LAST_ROOM_KEY, roomId);
    localStorage.setItem(LAST_NAME_KEY, playerName);
  }
}

function clearReconnectInfo() {
  window.currentRoom = null;
  localStorage.removeItem(LAST_ROOM_KEY);
  localStorage.removeItem(LAST_NAME_KEY);
}

function desabilitaArea() {
  if (gameArea) gameArea.classList.add('hidden');
  if (roomArea) roomArea.classList.add('hidden');
  if (sharedRoomControls) sharedRoomControls.classList.add('hidden');
  joinArea.classList.remove('hidden');
  myId = null;
  meuNome = '';
  meuHand = [];
  currentState = null;
  cartaSelecionada = null;
  selectedForMeld.clear();
  selectedForMeldCards.clear();
  detectedMelds = [];
  localStatusMessage = '';
  atualizarListaMesas();
}

function preservarOrdemDaMao(oldHand, newHand) {
  const positions = new Map();
  oldHand.forEach((carta, index) => {
    if (!positions.has(carta)) positions.set(carta, []);
    positions.get(carta).push(index);
  });

  return newHand
    .map((carta) => ({
      carta,
      originalIndex: (positions.get(carta) && positions.get(carta).length > 0) ? positions.get(carta).shift() : Infinity
    }))
    .sort((a, b) => {
      if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
      return a.carta.localeCompare(b.carta, 'pt-BR', { numeric: true });
    })
    .map((item) => item.carta);
}

function remapSelectedMeldIndices(oldHand, newHand) {
  const selectedCards = Array.from(selectedForMeld)
    .map((index) => oldHand[index])
    .filter((card) => card !== undefined);

  if (selectedCards.length !== selectedForMeld.size) {
    selectedForMeld.clear();
    selectedForMeldCards.clear();
    return;
  }

  const indexByCard = new Map();
  newHand.forEach((card, index) => {
    if (!indexByCard.has(card)) indexByCard.set(card, []);
    indexByCard.get(card).push(index);
  });

  const newSelection = new Set();
  selectedCards.forEach((card) => {
    const indices = indexByCard.get(card) || [];
    const available = indices.find((idx) => !newSelection.has(idx));
    if (available === undefined) {
      selectedForMeld.clear();
      selectedForMeldCards.clear();
    } else {
      newSelection.add(available);
    }
  });

  if (newSelection.size !== selectedCards.length) {
    selectedForMeld.clear();
    selectedForMeldCards.clear();
  } else {
    selectedForMeld.clear();
    selectedForMeldCards.clear();
    newSelection.forEach((index) => {
      selectedForMeld.add(index);
      const label = newHand[index];
      if (label) selectedForMeldCards.add(label);
    });
  }
}

joinBtn.addEventListener('click', () => {
  const nome = playerNameInput.value.trim();
  const roomId = mesaSelect.value;
  if (window.isGuest) {
    joinMessage.textContent = 'Faça login para jogar em mesas online. Use Jogar com Bot no modo convidado.';
    return;
  }
  if (!nome) {
    joinMessage.textContent = 'Digite seu nome.';
    return;
  }
  if (!roomId) {
    joinMessage.textContent = 'Selecione uma mesa.';
    return;
  }
  if (!socket.connected) {
    joinMessage.textContent = 'Sem conexão com o servidor. Inicie o servidor e abra pelo endereço correto.';
    return;
  }
  socket.emit('join', nome, roomId, (res) => {
    if (!res.success) {
      joinMessage.textContent = res.message;
      atualizarListaMesas();
      return;
    }
    meuNome = nome;
    saveReconnectInfo(roomId, nome);
    habilitaArea();
    joinMessage.textContent = '';
  });
});

refreshRoomsBtn.addEventListener('click', () => {
  atualizarListaMesas();
});

createRoomBtn.addEventListener('click', () => {
  if (window.isGuest) {
    joinMessage.textContent = 'Faça login para criar mesas online. Use Jogar com Bot no modo convidado.';
    return;
  }
  const nome = playerNameInput.value.trim();
  socket.emit('create-room', nome || null, (res) => {
    if (!res.success) {
      joinMessage.textContent = 'Erro ao criar mesa.';
      return;
    }
    atualizarListaMesas();
    setTimeout(() => {
      mesaSelect.value = res.roomId;
      if (nome) {
        // Auto-entrar na mesa criada se o jogador já tiver informado o nome
        socket.emit('join', nome, res.roomId, (joinRes) => {
          if (!joinRes.success) {
            joinMessage.textContent = joinRes.message || 'Erro ao entrar na mesa.';
            atualizarListaMesas();
            return;
          }
          meuNome = nome;
          saveReconnectInfo(res.roomId, nome);
          habilitaArea();
          joinMessage.textContent = '';
        });
      } else {
        joinMessage.textContent = 'Mesa criada — digite seu nome e clique em Entrar na mesa.';
      }
    }, 50);
  });
});

playBotBtn.addEventListener('click', () => {
  const nome = playerNameInput.value.trim();
  const botCount = Number(botCountSelect.value) || 2;
  if (!nome) {
    joinMessage.textContent = 'Digite seu nome.';
    return;
  }
  if (window.isGuest) {
    sendAction('create-bot-room', nome, botCount, (res) => {
      if (!res.success) {
        joinMessage.textContent = res.message || 'Erro ao criar partida com bot.';
        return;
      }
      meuNome = nome;
      saveReconnectInfo('offline-bot-room', nome);
      habilitaArea();
      joinMessage.textContent = '';
    });
    return;
  }

  if (!socket.connected) {
    joinMessage.textContent = 'Sem conexão com o servidor. Inicie o servidor e abra pelo endereço correto.';
    return;
  }

  socket.emit('create-bot-room', nome, botCount, (res) => {
    if (!res.success) {
      joinMessage.textContent = res.message || 'Erro ao criar partida com bot.';
      return;
    }
    meuNome = nome;
    saveReconnectInfo(res.roomId, nome);
    habilitaArea();
    joinMessage.textContent = '';
    atualizarListaMesas();
  });
});

baralhoDiv.addEventListener('click', () => {
  if (!currentState || !currentState.started || currentState.winner || currentState.currentTurnPlayerId !== myId || currentState.currentPlayerHasDrawn) {
    return;
  }
  if (window.isGuest) {
    sendAction('draw-card', 'deck', (res) => {
      if (res && res.success) {
        localStatusMessage = '';
        tocarSom(somComprar);
      }
    });
    return;
  }
  socket.emit('draw-card', 'deck');
  localStatusMessage = '';
  tocarSom(somComprar);
});

descarteDiv.addEventListener('click', () => {
  if (!currentState || !currentState.started || currentState.winner) {
    return;
  }
  if (currentState.currentTurnPlayerId !== myId) {
    return;
  }
  if (!currentState.currentPlayerHasDrawn && currentState.discardTop) {
    if (window.isGuest) {
      sendAction('draw-card', 'discard', (res) => {
        if (res && res.success) {
          localStatusMessage = '';
          tocarSom(somDescartar);
        }
      });
      return;
    }
    socket.emit('draw-card', 'discard');
    localStatusMessage = '';
    tocarSom(somDescartar);
  }
});

baterBtn.addEventListener('click', () => {
  if (window.isGuest) {
    sendAction('bat', (res) => {
      if (res && res.success) {
        localStatusMessage = '';
      }
    });
    return;
  }
  socket.emit('bat');
  localStatusMessage = '';
});

startGameBtn.addEventListener('click', () => {
  if (window.isGuest) {
    return;
  }
  socket.emit('start-game');
});

const handleLeaveRoom = () => {
  if (window.isGuest) {
    sendAction('leave-room', (res) => {
      desabilitaArea();
      clearReconnectInfo();
      joinMessage.textContent = 'Você saiu da mesa.';
    });
    return;
  }
  socket.emit('leave-room', () => {
    desabilitaArea();
    clearReconnectInfo();
    joinMessage.textContent = 'Você saiu da mesa.';
  });
};

if (exitRoomBtn) exitRoomBtn.addEventListener('click', handleLeaveRoom);
if (roomExitBtn) roomExitBtn.addEventListener('click', handleLeaveRoom);

const declararMeldBtn = document.getElementById('declararMeldBtn');
declararMeldBtn.addEventListener('click', () => {
  // Preferir labels coletadas durante a seleção (mais robusto contra updates do servidor)
  let cards = Array.from(selectedForMeldCards);
  if (cards.length === 0 && selectedForMeld.size > 0) {
    cards = Array.from(selectedForMeld).sort((a, b) => a - b).map((idx) => meuHand[idx]);
  }
  if (cards.some((c) => c === undefined)) {
    selectedForMeld.clear();
    selectedForMeldCards.clear();
    localStatusMessage = 'Seleção de cartas inválida. Selecione novamente o conjunto.';
    atualizaUI(currentState);
    return;
  }
  if (cards.length < 3) {
    localStatusMessage = 'Selecione pelo menos 3 cartas para declarar um conjunto.';
    atualizaUI(currentState);
    return;
  }
  if (!validarMeldClient(cards)) {
    localStatusMessage = 'Seleção inválida para conjunto. Use trinca ou sequência.';
    atualizaUI(currentState);
    return;
  }
  const isMyTurn = currentState && currentState.currentTurnPlayerId === myId;
  if (!isMyTurn) {
    localStatusMessage = 'Aguarde sua vez para declarar.';
    atualizaUI(currentState);
    return;
  }
  if (window.isGuest) {
    sendAction('declare-meld', cards, (res) => {
      if (res && res.success) {
        tocarSom(somDeclarar);
        selectedForMeld.clear();
        selectedForMeldCards.clear();
        cartaSelecionada = null;
        localStatusMessage = 'Declarando conjunto...';
        atualizaUI(currentState);
      }
    });
    return;
  }
  socket.emit('declare-meld', cards);
  tocarSom(somDeclarar);
  selectedForMeld.clear();
  selectedForMeldCards.clear();
  cartaSelecionada = null;
  localStatusMessage = 'Declarando conjunto...';
  atualizaUI(currentState);
});

const autoDeclararBtn = document.getElementById('autoDeclararBtn');
autoDeclararBtn.addEventListener('click', () => autoDeclararMelds());

new Sortable(maoDiv, {
  animation: 150,
  direction: 'horizontal',
  ghostClass: 'sortable-ghost',
  chosenClass: 'sortable-chosen',
  group: {
    name: 'mao',
    put: false,
  },
  onEnd: (evt) => {
    if (evt.to === maoDiv) {
      reordenarMao(evt.oldIndex, evt.newIndex);
    }
  }
});

new Sortable(descarteDiv, {
  animation: 150,
  ghostClass: 'sortable-ghost',
  group: {
    name: 'mao',
    pull: false,
    put: true,
  },
  onMove: () => {
    return currentState && currentState.currentTurnPlayerId === myId && currentState.started && !currentState.winner && currentState.currentPlayerHasDrawn && !discarding;
  },
  onAdd: (evt) => {
    const carta = evt.item.dataset.card || evt.item.textContent.trim();
    if (evt.from === maoDiv) {
      discarding = true;
      if (currentState) {
        currentState.currentPlayerHasDrawn = false;
        atualizaUI(currentState);
      }
    }
    if (window.isGuest) {
      sendAction('discard-card', carta, (res) => {
        if (res && res.success) {
          tocarSom(somDescartar);
          cartaSelecionada = null;
        }
      });
    } else {
      socket.emit('discard-card', carta);
      tocarSom(somDescartar);
      cartaSelecionada = null;
    }
  }
});

socket.on('state', (state) => {
  const previousState = currentState;
  const oldHand = meuHand.slice();
  discarding = false;
  myId = state.myId;
  localStatusMessage = '';
  detectedMelds = [];
  if (gameArea.classList.contains('hidden')) {
    habilitaArea();
  }
  if (meuHand.length > 0 && state.myHand && state.myHand.length > 0) {
    state.myHand = preservarOrdemDaMao(meuHand, state.myHand);
  }
  meuHand = state.myHand;
  remapSelectedMeldIndices(oldHand, meuHand);
  if (!meuHand.includes(cartaSelecionada)) cartaSelecionada = null;

  if (state.chatHistory) {
    renderChatHistory(state.chatHistory);
  }

  if (state.started && !previousState?.started && musicEnabled && !state.isBotRoom) {
    tryPlayBackgroundMusic();
  }
  if (state.currentTurnPlayerId === myId && previousState?.currentTurnPlayerId !== myId) {
    tocarSom(somSuaVez);
  }
  if (state.winner && !previousState?.winner) {
    if (state.winner === myId) {
      tocarSom(somVenceu);
    } else {
      tocarSom(somPerdeu);
    }
  }

  atualizaUI(state, previousState);
});

socket.on('player-session-restored', (player) => {
  if (!player) return;
  handleAuthSuccess(player);
});

socket.on('connect', () => {
  if (window.isGuest) {
    if (connectionStatus) connectionStatus.textContent = 'Offline: modo convidado ativo.';
    return;
  }
  if (connectionStatus) connectionStatus.textContent = 'Conectado ao servidor.';
  atualizarListaMesas();
  
  // Se a sessão foi restaurada do localStorage, pedir validação ao servidor
  if (sessionRestoredFromStorage && window.player && window.player.username) {
    sessionRestoredFromStorage = false;
    socket.emit('validate-session', window.player, (validated) => {
      if (!validated) {
        if (connectionStatus) connectionStatus.textContent = 'Sessão não válida. Efetue login.';
        showAuthMessage('Sua sessão não pôde ser verificada. Faça login novamente.', true);
        window.isLoggedIn = false;
        showAuth();
      }
    });
    return;
  }
  
  if (myId) {
    socket.emit('request-state');
    return;
  }

  const savedRoomId = localStorage.getItem(LAST_ROOM_KEY);
  const savedPlayerName = localStorage.getItem(LAST_NAME_KEY);
  if (!hasAttemptedAutoReconnect && savedRoomId && savedPlayerName) {
    hasAttemptedAutoReconnect = true;
    joinMessage.textContent = 'Tentando reconectar automaticamente...';
    socket.emit('join', savedPlayerName, savedRoomId, (res) => {
      if (!res.success) {
        joinMessage.textContent = res.message || 'Falha ao reconectar automaticamente.';
        return;
      }
      meuNome = savedPlayerName;
      habilitaArea();
      joinMessage.textContent = '';
    });
  }
});

socket.on('disconnect', () => {
  if (window.isGuest) {
    if (connectionStatus) connectionStatus.textContent = 'Offline: modo convidado ativo.';
    return;
  }
  if (connectionStatus) connectionStatus.textContent = 'Desconectado do servidor.';
});

socket.on('connect_error', (error) => {
  if (window.isGuest) {
    if (connectionStatus) connectionStatus.textContent = 'Offline: modo convidado ativo.';
  } else if (connectionStatus) {
    connectionStatus.textContent = 'Erro ao conectar ao servidor.';
  }
  console.error('Socket connect_error:', error);
});

socket.on('reconnect_attempt', (attempt) => {
  if (connectionStatus) connectionStatus.textContent = `Tentando reconectar... (${attempt})`;
});

socket.on('reconnect_failed', () => {
  if (connectionStatus) connectionStatus.textContent = 'Falha ao reconectar. Atualize a página.';
});

socket.on('update-waiting-count', (count) => {
  if (joinMessage) {
    joinMessage.textContent = `Sala de espera: ${count} jogadores aguardando.`;
  }
});

socket.on('player-joined-game', (playerName) => {
  if (joinMessage) {
    joinMessage.textContent = `${playerName} entrou no jogo! Você pode sair e reingressar.`;
  }
});

socket.on('chat-message', (payload) => {
  const { username, text, time, senderId } = payload || {};
  const isOwn = senderId === myId;
  appendChatMessage({ username, text, time: time ? new Date(time).toLocaleTimeString() : '', isOwn });
  if (!isOwn) {
    if (soundEnabled) {
      tocarSom(somNovaMensagem);
    }
    if (chatPanel && chatPanel.classList.contains('hidden') && chatToggleBtn) {
      chatToggleBtn.classList.add('new-message');
      const rawText = String(text || '').trim();
      const previewContent = rawText.length > 60 ? `${rawText.slice(0, 57)}...` : rawText;
      showChatPreview(`${username || 'Jogador'}: ${previewContent}`);
    }
  }
});

socket.on('private-chat-message', (payload) => {
  const { senderId, recipientId, username, text, time } = payload || {};
  const isOwnMessage = senderId === myId;
  const friendId = isOwnMessage ? (recipientId || payload?.friendId) : senderId;
  if (!friendId) return;
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    recipientId,
    username: username || (isOwnMessage ? 'Você' : 'Amigo'),
    text,
    time
  };
  privateChatHistory[friendId] = privateChatHistory[friendId] || [];
  privateChatHistory[friendId].push(message);
  const storageKey = getPrivateChatStorageKey(friendId);
  localStorage.setItem(storageKey, JSON.stringify(privateChatHistory[friendId]));

  if (!isOwnMessage) {
    if (soundEnabled) {
      tocarSom(somNovaMensagem);
    }
    if (!activePrivateFriend || activePrivateFriend.id !== friendId) {
      privateMessagesUnreadByFriend[friendId] = (privateMessagesUnreadByFriend[friendId] || 0) + 1;
      updatePrivateMessagesBadge();
      showPrivateChatNotice('Nova mensagem privada disponível. Abra o chat para ver.', false);
    }
  }

  if (activePrivateFriend && activePrivateFriend.id === friendId) {
    renderPrivateChatHistory(privateChatHistory[friendId]);
    clearPrivateChatNotice();
  }
});
