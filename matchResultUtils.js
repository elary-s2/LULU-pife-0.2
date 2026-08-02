function buildMatchResultSummary(room, winnerId) {
  if (!room) {
    return { winner: null, losers: [] };
  }

  if (room.isBotRoom) {
    return { winner: null, losers: [] };
  }

  const winner = room.players.find((player) => player.id === winnerId) || null;
  const losers = (room.players || [])
    .filter((player) => player.id !== winnerId && !isBotPlayerId(player.id))
    .map((player) => ({ ...player }));

  return { winner, losers };
}

function isBotPlayerId(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('bot-');
}

module.exports = {
  buildMatchResultSummary,
  isBotPlayerId,
};
