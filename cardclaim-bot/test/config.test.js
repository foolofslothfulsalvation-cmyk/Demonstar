import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	ConfigError,
	DEFAULTS,
	findBotByPhone,
	groupAllowed,
	isController,
	loadConfig,
	saveConfig,
	validateConfig,
} from '../src/config.js';

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'demonstar-config-'));
}

test('loads defaults when the config file does not exist', () => {
	const dir = tempDir();
	const config = loadConfig(path.join(dir, 'missing.json'));
	assert.equal(config.bots.length, 3);
	assert.equal(config.tiers[4].probability, 1);
	assert.equal(config.groupMode, 'trusted-bots');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('user values override defaults without losing the rest', () => {
	const dir = tempDir();
	const file = path.join(dir, 'config.json');
	fs.writeFileSync(
		file,
		JSON.stringify({
			phoneNumber: '2349153327424',
			dryRun: false,
			tiers: { 3: { probability: 0.5 } },
			limits: { maxPerMinute: 3 },
		}),
	);
	const config = loadConfig(file);
	assert.equal(config.phoneNumber, '2349153327424');
	assert.equal(config.dryRun, false);
	assert.equal(config.tiers[3].probability, 0.5);
	assert.equal(config.tiers[3].maxPerHour, 8);
	assert.equal(config.tiers[4].probability, 1);
	assert.equal(config.limits.maxPerMinute, 3);
	assert.equal(config.limits.maxPerHour, 20);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('saveConfig round-trips the effective config atomically', () => {
	const dir = tempDir();
	const file = path.join(dir, 'config.json');
	const config = structuredClone(DEFAULTS);
	config.phoneNumber = '2349153327424';
	config.tiers[4].probability = 0.5;
	saveConfig(config, file);
	const loaded = loadConfig(file);
	assert.equal(loaded.phoneNumber, '2349153327424');
	assert.equal(loaded.tiers[4].probability, 0.5);
	assert.equal(fs.existsSync(`${file}.tmp`), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects a local-format phone number and invalid slots together', () => {
	const config = structuredClone(DEFAULTS);
	config.phoneNumber = '09153327424';
	config.tiers[4].probability = 2;
	config.limits.maxPerBatch = 0;
	const problems = validateConfig(config);
	assert.ok(problems.some((problem) => problem.includes('phoneNumber')));
	assert.ok(problems.some((problem) => problem.includes('probability')));
	assert.ok(problems.some((problem) => problem.includes('maxPerBatch')));
});

test('loadConfig reports invalid JSON with the path', () => {
	const dir = tempDir();
	const file = path.join(dir, 'config.json');
	fs.writeFileSync(file, '{ not json');
	assert.throws(() => loadConfig(file), (err) => {
		assert.ok(err instanceof ConfigError);
		assert.match(err.message, /not valid JSON/);
		return true;
	});
	fs.rmSync(dir, { recursive: true, force: true });
});

test('groupAllowed honours follow mode, allowlists, and blocklists', () => {
	const config = structuredClone(DEFAULTS);
	const group = '120363000000000001@g.us';
	assert.equal(groupAllowed(config, group), true);
	config.groupMode = 'allowlist';
	assert.equal(groupAllowed(config, group), false);
	config.groups = [group];
	assert.equal(groupAllowed(config, group), true);
	config.blockedGroups = [group];
	assert.equal(groupAllowed(config, group), false);
	assert.equal(groupAllowed(config, '2349153327424@s.whatsapp.net'), false);
});

test('findBotByPhone and isController normalise digits', () => {
	const config = structuredClone(DEFAULTS);
	assert.equal(findBotByPhone(config, '233 509 676 154').name, 'Joker');
	assert.equal(findBotByPhone(config, '000'), null);
	config.control.allowedNumbers = ['234 915 332 7424'];
	assert.equal(isController(config, '2349153327424'), true);
	assert.equal(isController(config, '2340000000000'), false);
});
