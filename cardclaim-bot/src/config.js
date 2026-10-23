import fs from 'node:fs';
import path from 'node:path';

/**
 * Defaults for Demonstar.
 *
 * The bot follows the three game-bot accounts listed below. A card is only
 * considered when it was posted by one of those accounts, so a human pasting
 * an old card into the group cannot trigger a claim.
 */
export const DEFAULTS = {
	/** WhatsApp number of the account Baileys will link, digits only, with country code. */
	phoneNumber: '',

	/** Survives restarts when changed with .pause / .resume. */
	paused: false,

	/** Log what would be sent without sending anything. */
	dryRun: true,

	/**
	 * "trusted-bots" claims in any group where a configured game bot posts a
	 * card. "allowlist" only claims in the groups listed in `groups`.
	 */
	groupMode: 'trusted-bots',
	groups: [],
	blockedGroups: [],

	bots: [
		{ name: 'Joker', phone: '233509676154', prefix: '.j', enabled: true },
		{ name: 'Subaru', phone: '2347014606422', prefix: '.s', enabled: true },
		{ name: 'Jake', phone: '2349133219812', prefix: '.jk', enabled: true },
	],

	/**
	 * Claim policy by tier. `probability` is the chance of trying a card;
	 * `maxPerHour` is a hard per-tier cap. A disabled tier is never claimed.
	 */
	tiers: {
		1: { enabled: false, probability: 0, maxPerHour: 0 },
		2: { enabled: true, probability: 0.25, maxPerHour: 4 },
		3: { enabled: true, probability: 0.75, maxPerHour: 8 },
		4: { enabled: true, probability: 1, maxPerHour: 12 },
		5: { enabled: true, probability: 1, maxPerHour: 20 },
		6: { enabled: true, probability: 1, maxPerHour: 30 },
	},

	limits: {
		/** Minimum gap between any two claim sends, across all groups. */
		minGapMs: 2500,
		/** Random extra delay before a send. */
		jitterMs: { min: 300, max: 900 },
		maxPerMinute: 6,
		maxPerHour: 20,
		maxPerDay: 80,
		/** How many cards may be claimed from one short burst of spawns. */
		maxPerBatch: 1,
		/** How long to collect a burst before choosing the best cards. */
		batchWindowMs: 300,
		/** Ignore cards older than this when they reach the queue. */
		maxCardAgeMs: 15000,
		/** Remember a handled card ID for this long. */
		dedupeTtlMs: 600000,
		/** Per game bot, to avoid hammering one source. */
		perSourceMaxPerMinute: 2,
		/** Extra delay (ms) before claiming tiers below Tier IV — looks human. */
		lowTierDelayMs: 12000,
	},

	control: {
		/** Extra DM numbers allowed to change settings. The bot's own chat is always allowed. */
		allowedNumbers: [],
	},

	backoff: {
		/** Pause a source after a cooldown/rate-limit reply. */
		rateLimitMs: 300000,
		/** Pause a source after a failed send. */
		sendFailureMs: 30000,
	},

	session: {
		/** Health check interval in ms. 0 = disabled. */
		healthCheckMs: 300000,
		/** Warn when session is this many days old (14-day WhatsApp limit). */
		warnAgeDays: 13,
		/** Auto-delete auth_info and re-pair if session dies. */
		autoRepair: true,
		/** Restart process on uncaught errors (watchdog). */
		watchdog: true,
	},

	notify: {
		/** DM yourself when a Tier V or VI card appears. */
		highTier: true,
		/** DM yourself on claim success/failure summary. */
		claimSummary: false,
	},

	logLevel: 'info',
};

