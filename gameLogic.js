/**
 * gameLogic.js
 * Centraliza lógica de jogo com proteções contra exploits
 */

/**
 * Verifica se um jogador pode executar uma ação
 * Retorna { allowed: boolean, reason?: string }
 */
function validateActionPermission(room, socketId, action) {
  // Jogador não está na sala
  if (!room.players.some(p => p.id === socketId)) {
    return { allowed: false, reason: 'Jogador não encontrado na sala' };
  }

  // Sala não começou
  if (!room.started) {
    return { allowed: false, reason: 'Jogo não começou' };
  }

  // Jogo terminou
  if (room.winner) {
    return { allowed: false, reason: 'Jogo já terminou' };
  }

  // Jogador já terminou (finalizado)
  if (room.finishedPlayers.includes(socketId)) {
    return { allowed: false, reason: 'Você já terminou esta partida' };
  }

  // Ações que requerem ser o jogador atual
  const currentActions = ['draw-card', 'discard-card', 'bat', 'declare-meld', 'return-meld-card'];
  if (currentActions.includes(action)) {
    const currentPlayerId = room.players[room.currentTurn]?.id;
    if (socketId !== currentPlayerId) {
      return { allowed: false, reason: 'Não é sua vez' };
    }
  }

  return { allowed: true };
}

/**
 * Encontra o próximo jogador ativo de forma segura
 * Retorna -1 se nenhum ativo for encontrado
 * Protegido contra loops infinitos
 */
function findNextActivePlayerIndex(room) {
  if (!Array.isArray(room.players) || room.players.length === 0) {
    return -1;
  }

  const totalPlayers = room.players.length;
  const finishedSet = new Set(room.finishedPlayers);

  // Itera no máximo 'totalPlayers' vezes para evitar loop infinito
  for (let i = 1; i <= totalPlayers; i++) {
    const nextIndex = (room.currentTurn + i) % totalPlayers;
    const nextPlayer = room.players[nextIndex];
    
    if (nextPlayer && !finishedSet.has(nextPlayer.id)) {
      return nextIndex;
    }
  }

  return -1;
}

/**
 * Encontra o primeiro jogador ativo
 * Retorna -1 se nenhum ativo for encontrado
 */
function findFirstActivePlayerIndex(room) {
  const finishedSet = new Set(room.finishedPlayers);
  for (let i = 0; i < room.players.length; i++) {
    const player = room.players[i];
    if (player && !finishedSet.has(player.id)) {
      return i;
    }
  }
  return -1;
}

/**
 * Conta quantos jogadores ainda estão ativos
 */
function countActivePlayers(room) {
  const finishedSet = new Set(room.finishedPlayers || []);
  return room.players.filter((player) => player && !finishedSet.has(player.id) && !player.disconnected).length;
}

/**
 * Verifica se há apenas um jogador ativo restante
 */
function isOnlyOnePlayerActive(room) {
  return countActivePlayers(room) === 1;
}

/**
 * Verifica se todos os jogadores estão finalizados
 */
function areAllPlayersFinished(room) {
  return room.players.length > 0 && countActivePlayers(room) === 0;
}

/**
 * Valida reconexão segura
 * Retorna { valid: boolean, reason?: string }
 */
function validateReconnection(room, socketId, playerName) {
  if (!room) {
    return { valid: false, reason: 'Sala não encontrada' };
  }

  // Procura por jogador com esse nome
  const existingPlayer = room.players.find(p => p.name === playerName);
  
  if (!existingPlayer) {
    return { valid: false, reason: 'Jogador com este nome não encontrado na sala' };
  }

  return { valid: true };
}

/**
 * Marca um jogador como finalizado e verifica se jogo deve terminar
 * Retorna { gameEnded: boolean, winner?: string }
 */
function markPlayerFinished(room, socketId) {
  if (room.finishedPlayers.includes(socketId)) {
    return { gameEnded: false };
  }

  room.finishedPlayers.push(socketId);

  const activePlayers = countActivePlayers(room);

  // Se, após marcar este jogador como finalizado, houver 1 ou menos jogadores ativos,
  // o jogador que acabou de finalizar deve ser considerado vencedor (ex.: quem bateu).
  if (activePlayers <= 1) {
    return {
      gameEnded: true,
      winner: socketId,
      winnerName: room.players.find(p => p.id === socketId)?.name || 'Jogador'
    };
  }

  return { gameEnded: false };
}

