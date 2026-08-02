const assert = require('assert');
const { buildMatchResultSummary } = require('../matchResultUtils');

const room = {
  isBotRoom: false,
  players: [
    { id: 'p1', name: 'Ana', playerId: 101 },
    { id: 'p2', name: 'Beto', playerId: 102 },
    { id: 'bot-1', name: 'Bot' },
  ],
};

const result = buildMatchResultSummary(room, 'p1');
assert.strictEqual(result.winner?.id, 'p1');
assert.strictEqual(result.winner?.playerId, 101);
assert.deepStrictEqual(result.losers.map((player) => player.id), ['p2']);

const botRoomResult = buildMatchResultSummary({ isBotRoom: true, players: [{ id: 'p1', playerId: 1 }] }, 'p1');
assert.strictEqual(botRoomResult.winner, null);
assert.deepStrictEqual(botRoomResult.losers, []);

console.log('testMatchResultUtils: ok');