/** Named claiming profiles. Switch with `.profile <name>` or CC_PROFILE env. */
export const PROFILES = {
	conservative: {
		tiers: {
			1: { enabled: false, probability: 0, maxPerHour: 0 },
			2: { enabled: false, probability: 0, maxPerHour: 0 },
			3: { enabled: true, probability: 0.25, maxPerHour: 2 },
			4: { enabled: true, probability: 1, maxPerHour: 6 },
			5: { enabled: true, probability: 1, maxPerHour: 10 },
			6: { enabled: true, probability: 1, maxPerHour: 15 },
		},
		limits: {
			minGapMs: 5000,
			jitterMs: { min: 800, max: 2000 },
			maxPerMinute: 3,
			maxPerHour: 10,
			maxPerDay: 40,
			maxPerBatch: 1,
			batchWindowMs: 500,
			maxCardAgeMs: 10000,
			dedupeTtlMs: 900000,
			perSourceMaxPerMinute: 1,
		},
	},
	balanced: {
		tiers: {
			1: { enabled: false, probability: 0, maxPerHour: 0 },
			2: { enabled: true, probability: 0.25, maxPerHour: 4 },
			3: { enabled: true, probability: 0.75, maxPerHour: 8 },
			4: { enabled: true, probability: 1, maxPerHour: 12 },
			5: { enabled: true, probability: 1, maxPerHour: 20 },
			6: { enabled: true, probability: 1, maxPerHour: 30 },
		},
		limits: {
			minGapMs: 2500,
			jitterMs: { min: 300, max: 900 },
			maxPerMinute: 6,
			maxPerHour: 20,
			maxPerDay: 80,
			maxPerBatch: 1,
			batchWindowMs: 300,
			maxCardAgeMs: 15000,
			dedupeTtlMs: 600000,
			perSourceMaxPerMinute: 2,
		},
	},
	aggressive: {
		tiers: {
			1: { enabled: true, probability: 0.5, maxPerHour: 20 },
			2: { enabled: true, probability: 0.8, maxPerHour: 30 },
			3: { enabled: true, probability: 1, maxPerHour: 40 },
			4: { enabled: true, probability: 1, maxPerHour: 60 },
			5: { enabled: true, probability: 1, maxPerHour: 80 },
			6: { enabled: true, probability: 1, maxPerHour: 100 },
		},
		limits: {
			minGapMs: 1000,
			jitterMs: { min: 100, max: 400 },
			maxPerMinute: 12,
			maxPerHour: 60,
			maxPerDay: 300,
			maxPerBatch: 3,
			batchWindowMs: 200,
			maxCardAgeMs: 20000,
			dedupeTtlMs: 300000,
			perSourceMaxPerMinute: 4,
		},
	},
	stealth: {
		tiers: {
			1: { enabled: false, probability: 0, maxPerHour: 0 },
			2: { enabled: true, probability: 0.1, maxPerHour: 2 },
			3: { enabled: true, probability: 0.3, maxPerHour: 4 },
			4: { enabled: true, probability: 0.6, maxPerHour: 6 },
			5: { enabled: true, probability: 0.8, maxPerHour: 8 },
			6: { enabled: true, probability: 1, maxPerHour: 10 },
		},
		limits: {
			minGapMs: 8000,
			jitterMs: { min: 2000, max: 5000 },
			maxPerMinute: 2,
			maxPerHour: 6,
			maxPerDay: 25,
			maxPerBatch: 1,
			batchWindowMs: 800,
			maxCardAgeMs: 8000,
			dedupeTtlMs: 1200000,
			perSourceMaxPerMinute: 1,
		},
	},
};

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
const GROUP_JID_RE = /^[\d-]+@g\.us$/;

export class ConfigError extends Error {}

/** Removes formatting and returns digits only. */
export function normalisePhone(value) {
	return String(value ?? '').replace(/[^\d]/g, '');
}

/** True when a value looks like an international phone number. */
export function isPhoneNumber(value) {
	const digits = normalisePhone(value);
	return /^\d{8,15}$/.test(digits) && !digits.startsWith('0');
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
	if (Array.isArray(override)) return override;
	if (!isObject(override)) return override;

	const out = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] = isObject(value) ? deepMerge(base[key] ?? {}, value) : value;
	}
	return out;
}

function addProblem(problems, message) {
	problems.push(message);
}

/**
 * Validates a merged config and returns the list of problems. Loading is done
 * separately so the caller can report every problem at once.
 */
