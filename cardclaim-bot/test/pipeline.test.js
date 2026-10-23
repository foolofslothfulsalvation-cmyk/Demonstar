import assert from 'node:assert/strict';
import test from 'node:test';

import { Claimer } from '../src/claimer.js';
import { classifyGameMessage, parseCards } from '../src/parser.js';
import { makeConfig, makeCard, fakeLogger } from './helpers.js';

async function fullPipeline(configOverrides = {}) {
	const config = makeConfig(configOverrides);
	const logger = fakeLogger();
	const sends = [];
	const claimer = new Claimer({
		config,
		logger,
		send: async (jid, text) => sends.push({ jid, text }),
		sleep: () => {},
	});
	return { config, logger, sends, claimer };
}

test('end-to-end: trusted card is claimed, untrusted text is ignored', async () => {
	const { claimer, sends } = await fullPipeline();

	const cards = parseCards(
		`CARD APPEARED!
Name: Tetsuya Kuroko
Series: Kuroko no Basket
Tier: TIER I
ID: 1-00205
Type .j claim 1-00205`,
		{ senderJid: '233509676154@s.whatsapp.net' },
	);
	assert.equal(cards.length, 1);

	const source = { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true };
	const result = await claimer.enqueue(cards[0], {
		groupJid: '120363000000000001@g.us',
		source,
		timestamp: Date.now(),
	});
	assert.equal(result.claimed, true);
	assert.equal(sends[0].text, '.j claim 1-00205');
});

test('end-to-end: multiple cards claim only up to batch limit', async () => {
	const { claimer, sends } = await fullPipeline({ limits: { maxPerBatch: 1 } });

	const cards = parseCards(`CARD APPEARED!
Name: A
Series: S1
Tier: TIER IV
ID: 4-00001
Type .j claim 4-00001
CARD APPEARED!
Name: B
Series: S2
Tier: TIER I
ID: 1-00002
Type .j claim 1-00002`, { senderJid: '233509676154@s.whatsapp.net' });

	const source = { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true };
	const promises = cards.map((card) =>
		claimer.enqueue(card, {
			groupJid: '120363000000000001@g.us',
			source,
			timestamp: Date.now(),
		}),
	);
	const results = await Promise.all(promises);
	assert.equal(results.filter((r) => r.claimed).length, 1);
	assert.equal(sends.length, 1);
});

test('end-to-end: CLAIMED confirmation matches the pending claim', async () => {
	const { claimer } = await fullPipeline();

	const sourcePhone = '233509676154';
	const card = makeCard({ id: '4-00001', tier: 2, name: 'Souta Mizusaka', series: 'Celestial Method' });
	await claimer.enqueue(card, {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: sourcePhone, prefix: '.j', enabled: true },
		timestamp: Date.now(),
	});

	const confirmation = classifyGameMessage(`💠 *CLAIMED*

🏷️⟢ _Souta Mizusaka_
📺 ⟢ _Celestial Method_

🏆 _TIER II_ ⟢ 🔢 _#1_
\`SOLO COPY\`

📦 _Added to collection_`);
	assert.equal(confirmation.type, 'claimed');

	const matched = claimer.confirmClaim(confirmation.confirmation, sourcePhone);
	assert.equal(matched, true);

	// An unmatched confirmation should not mark anything.
	const unmatched = claimer.confirmClaim(
		{ name: 'Unknown', series: 'Unknown', tier: 1, tierLabel: 'TIER I' },
		sourcePhone,
	);
	assert.equal(unmatched, false);
});

test('end-to-end: CLAIMED confirmation only matches a pending claim in the same group', async () => {
	const { claimer } = await fullPipeline();
	const sourcePhone = '233509676154';
	const source = { name: 'Joker', phone: sourcePhone, prefix: '.j', enabled: true };
	const groupA = '120363000000000001@g.us';
	const groupB = '120363000000000002@g.us';
	const card = makeCard({ name: 'Souta Mizusaka', series: 'Celestial Method', tier: 2 });
	const confirmation = { name: card.name, series: card.series, tier: card.tier };

	await claimer.enqueue(card, { groupJid: groupA, source, timestamp: Date.now() });
	assert.equal(claimer.confirmClaim(confirmation, sourcePhone, groupB), false);
	assert.equal(claimer.pendingCount(), 1);
	assert.equal(claimer.confirmClaim(confirmation, sourcePhone, groupA), true);
	assert.equal(claimer.pendingCount(), 0);
});
