import assert from 'node:assert/strict';
import test from 'node:test';

import {
	classifyGameMessage,
	extractText,
	normalise,
	parseCards,
	parseClaimConfirmation,
	romanToInt,
} from '../src/parser.js';
import { CARD_SAMPLE, CLAIMED_SAMPLE } from './fixtures.js';

test('parses all eight cards in the real sample', () => {
	const cards = parseCards(CARD_SAMPLE);
	assert.equal(cards.length, 8);
	assert.deepEqual(
		cards.map((card) => card.id),
		[
			'2-05430',
			'1-11732',
			'1-00205',
			'1-10975',
			'4-03129',
			'2-02526',
			'1-12161',
			'4-02863',
		],
	);
	assert.deepEqual(
		cards.map((card) => card.tier),
		[2, 1, 1, 1, 4, 2, 1, 4],
	);
});

test('extracts every metadata field from the sample card', () => {
	const [card] = parseCards(CARD_SAMPLE);
	assert.equal(card.id, '2-05430');
	assert.equal(card.name, 'Tokitaka Tokiwa');
	assert.equal(card.series, 'Ahiru no Sora');
	assert.equal(card.tier, 2);
	assert.equal(card.tierLabel, 'TIER II');
	assert.equal(card.artist, 'Kruggles');
	assert.equal(card.description, 'Tokitaka Tokiwa from Ahiru no Sora');
	assert.equal(card.claimPrefix, '.j');
});

test('parses the older "Name › value" layout', () => {
	const raw = `CARD APPEARED!
Name › Shinichi Izumi and Migi
Series › Parasyte
Tier › TIER IV
Art › Anonymous
ID: 4-04701
Type .j claim 4-04701`;
	const [card] = parseCards(raw);
	assert.equal(card.id, '4-04701');
	assert.equal(card.name, 'Shinichi Izumi and Migi');
	assert.equal(card.series, 'Parasyte');
	assert.equal(card.tier, 4);
	assert.equal(card.claimPrefix, '.j');
});

test('falls back to the ID prefix when the tier line is mangled', () => {
	const raw = `CARD APPEARED!
Name: Broken Tier
Series: Test
Tier: ???
ID: 3-01234
Type .j claim 3-01234`;
	const [card] = parseCards(raw);
	assert.equal(card.id, '3-01234');
	assert.equal(card.tier, 3);
	assert.equal(card.name, 'Broken Tier');
});

test('deduplicates a card ID repeated in one message', () => {
	const raw = `${CARD_SAMPLE.split('[10/22, 6:04 PM]')[1]}
[10/22, 6:04 PM] Lapis: CARD APPEARED!
Name: Tokitaka Tokiwa
Series: Ahiru no Sora
Tier: TIER II
ID: 2-05430
Type .j claim 2-05430`;
	const cards = parseCards(raw);
	assert.equal(cards.filter((card) => card.id === '2-05430').length, 1);
});

test('ignores ordinary chat and card IDs embedded in longer numbers', () => {
	assert.deepEqual(parseCards('hello 4-03129123'), []);
	assert.deepEqual(parseCards('CARD APPEARED!\nName: No ID'), []);
});

test('parses the CLAIMED response by emoji and label', () => {
	const confirmation = parseClaimConfirmation(CLAIMED_SAMPLE);
	assert.equal(confirmation.name, 'Souta Mizusaka');
	assert.equal(confirmation.series, 'Celestial Method');
	assert.equal(confirmation.tier, 2);
	assert.equal(confirmation.tierLabel, 'TIER II');
});

test('classifies CLAIMED and rate-limit messages', () => {
	const claimed = classifyGameMessage(CLAIMED_SAMPLE);
	assert.equal(claimed.type, 'claimed');
	assert.equal(claimed.confirmation.name, 'Souta Mizusaka');

	const limited = classifyGameMessage('Slow down — try again in 30 seconds.');
	assert.equal(limited.type, 'rate-limit');

	const already = classifyGameMessage('That card was already claimed.');
	assert.equal(already.type, 'already-claimed');

	// "already claimed" contains the word "claimed", so it must take priority.
	assert.equal(classifyGameMessage('already claimed').type, 'already-claimed');

	assert.equal(classifyGameMessage(CARD_SAMPLE), null);
	assert.equal(classifyGameMessage('hello there'), null);
});

test('normalise strips invisible characters and CRLF', () => {
	assert.equal(normalise('a\u200Bb\r\nc'), 'ab\nc');
});

test('romanToInt handles roman and numeric values', () => {
	assert.equal(romanToInt('IV'), 4);
	assert.equal(romanToInt('TIER III'), 3);
	assert.equal(romanToInt('2'), 2);
	assert.equal(romanToInt('nope'), null);
});

test('extractText unwraps extended text and image captions', () => {
	assert.equal(
		extractText({ extendedTextMessage: { text: 'CARD APPEARED' } }),
		'CARD APPEARED',
	);
	assert.equal(
		extractText({ imageMessage: { caption: 'card caption' } }),
		'card caption',
	);
	assert.equal(extractText({ contextInfo: { quotedMessage: { conversation: 'old' } } }), '');
});