export function validateConfig(config) {
	const problems = [];

	if (config.phoneNumber !== '' && !isPhoneNumber(config.phoneNumber)) {
		addProblem(
			problems,
			'"phoneNumber" must be an international phone number in digits only, e.g. 2349153327424',
		);
	}

	if (typeof config.paused !== 'boolean') addProblem(problems, '"paused" must be true or false');
	if (typeof config.dryRun !== 'boolean') addProblem(problems, '"dryRun" must be true or false');

	if (!['trusted-bots', 'allowlist'].includes(config.groupMode)) {
		addProblem(problems, '"groupMode" must be "trusted-bots" or "allowlist"');
	}

	for (const key of ['groups', 'blockedGroups']) {
		if (!Array.isArray(config[key]) || config[key].some((jid) => typeof jid !== 'string')) {
			addProblem(problems, `"${key}" must be an array of group JIDs`);
			continue;
		}
		for (const jid of config[key]) {
			if (!GROUP_JID_RE.test(jid)) addProblem(problems, `"${key}" contains an invalid group JID: ${jid}`);
		}
	}

	if (!Array.isArray(config.bots) || config.bots.length === 0) {
		addProblem(problems, '"bots" must be a non-empty array');
	} else {
		const phones = new Set();
		const prefixes = new Set();
		config.bots.forEach((bot, index) => {
			if (!isObject(bot)) {
				addProblem(problems, `bots[${index}] must be an object`);
				return;
			}
			if (typeof bot.name !== 'string' || !bot.name.trim()) {
				addProblem(problems, `bots[${index}].name must be a non-empty string`);
			}
			if (!isPhoneNumber(bot.phone)) {
				addProblem(problems, `bots[${index}].phone must be an international number in digits`);
			} else {
				const phone = normalisePhone(bot.phone);
				if (phones.has(phone)) addProblem(problems, `bots[${index}].phone is duplicated: ${phone}`);
				phones.add(phone);
			}
			if (typeof bot.prefix !== 'string' || !/^\.[a-z]{1,4}$/i.test(bot.prefix)) {
				addProblem(problems, `bots[${index}].prefix must look like ".j" or ".jk"`);
			} else if (prefixes.has(bot.prefix.toLowerCase())) {
				addProblem(problems, `bots[${index}].prefix is duplicated: ${bot.prefix}`);
			} else {
				prefixes.add(bot.prefix.toLowerCase());
			}
			if (typeof bot.enabled !== 'boolean') {
				addProblem(problems, `bots[${index}].enabled must be true or false`);
			}
		});
	}

	for (const tier of [1, 2, 3, 4, 5, 6]) {
		const policy = config.tiers?.[tier];
		if (!isObject(policy)) {
			addProblem(problems, `tiers.${tier} must be an object`);
			continue;
		}
		if (typeof policy.enabled !== 'boolean') {
			addProblem(problems, `tiers.${tier}.enabled must be true or false`);
		}
		if (typeof policy.probability !== 'number' || !Number.isFinite(policy.probability)) {
			addProblem(problems, `tiers.${tier}.probability must be a number`);
		} else if (policy.probability < 0 || policy.probability > 1) {
			addProblem(problems, `tiers.${tier}.probability must be between 0 and 1`);
		}
		if (!Number.isInteger(policy.maxPerHour) || policy.maxPerHour < 0) {
			addProblem(problems, `tiers.${tier}.maxPerHour must be a whole number >= 0`);
		}
	}

	const l = config.limits;
	if (!isObject(l)) {
		addProblem(problems, '"limits" must be an object');
	} else {
		for (const key of [
			'minGapMs',
			'maxPerMinute',
			'maxPerHour',
			'maxPerDay',
			'maxPerBatch',
			'batchWindowMs',
			'maxCardAgeMs',
			'dedupeTtlMs',
			'perSourceMaxPerMinute',
			'lowTierDelayMs',
		]) {
			if (!Number.isInteger(l[key]) || l[key] < 0) {
				addProblem(problems, `limits.${key} must be a whole number >= 0`);
			}
		}
		if (Number.isInteger(l.maxPerBatch) && (l.maxPerBatch < 1 || l.maxPerBatch > 5)) {
			addProblem(problems, 'limits.maxPerBatch must be between 1 and 5');
		}
		if (!isObject(l.jitterMs)) {
			addProblem(problems, 'limits.jitterMs must be an object with min and max');
		} else {
			for (const key of ['min', 'max']) {
				if (!Number.isInteger(l.jitterMs[key]) || l.jitterMs[key] < 0) {
					addProblem(problems, `limits.jitterMs.${key} must be a whole number >= 0`);
				}
			}
			if (l.jitterMs.max < l.jitterMs.min) {
				addProblem(problems, 'limits.jitterMs.max must be >= limits.jitterMs.min');
			}
		}
		if (Number.isInteger(l.maxCardAgeMs) && l.maxCardAgeMs <= 0) {
			addProblem(problems, 'limits.maxCardAgeMs must be > 0');
		}
		if (Number.isInteger(l.dedupeTtlMs) && l.dedupeTtlMs <= 0) {
			addProblem(problems, 'limits.dedupeTtlMs must be > 0');
		}
	}

	if (!isObject(config.control) || !Array.isArray(config.control.allowedNumbers)) {
		addProblem(problems, '"control.allowedNumbers" must be an array');
	} else {
		for (const value of config.control.allowedNumbers) {
			if (!isPhoneNumber(value)) {
				addProblem(problems, `"control.allowedNumbers" contains an invalid number: ${value}`);
			}
		}
	}

	if (!isObject(config.backoff)) {
		addProblem(problems, '"backoff" must be an object');
	} else {
		for (const key of ['rateLimitMs', 'sendFailureMs']) {
			if (!Number.isInteger(config.backoff[key]) || config.backoff[key] < 0) {
				addProblem(problems, `backoff.${key} must be a whole number >= 0`);
			}
		}
	}

	if (!isObject(config.session)) {
		addProblem(problems, '"session" must be an object');
	} else {
		if (!Number.isInteger(config.session.healthCheckMs) || config.session.healthCheckMs < 0) {
			addProblem(problems, 'session.healthCheckMs must be a whole number >= 0');
		}
		if (!Number.isInteger(config.session.warnAgeDays) || config.session.warnAgeDays < 1) {
			addProblem(problems, 'session.warnAgeDays must be a whole number >= 1');
		}
		if (typeof config.session.autoRepair !== 'boolean') {
			addProblem(problems, 'session.autoRepair must be true or false');
		}
		if (typeof config.session.watchdog !== 'boolean') {
			addProblem(problems, 'session.watchdog must be true or false');
		}
	}

	if (!isObject(config.notify)) {
		addProblem(problems, '"notify" must be an object');
	} else {
		if (typeof config.notify.highTier !== 'boolean') {
			addProblem(problems, 'notify.highTier must be true or false');
		}
		if (typeof config.notify.claimSummary !== 'boolean') {
			addProblem(problems, 'notify.claimSummary must be true or false');
		}
	}

	if (!LOG_LEVELS.has(config.logLevel)) {
		addProblem(problems, `"logLevel" must be one of ${[...LOG_LEVELS].join(', ')}`);
	}

	return problems;
}

