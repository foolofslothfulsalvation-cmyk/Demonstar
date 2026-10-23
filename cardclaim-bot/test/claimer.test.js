import assert from 'node:assert/strict';
import test from 'node:test';

import { Claimer } from '../src/claimer.js';
import { makeConfig, makeCard, fakeLogger } from './helpers.js';

async function run(config = {}, overrides = {}) {
	const logger = fakeLogger();
	const sends = [];
	const claimer = new Claimer({
		config: makeConfig(config),
		send: async (jid, text) => sends.push({ jid, text }),
		logger,
		sleep: () => {},
		now: () => Date.now(),
		...overrides,
	});
	return { claimer, sends, logger };
}

test('claims a card in live mode', async () => {
	const { claimer, sends, logger } = await run();
	const result = await claimer.enqueue(makeCard(), {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});
	assert.equal(result.claimed, true);
	assert.equal(result.reason, 'sent');
	assert.equal(sends.length, 1);
	assert.equal(sends[0].text, '.j claim 4-00001');
	assert.equal(logger.calls.find((call) => call.message === 'claim sent') !== undefined, true);
});

test('skips cards below min tier when tier is disabled', async () => {
	const { claimer, sends, logger } = await run({
		tiers: { 1: { enabled: false, probability: 0, maxPerHour: 0 } },
	});
	const result = await claimer.enqueue(makeCard({ id: '1-00001', tier: 1 }), {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});
	assert.equal(result.claimed, false);
	assert.equal(result.reason, 'tier-disabled');
	assert.equal(sends.length, 0);
	assert.equal(logger.calls.some((call) => call.data.reason === 'tier-disabled'), true);
});

test('skips cards from untrusted sources', async () => {
	const { claimer } = await run();
	const result = await claimer.enqueue(makeCard(), {
		groupJid: '120363000000000001@g.us',
		source: null,
	});
	assert.equal(result.claimed, false);
	assert.equal(result.reason, 'untrusted-source');
});

test('skips non-group chats', async () => {
	const { claimer } = await run();
	const result = await claimer.enqueue(makeCard(), {
		groupJid: '2349153327424@s.whatsapp.net',
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});
	assert.equal(result.claimed, false);
	assert.equal(result.reason, 'not-a-group');
});

test('uses source prefix from config', async () => {
	const { claimer, sends } = await run();
	await claimer.enqueue(makeCard({ claimPrefix: '.j' }), {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: '233509676154', prefix: '.jk', enabled: true },
	});
	assert.equal(sends[0].text, '.jk claim 4-00001');
});

test('respects maxPerBatch when multiple cards spawn at once', async () => {
	const { claimer, sends } = await run({ limits: { maxPerBatch: 2 } });
	const results = await Promise.all([
		claimer.enqueue(makeCard({ id: '1-00001' }), {
			groupJid: '120363000000000001@g.us',
			source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
		}),
		claimer.enqueue(makeCard({ id: '2-00002' }), {
			groupJid: '120363000000000001@g.us',
			source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
		}),
		claimer.enqueue(makeCard({ id: '3-00003' }), {
			groupJid: '120363000000000001@g.us',
			source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
		}),
	]);
	assert.equal(results.filter((result) => result.claimed).length, 2);
	assert.equal(sends.length, 2);
});

test('stops pausing when .pause equivalent is toggled', async () => {
	const { claimer } = await run();
	claimer.setPaused(true);
	assert.equal(claimer.isPaused(), true);
	const result = await claimer.enqueue(makeCard(), {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});
	assert.equal(result.claimed, false);
	assert.equal(result.reason, 'paused');
	claimer.setPaused(false);
	assert.equal(claimer.isPaused(), false);
});

test('does not send a card that is paused during the typing delay', async () => {
	let claimer;
	let sends;
	({ claimer, sends } = await run({}, {
		sleep: async () => claimer.setPaused(true),
	}));

	const result = await claimer.enqueue(makeCard(), {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});

	assert.equal(result.claimed, false);
	assert.equal(result.reason, 'paused');
	assert.equal(sends.length, 0);
});

test('minimum gap applies between actual send attempts with variable typing delays', async () => {
	let now = 10000;
	const sendTimes = [];
	const randomValues = [0, 0, 1, 0, 0, 0];
	const { claimer } = await run(
		{ limits: { minGapMs: 2500 } },
		{
			send: async () => sendTimes.push(now),
			sleep: async (ms) => { now += ms; },
			now: () => now,
			random: () => randomValues.shift() ?? 0,
		},
	);
	const source = { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true };
	const groupJid = '120363000000000001@g.us';

	await claimer.enqueue(makeCard({ id: '4-00001' }), { groupJid, source });
	await claimer.enqueue(makeCard({ id: '4-00002' }), { groupJid, source });

	assert.equal(sendTimes.length, 2);
	assert.ok(sendTimes[1] - sendTimes[0] >= 2500);
});

test('marks the originating message read with its full message key', async () => {
	const reads = [];
	const { claimer } = await run({}, { markRead: async (key) => reads.push(key) });
	const groupJid = '120363000000000001@g.us';
	const messageKey = { remoteJid: groupJid, fromMe: false, id: 'CARD-MESSAGE-ID' };

	await claimer.enqueue(makeCard(), {
		groupJid,
		messageKey,
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});

	assert.deepEqual(reads, [messageKey]);
});

test('dry-run logs instead of sending', async () => {
	const { claimer, sends, logger } = await run({ dryRun: true });
	const result = await claimer.enqueue(makeCard(), {
		groupJid: '120363000000000001@g.us',
		source: { name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
	});
	assert.equal(result.claimed, false);
	assert.equal(result.reason, 'dry-run');
	assert.equal(sends.length, 0);
	assert.equal(logger.calls.some((call) => call.message === 'DRY RUN — would claim'), true);
});
