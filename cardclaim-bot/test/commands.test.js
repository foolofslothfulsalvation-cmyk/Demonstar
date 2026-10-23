import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleCommand, isCommand } from '../src/commands.js';
import { makeConfig } from './helpers.js';

async function run(text, overrides = {}) {
	const config = makeConfig({});
	const sent = [];
	const claimer = {
		stats: { detected: 0, claimed: 0, skipped: 0, failed: 0, dryRun: 0, confirmed: 0 },
		isPaused: () => false,
		setPaused: () => false,
		pendingCount: () => 0,
		...overrides.claimer,
	};
	const sock = { user: { id: '2349153327424@s.whatsapp.net' } };
	const logger = { warn: () => {} };
	return await handleCommand({
		text,
		config,
		configPath: tempFile(config),
		claimer,
		sock,
		logger,
	});
}

function tempFile(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonstar-commands-'));
	const file = path.join(dir, 'config.json');
	fs.writeFileSync(file, JSON.stringify(content));
	return file;
}

test('.status shows connection, mode, limits', async () => {
	const reply = await run('.status');
	assert.ok(reply.includes('Connection:'));
	assert.ok(reply.includes('IV='));
	assert.ok(reply.includes('/min'));
	assert.ok(reply.includes('Limits:'));
});

test('.pause pauses and .resume resumes', async () => {
	const config = makeConfig({});
	let paused = false;
	const claimer = {
		stats: { detected: 0, claimed: 0, skipped: 0, failed: 0, dryRun: 0, confirmed: 0 },
		isPaused: () => paused,
		setPaused: (p) => {
			paused = p;
		},
		pendingCount: () => 0,
	};
	const configPath = tempFile(config);
	await handleCommand({
		text: '.pause',
		config,
		configPath,
		claimer,
		sock: { user: { id: '2349153327424@s.whatsapp.net' } },
		logger: { warn: () => {} },
	});
	assert.equal(paused, true);
	await handleCommand({
		text: '.resume',
		config,
		configPath,
		claimer,
		sock: { user: { id: '2349153327424@s.whatsapp.net' } },
		logger: { warn: () => {} },
	});
	assert.equal(paused, false);
	assert.equal(config.paused, false);
});

test('.rates shows tier rates and limits', async () => {
	const reply = await run('.rates');
	assert.ok(reply.includes('Tier IV:'));
	assert.ok(reply.includes('Limits:'));
	assert.ok(reply.includes('100/min'));
});

test('.set t4 50 changes tier probability and enables it', async () => {
	const reply = await run('.set t4 50');
	assert.ok(reply.includes('Tier IV set to 50%'));
});

test('.t4 off and on toggles the tier without losing its configured chance', async () => {
	const config = makeConfig({ tiers: { 4: { enabled: true, probability: 0.6, maxPerHour: 12 } } });
	const configPath = tempFile(config);
	const claimer = { isPaused: () => false, setPaused: () => {} };

	const offReply = await handleCommand({ text: '.t4 off', config, configPath, claimer });
	assert.ok(offReply.includes('Tier IV is now disabled'));
	assert.equal(config.tiers[4].enabled, false);
	assert.equal(config.tiers[4].probability, 0.6);

	const onReply = await handleCommand({ text: '.t4 on', config, configPath, claimer });
	assert.ok(onReply.includes('Tier IV is now enabled'));
	assert.equal(config.tiers[4].enabled, true);
	assert.equal(config.tiers[4].probability, 0.6);
});

test('.t1 on restores a usable policy for a tier disabled by default', async () => {
	const config = makeConfig({ tiers: { 1: { enabled: false, probability: 0, maxPerHour: 0 } } });
	const reply = await handleCommand({ text: '.t1 on', config });
	assert.ok(reply.includes('Tier I is now enabled'));
	assert.equal(config.tiers[1].enabled, true);
	assert.ok(config.tiers[1].probability > 0);
	assert.ok(config.tiers[1].maxPerHour > 0);
});

test('.kill is recognised as a control command', () => {
	assert.equal(isCommand('.kill'), true);
});

test('.kill pauses before the caller disconnects so its reply can be sent', async () => {
	const config = makeConfig();
	let paused = false;
	let endCalls = 0;
	const reply = await handleCommand({
		text: '.kill',
		config,
		claimer: { setPaused: (value) => { paused = value; } },
		sock: { end: async () => { endCalls += 1; } },
	});
	assert.ok(reply.includes('Disconnecting'));
	assert.equal(paused, true);
	assert.equal(config.paused, true);
	assert.equal(endCalls, 0);
});

test('.set dryrun off turns off dry run', async () => {
	const reply = await run('.set dryrun off');
	assert.ok(reply.includes('Dry run is now OFF'));
});

test('.block and .unblock manage blocked groups', async () => {
	const block = await run('.block 120363000000000002@g.us');
	assert.ok(block.includes('Blocked'));
	const unblock = await run('.unblock 120363000000000002@g.us');
	assert.ok(unblock.includes('Unblocked'));
});

test('unknown command returns help hint', async () => {
	const reply = await run('.nonsense');
	assert.ok(reply.includes('Unknown command'));
});

test('persists changes by reading back config file', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demonstar-persist-'));
	const file = path.join(dir, 'config.json');
	fs.writeFileSync(file, JSON.stringify(makeConfig({})));

	const claimer = {
		stats: { detected: 0, claimed: 0, skipped: 0, failed: 0, dryRun: 0, confirmed: 0 },
		isPaused: () => false,
		setPaused: () => {},
		pendingCount: () => 0,
	};
	await handleCommand({
		text: '.set t3 90',
		config: makeConfig({}),
		configPath: file,
		claimer,
		sock: { user: { id: '2349153327424@s.whatsapp.net' } },
		logger: { warn: () => {} },
	});
	const reloaded = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.equal(reloaded.tiers[3].probability, 0.9);
	assert.equal(reloaded.tiers[3].enabled, true);
	fs.rmSync(dir, { recursive: true, force: true });
});