/**
 * Transfere host para outro jogador ativo
 * Retorna novo hostId ou null
 */
function transferHostToActivePlayer(room, currentHostId) {
  if (room.hostId !== currentHostId) {
    return room.hostId;
  }

  // Prefere jogador ativo (não finalizado)
  const activePlayer = room.players.find(p => !room.finishedPlayers.includes(p.id));
  if (activePlayer) {
    room.hostId = activePlayer.id;
    return activePlayer.id;
  }

  // Fallback: qualquer jogador
  if (room.players.length > 0) {
    room.hostId = room.players[0].id;
    return room.players[0].id;
  }

  room.hostId = null;
  return null;
}

/**
 * Verifica se jogo chegou ao ponto de oferecer encerramento
 * Com 3+ jogadores, oferece opção de encerrar após 3 ativos restarem
 * Retorna { canOfferEndGame: boolean, activeCount: number }
 */
function canOfferEndGame(room) {
  const activeCount = countActivePlayers(room);
  const totalPlayers = room.players.length;
  
  // Se resta apenas 1 jogador ativo, permitir encerrar sem contabilizar vitória.
  if (activeCount === 1) {
    return { canOfferEndGame: true, activeCount };
  }

  // Se há 6+ jogadores originalmente e 3 ou menos ativos, oferecer encerramento
  if (totalPlayers >= 6 && activeCount <= 3) {
    return { canOfferEndGame: true, activeCount };
  }
  
  // Se há 2+ ativos e alguém finalizou, oferece opção
  if (activeCount >= 2 && room.finishedPlayers.length > 0) {
    return { canOfferEndGame: true, activeCount };
  }
  
  return { canOfferEndGame: false, activeCount };
}

/**
 * Registra confirmação de encerramento de um jogador
 * Retorna { shouldEnd: boolean, reason?: string }
 */
function recordEndGameConfirmation(room, socketId, confirmed) {
  if (!room.endGameConfirmations) {
    room.endGameConfirmations = {};
  }
  
  room.endGameConfirmations[socketId] = confirmed;
  
  const activePlayerIds = room.players
    .filter(p => !room.finishedPlayers.includes(p.id))
    .map(p => p.id);
  
  // Contar confirmações
  const confirmations = activePlayerIds.filter(id => room.endGameConfirmations[id] === true).length;
  const denials = activePlayerIds.filter(id => room.endGameConfirmations[id] === false).length;
  
  // Se todos confirmam, encerrar jogo
  if (confirmations === activePlayerIds.length && activePlayerIds.length > 0) {
    return { shouldEnd: true, reason: 'Todos confirmaram encerramento' };
  }
  
  // Se alguém nega, continuar jogo (limpar confirmações)
  if (denials > 0) {
    room.endGameConfirmations = {};
    return { shouldEnd: false, reason: 'Alguém deseja continuar jogando' };
  }
  
  // Se ainda não tem resposta de todos
  return { shouldEnd: false, reason: 'Aguardando confirmações' };
}

/**
 * Valida reset seguro
 * Retorna { allowed: boolean, reason?: string }
 */
function validateReset(room, requesterId) {
  if (!room) {
    return { allowed: false, reason: 'Sala não encontrada' };
  }

  if (room.resetting) {
    return { allowed: false, reason: 'Reinício já em andamento' };
  }

  // Host pode resetar sempre que o jogo tiver começado
  if (requesterId === room.hostId && room.started) {
    return { allowed: true };
  }

  // Se restar apenas um jogador ativo, permitir reset para evitar sala travada
  if (countActivePlayers(room) === 1 && room.started) {
    return { allowed: true };
  }

  // Outros só podem resetar se há vencedor ou finalizados
  if (!room.winner && room.finishedPlayers.length === 0) {
    return { allowed: false, reason: 'Nenhum vencedor para reiniciar' };
  }

  return { allowed: true };
}

module.exports = {
  validateActionPermission,
  findNextActivePlayerIndex,
  findFirstActivePlayerIndex,
  countActivePlayers,
  isOnlyOnePlayerActive,
  areAllPlayersFinished,
  validateReconnection,
  markPlayerFinished,
  transferHostToActivePlayer,
  validateReset,
  canOfferEndGame,
  recordEndGameConfirmation
};