/** Apply a named profile on top of defaults (arrays replaced wholesale). */
export function applyProfile(config, profileName) {
	const profile = PROFILES[profileName];
	if (!profile) throw new ConfigError(`Unknown profile "${profileName}". Available: ${Object.keys(PROFILES).join(', ')}`);
	return deepMerge(config, profile);
}

/** Parse a boolean env var. */
function envBool(value) {
	const text = String(value ?? '').toLowerCase();
	if (['on', 'true', 'yes', '1'].includes(text)) return true;
	if (['off', 'false', 'no', '0'].includes(text)) return false;
	return null;
}

/** Apply CC_* environment variables on top of a loaded config. */
export function applyEnvOverrides(config) {
	const env = process.env;

	const phone = env.CC_PHONE ?? env.CC_PHONE_NUMBER;
	if (phone) config.phoneNumber = normalisePhone(phone);

	const paused = envBool(env.CC_PAUSED);
	if (paused !== null) config.paused = paused;

	const dryRun = envBool(env.CC_DRY_RUN);
	if (dryRun !== null) config.dryRun = dryRun;

	const logLevel = env.CC_LOG_LEVEL;
	if (logLevel) config.logLevel = logLevel;

	if (env.CC_GROUP_MODE) {
		const mode = String(env.CC_GROUP_MODE).toLowerCase();
		if (['trusted', 'trusted-bots', 'allowlist'].includes(mode)) {
			config.groupMode = mode === 'allowlist' ? 'allowlist' : 'trusted-bots';
		}
	}

	if (env.CC_BLOCK_GROUPS) {
		config.blockedGroups = env.CC_BLOCK_GROUPS
			.split(',')
			.map((jid) => jid.trim())
			.filter(Boolean);
	}

	// Per-bot enable toggles: CC_BOT_JOKER, CC_BOT_SUBARU, CC_BOT_JAKE
	const botNameMap = { joker: 'Joker', subaru: 'Subaru', jake: 'Jake' };
	for (const [key, name] of Object.entries(botNameMap)) {
		const enabled = envBool(env[`CC_BOT_${key.toUpperCase()}`]);
		if (enabled !== null) {
			const bot = config.bots.find((b) => b.name.toLowerCase() === name.toLowerCase());
			if (bot) bot.enabled = enabled;
		}
	}

	// Tier probabilities as percent: CC_TIER_4=50
	for (const tier of [1, 2, 3, 4, 5, 6]) {
		const raw = env[`CC_TIER_${tier}`];
		if (raw === undefined) continue;
		const percent = Number(raw);
		if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
			throw new ConfigError(`CC_TIER_${tier} must be a percent from 0 to 100`);
		}
		config.tiers[tier].probability = percent / 100;
		config.tiers[tier].enabled = percent > 0;
	}

	// Limits
	const maxMinute = Number(env.CC_MAX_MINUTE);
	if (Number.isFinite(maxMinute) && maxMinute >= 1) config.limits.maxPerMinute = Math.floor(maxMinute);
	const maxHour = Number(env.CC_MAX_HOUR);
	if (Number.isFinite(maxHour) && maxHour >= 1) config.limits.maxPerHour = Math.floor(maxHour);
	const maxDay = Number(env.CC_MAX_DAY);
	if (Number.isFinite(maxDay) && maxDay >= 1) config.limits.maxPerDay = Math.floor(maxDay);
	const minGap = Number(env.CC_MIN_GAP);
	if (Number.isFinite(minGap) && minGap >= 0) config.limits.minGapMs = Math.floor(minGap);
	const batch = Number(env.CC_MAX_PER_BATCH);
	if (Number.isFinite(batch) && batch >= 1 && batch <= 5) config.limits.maxPerBatch = Math.floor(batch);
	const lowTierDelay = Number(env.CC_LOW_TIER_DELAY);
	if (Number.isFinite(lowTierDelay) && lowTierDelay >= 0) config.limits.lowTierDelayMs = Math.floor(lowTierDelay);

	// Session
	const healthCheck = Number(env.CC_HEALTH_CHECK_MS);
	if (Number.isFinite(healthCheck) && healthCheck >= 0) config.session.healthCheckMs = Math.floor(healthCheck);
	const warnAge = Number(env.CC_SESSION_WARN_DAYS);
	if (Number.isFinite(warnAge) && warnAge >= 1) config.session.warnAgeDays = Math.floor(warnAge);
	const autoRepair = envBool(env.CC_AUTO_REPAIR);
	if (autoRepair !== null) config.session.autoRepair = autoRepair;
	const watchdog = envBool(env.CC_WATCHDOG);
	if (watchdog !== null) config.session.watchdog = watchdog;

	// Notify
	const notifyHigh = envBool(env.CC_NOTIFY_HIGH_TIER);
	if (notifyHigh !== null) config.notify.highTier = notifyHigh;
	const notifySummary = envBool(env.CC_NOTIFY_SUMMARY);
	if (notifySummary !== null) config.notify.claimSummary = notifySummary;

	// Profile: applied after env overrides so CC_PROFILE wins
	if (env.CC_PROFILE) {
		config = applyProfile(config, env.CC_PROFILE);
		// Re-apply tier env vars on top of the profile
		for (const tier of [1, 2, 3, 4, 5, 6]) {
			const raw = env[`CC_TIER_${tier}`];
			if (raw === undefined) continue;
			const percent = Number(raw);
			config.tiers[tier].probability = percent / 100;
			config.tiers[tier].enabled = percent > 0;
		}
	}

	return config;
}

