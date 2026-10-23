import { DEFAULTS } from '../src/config.js';

export const GROUP = '120363000000000001@g.us';
export const SOURCE = {
	name: 'Joker',
	phone: '233509676154',
	prefix: '.j',
	enabled: true,
};

function merge(base, override) {
	if (Array.isArray(override)) return override;
	if (!override || typeof override !== 'object') return override;
	const out = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] =
			value && typeof value === 'object' && !Array.isArray(value)
				? merge(base?.[key] ?? {}, value)
				: value;
	}
	return out;
}

export function makeConfig(overrides = {}) {
	const config = merge(structuredClone(DEFAULTS), {
		phoneNumber: '2349153327424',
		dryRun: false,
		groupMode: 'trusted-bots',
		tiers: {
			1: { enabled: true, probability: 1, maxPerHour: 100 },
			2: { enabled: true, probability: 1, maxPerHour: 100 },
			3: { enabled: true, probability: 1, maxPerHour: 100 },
			4: { enabled: true, probability: 1, maxPerHour: 100 },
			5: { enabled: true, probability: 1, maxPerHour: 100 },
			6: { enabled: true, probability: 1, maxPerHour: 100 },
		},
		limits: {
			minGapMs: 0,
			jitterMs: { min: 0, max: 0 },
			maxPerMinute: 100,
			maxPerHour: 100,
			maxPerDay: 1000,
			maxPerBatch: 5,
			batchWindowMs: 0,
			maxCardAgeMs: 60000,
			dedupeTtlMs: 600000,
			perSourceMaxPerMinute: 100,
		},
		backoff: { rateLimitMs: 60000, sendFailureMs: 30000 },
		logLevel: 'silent',
	});
	return merge(config, overrides);
}

export function makeCard(overrides = {}) {
	return {
		id: '4-00001',
		tier: 4,
		tierLabel: 'TIER IV',
		name: 'Test Card',
		series: 'Test Series',
		artist: 'Tester',
		description: 'A test card',
		claimPrefix: '.j',
		...overrides,
	};
}

export function fakeLogger() {
	const calls = [];
	const logger = {};
	for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
		logger[level] = (data, message) => calls.push({ level, data, message });
	}
	logger.calls = calls;
	return logger;
}