/** Loads and validates config.json, filling missing keys from DEFAULTS. */
export function loadConfig(file = 'config.json') {
	const configPath = path.resolve(file);
	let user = {};
	if (fs.existsSync(configPath)) {
		let raw;
		try {
			raw = fs.readFileSync(configPath, 'utf8');
		} catch (err) {
			throw new ConfigError(`Could not read ${configPath}: ${err.message}`);
		}
		try {
			user = JSON.parse(raw);
		} catch (err) {
			throw new ConfigError(`${configPath} is not valid JSON: ${err.message}`);
		}
		if (!isObject(user)) throw new ConfigError(`${configPath} must contain a JSON object`);
	}

	const config = deepMerge(structuredClone(DEFAULTS), user);
	const problems = validateConfig(config);
	if (problems.length) {
		throw new ConfigError(`Invalid config:\n- ${problems.join('\n- ')}`);
	}
	return config;
}

/** Load config.json then apply CC_* environment variable overrides. */
export function loadConfigWithEnv(file = 'config.json') {
	const config = loadConfig(file);
	return applyEnvOverrides(config);
}

/** Writes the effective config back atomically, so a crash cannot half-write it. */
export function saveConfig(config, file = 'config.json') {
	const target = path.resolve(file);
	const temp = `${target}.tmp`;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(temp, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	fs.renameSync(temp, target);
}

/** Whether a group chat is in scope for claiming. */
export function groupAllowed(config, jid) {
	if (!jid?.endsWith('@g.us')) return false;
	if (config.blockedGroups.includes(jid)) return false;
	if (config.groupMode === 'allowlist') return config.groups.includes(jid);
	return true;
}

/** Finds a configured game bot by its phone number. */
export function findBotByPhone(config, phone) {
	const digits = normalisePhone(phone);
	return config.bots.find((bot) => normalisePhone(bot.phone) === digits) ?? null;
}

/** Whether an extra DM number may control the bot. */
export function isController(config, phone) {
	return config.control.allowedNumbers
		.map(normalisePhone)
		.includes(normalisePhone(phone));
}

/** List available profile names. */
export function listProfiles() {
	return Object.keys(PROFILES);
}
