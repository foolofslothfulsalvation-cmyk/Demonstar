import { applyProfile, DEFAULTS, listProfiles, normalisePhone, saveConfig } from './config.js';

const CONTROL_RE = /^\.(help|status|pause|resume|rates|set|groups|block|unblock|claim|profile|t[1-6]|menu|stats|last|export|kill)\b/i;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

export function isCommand(text) {
	return CONTROL_RE.test(String(text ?? '').trim());
}

const HELP = [
	'Demonstar — control commands (DM the bot number only)',
	'',
	'Status & control',
	'  .status          connection, mode, counters',
	'  .rates           tier chances and global limits',
	'  .menu            full command menu',
	'  .pause / .resume stop or resume all claiming',
	'  .kill            stop everything and disconnect',
	'',
	'Tiers (toggle or set percent)',
	'  .t1 … .t6 on|off  enable or disable a tier',
	'  .set t4 50        set Tier IV attempt chance to 50%',
	'',
	'Profiles (fixed rates + speeds)',
	'  .profile          list profiles',
	'  .profile balanced | conservative | aggressive | stealth',
	'',
	'Global limits',
	'  .set maxminute 6   claims per minute',
	'  .set maxhour 20    claims per hour',
	'  .set maxday 80     claims per day',
	'  .set gap 2500      minimum gap between sends (ms)',
	'  .set batch 1       cards per spawn burst',
	'',
	'Source bots',
	'  .set bot joker on|off   enable/disable Joker',
	'  .set bot subaru on|off  enable/disable Subaru',
	'  .set bot jake on|off    enable/disable Jake',
	'',
	'Groups',
	'  .block <groupJid>   never claim in this group',
	'  .unblock <groupJid> undo .block',
	'  .groups             list joined groups and JIDs',
	'',
	'History & reports',
	'  .stats            claims today / this week',
	'  .last [n]         last n claimed cards',
	'  .export           claim history as JSON',
	'',
	'Misc',
	'  .set dryrun on|off  log only / send real claims',
	'  .set mode trusted   follow trusted bots / allowlist',
	'  .help             this message',
].join('\n');

function percent(value) {
	return `${Math.round(value * 100)}%`;
}

function persist(config, configPath) {
	if (!configPath) return true;
	saveConfig(config, configPath);
	return true;
}

function integer(value, name, min, max) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max) {
		throw new Error(`${name} must be a whole number from ${min} to ${max}`);
	}
	return number;
}

function bool(value) {
	const text = String(value ?? '').toLowerCase();
	if (['on', 'true', 'yes', '1'].includes(text)) return true;
	if (['off', 'false', 'no', '0'].includes(text)) return false;
	throw new Error('expected on or off');
}

function enableTier(config, tier) {
	const policy = config.tiers[tier];
	policy.enabled = true;

	// Older versions zeroed these values when disabling a tier. Restore a
	// usable policy when such a tier is switched back on. Tier I has no active
	// default, so start it conservatively at one attempt per hour.
	if (policy.probability <= 0) {
		policy.probability = DEFAULTS.tiers[tier].probability || 1;
	}
	if (policy.maxPerHour <= 0) {
		policy.maxPerHour = DEFAULTS.tiers[tier].maxPerHour || 1;
	}
}

function tierLine(config, tier) {
	const policy = config.tiers[tier];
	const state = policy.enabled ? percent(policy.probability) : 'off';
	return `  Tier ${ROMAN[tier]}: ${state.padEnd(6)}  max ${policy.maxPerHour}/hour`;
}

function ratesText(config) {
	const lines = ['Tier rates:'];
	for (const tier of [6, 5, 4, 3, 2, 1]) {
		lines.push(tierLine(config, tier));
	}
	const l = config.limits;
	lines.push(
		'',
		`Limits:  ${l.maxPerMinute}/min  ·  ${l.maxPerHour}/hr  ·  ${l.maxPerDay}/day`,
		`Gap:     ${l.minGapMs} ms  ·  jitter ${l.jitterMs.min}–${l.jitterMs.max} ms  ·  batch ${l.maxPerBatch}`,
		`Low tier delay: ${l.lowTierDelayMs} ms  ·  Mode: ${config.groupMode}  ·  Dry run: ${config.dryRun ? 'on' : 'off'}`,
	);
	return lines.join('\n');
}

function profilesText() {
	const names = listProfiles();
	return [
		'Available profiles:',
		...names.map((name) => `  ${name}`),
		'',
		'Usage: .profile <name>   (e.g. .profile aggressive)',
		'Profiles set tier chances, speed limits, and burst caps all at once.',
	].join('\n');
}

async function groupsText(config, sock) {
	if (!sock?.groupFetchAllParticipating) return 'Group listing is not available while disconnected.';
	const all = await sock.groupFetchAllParticipating();
	const groups = Object.values(all ?? {}).sort((a, b) =>
		String(a.subject ?? '').localeCompare(String(b.subject ?? '')),
	);

	if (!groups.length) return 'No groups found on this account.';

	const lines = [`Groups (${groups.length}):`];
	for (const group of groups.slice(0, 50)) {
		const flags = [];
		if (config.blockedGroups.includes(group.id)) flags.push('blocked');
		if (config.groupMode === 'allowlist' && config.groups.includes(group.id)) flags.push('watched');
		if (group.announce) flags.push('announce-only');
		lines.push(
			`${group.subject ?? '(no subject)'}${flags.length ? ` [${flags.join(', ')}]` : ''}\n  ${group.id}`,
		);
	}
	if (groups.length > 50) lines.push(`… and ${groups.length - 50} more`);
	return lines.join('\n');
}

function statsText(claimer, config) {
	const today = claimer.claimedToday?.() ?? 0;
	const week = claimer.claimedWeek?.() ?? 0;
	const pending = claimer.pendingCount?.() ?? 0;
	const s = claimer.stats ?? {};
	return [
		'Claim stats:',
		`  Today:   ${today}`,
		`  Week:    ${week}`,
		`  Detected: ${s.detected ?? 0}`,
		`  Sent:    ${s.claimed ?? 0}`,
		`  Confirmed: ${s.confirmed ?? 0}`,
		`  Skipped: ${s.skipped ?? 0}`,
		`  Failed:  ${s.failed ?? 0}`,
		`  Dry run: ${s.dryRun ?? 0}`,
		`  Pending confirmations: ${pending}`,
		`  Paused: ${claimer.isPaused?.() ? 'yes' : 'no'}`,
		`  Dry run: ${config.dryRun ? 'on' : 'off'}`,
	].join('\n');
}

function lastText(claimer, n = 10) {
	const recent = claimer.recent?.(n) ?? [];
	if (!recent.length) return 'No claims recorded yet.';
	const lines = [`Last ${recent.length} claim(s):`];
	for (const h of recent) {
		const when = new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		const status = h.claimed ? '✅' : `❌ (${h.reason})`;
		lines.push(
			`  ${when} ${status} ${ROMAN[h.card.tier]} ${h.card.name} (${h.card.series}) — ${h.card.id}`,
		);
	}
	return lines.join('\n');
}

function exportText(claimer) {
	const recent = claimer.recent?.(200) ?? [];
	return JSON.stringify(
		{
			exportedAt: new Date().toISOString(),
			stats: claimer.stats ?? {},
			history: recent,
		},
		null,
		2,
	);
}

/**
 * Handles one authorized DM command. Mutating commands are written back to
 * config.json immediately, so they survive a restart.
 *
 * @param {object} params
 * @param {import('./config.js').Config} params.config
 * @param {string} params.configPath
 * @param {import('./claimer.js').Claimer} params.claimer
 * @param {object} params.sock
 * @param {object} params.logger
 * @param {Function} [params.notifyDm]
 * @returns {Promise<string>} reply text
 */
export async function handleCommand({ text, config, configPath, claimer, sock, logger, notifyDm }) {
	const parts = String(text ?? '').trim().split(/\s+/);
	const command = (parts.shift() ?? '').toLowerCase();
	const args = parts;

	try {
		if (command === '.help') return HELP;

		if (command === '.menu') return HELP;

		if (command === '.profile') {
			if (!args[0]) {
				return profilesText();
			}
			const name = args[0].toLowerCase();
			const available = listProfiles();
			if (!available.includes(name)) {
				return `Unknown profile "${name}". Available: ${available.join(', ')}`;
			}
			// Build a base from defaults, apply profile, then merge live values
			const base = deepMerge(structuredClone(DEFAULTS), config);
			const profileConfig = applyProfile(base, name);
			// Copy profile tiers and limits into live config
			for (const tier of [1, 2, 3, 4, 5, 6]) {
				if (profileConfig.tiers?.[tier]) config.tiers[tier] = { ...profileConfig.tiers[tier] };
			}
			if (profileConfig.limits) config.limits = { ...profileConfig.limits };
			if (profileConfig.groupMode !== undefined) config.groupMode = profileConfig.groupMode;
			persist(config, configPath);
			return `Profile switched to "${name}". Rates updated.`;
		}

		if (command === '.status') {
			const s = claimer?.stats ?? {};
			const connected = Boolean(sock?.user?.id);
			const paused = config.paused || claimer?.isPaused?.();
			return [
				`Connection: ${connected ? 'connected' : 'not connected'}`,
				`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}${paused ? ' (paused)' : ''}`,
				`Follow: ${config.groupMode}`,
				`Tiers: ${[6, 5, 4, 3, 2, 1]
					.map((tier) => `${ROMAN[tier]}=${config.tiers[tier].enabled ? percent(config.tiers[tier].probability) : 'off'}`)
					.join('  ')}`,
				`Limits: ${config.limits.maxPerMinute}/min · ${config.limits.maxPerHour}/hr · ${config.limits.maxPerDay}/day`,
				`Detected: ${s.detected ?? 0} · Sent: ${s.claimed ?? 0} · Confirmed: ${s.confirmed ?? 0}`,
				`Skipped: ${s.skipped ?? 0} · Failed: ${s.failed ?? 0} · Dry run: ${s.dryRun ?? 0}`,
				`Pending: ${claimer?.pendingCount?.() ?? 0}`,
				'',
				'Use .rates for details, .profile to switch presets, .stats for history.',
			].join('\n');
		}

		if (command === '.rates') return ratesText(config);

		if (command === '.stats') return statsText(claimer, config);

		if (command === '.last') {
			const n = args[0] ? integer(args[0], 'number', 1, 50) : 10;
			return lastText(claimer, n);
		}

		if (command === '.export') {
			const json = exportText(claimer);
			return `Claim history (JSON):\n\`\`\`json\n${json}\n\`\`\``;
		}

		// Tier toggle: .t4 on / .t4 off
		const tierToggle = command.match(/^\.t([1-6])$/);
		if (tierToggle) {
			const tier = Number(tierToggle[1]);
			const value = args[0];
			if (value === undefined) {
				const policy = config.tiers[tier];
				return `Tier ${ROMAN[tier]} is ${policy.enabled ? percent(policy.probability) : 'off'} (max ${policy.maxPerHour}/hour).`;
			}
			const enabled = bool(value);
			if (enabled) enableTier(config, tier);
			else config.tiers[tier].enabled = false;
			persist(config, configPath);
			return `Tier ${ROMAN[tier]} is now ${enabled ? 'enabled' : 'disabled'}.`;
		}

		if (command === '.pause' || command === '.claim') {
			if (command === '.claim' && args[0]?.toLowerCase() === 'status') {
				return handleCommand({ text: '.status', config, configPath, claimer, sock, logger, notifyDm });
			}
			const wantsPause = command === '.pause' || args[0]?.toLowerCase() === 'off';
			const wantsResume = command === '.resume' || args[0]?.toLowerCase() === 'on';
			if (!wantsPause && !wantsResume) {
				return `Claiming is ${claimer?.isPaused?.() ? 'paused' : 'active'}. Use .pause or .resume.`;
			}
			claimer?.setPaused?.(wantsPause);
			config.paused = wantsPause;
			persist(config, configPath);
			return wantsPause ? '⏸️ Claiming paused.' : '▶️ Claiming resumed.';
		}

		if (command === '.resume') {
			claimer?.setPaused?.(false);
			config.paused = false;
			persist(config, configPath);
			return '▶️ Claiming resumed.';
		}

		if (command === '.kill') {
			claimer?.setPaused?.(true);
			config.paused = true;
			persist(config, configPath);
			// The message handler disconnects after sending this reply. Closing the
			// socket here would make the acknowledgement impossible to deliver.
			return '🛑 Claiming paused. Disconnecting…';
		}

		if (command === '.groups') {
			return groupsText(config, sock);
		}

		if (command === '.block' || command === '.unblock') {
			const jid = args[0];
			if (!jid?.endsWith('@g.us')) {
				return 'Usage: .block <groupJid>  (use .groups to see JIDs)';
			}
			if (command === '.block') {
				if (!config.blockedGroups.includes(jid)) config.blockedGroups.push(jid);
			} else {
				config.blockedGroups = config.blockedGroups.filter((value) => value !== jid);
			}
			persist(config, configPath);
			return `${command === '.block' ? 'Blocked' : 'Unblocked'} ${jid}.`;
		}

		if (command === '.set') {
			const key = (args[0] ?? '').toLowerCase();
			const value = args[1];
			const tierMatch = key.match(/^(?:t|tier)([1-6])$/);
			if (tierMatch) {
				const tier = Number(tierMatch[1]);
				const chance = integer(value, `Tier ${ROMAN[tier]} percent`, 0, 100);
				config.tiers[tier].probability = chance / 100;
				if (chance > 0) enableTier(config, tier);
				else config.tiers[tier].enabled = false;
				persist(config, configPath);
				return `Tier ${ROMAN[tier]} set to ${chance}%.`;
			}

			if (key === 'maxminute') {
				config.limits.maxPerMinute = integer(value, 'maxminute', 1, 600);
				persist(config, configPath);
				return `Global limit set to ${config.limits.maxPerMinute}/minute.`;
			}
			if (key === 'maxhour') {
				config.limits.maxPerHour = integer(value, 'maxhour', 1, 5000);
				persist(config, configPath);
				return `Global limit set to ${config.limits.maxPerHour}/hour.`;
			}
			if (key === 'maxday') {
				config.limits.maxPerDay = integer(value, 'maxday', 1, 50000);
				persist(config, configPath);
				return `Global limit set to ${config.limits.maxPerDay}/day.`;
			}
			if (key === 'gap') {
				config.limits.minGapMs = integer(value, 'gap', 0, 600000);
				persist(config, configPath);
				return `Minimum gap set to ${config.limits.minGapMs} ms.`;
			}
			if (key === 'batch') {
				config.limits.maxPerBatch = integer(value, 'batch', 1, 5);
				persist(config, configPath);
				return `Batch limit set to ${config.limits.maxPerBatch} card(s) per spawn burst.`;
			}
			if (key === 'lowtier') {
				config.limits.lowTierDelayMs = integer(value, 'lowtier', 0, 3600000);
				persist(config, configPath);
				return `Low tier delay set to ${config.limits.lowTierDelayMs} ms.`;
			}
			if (key === 'dryrun') {
				config.dryRun = bool(value);
				persist(config, configPath);
				return `Dry run is now ${config.dryRun ? 'ON — nothing will be sent.' : 'OFF — real claims will be sent.'}`;
			}
			if (key === 'mode') {
				const mode = String(value ?? '').toLowerCase();
				if (!['trusted', 'trusted-bots', 'allowlist'].includes(mode)) {
					return 'Usage: .set mode trusted  or  .set mode allowlist';
				}
				config.groupMode = mode === 'allowlist' ? 'allowlist' : 'trusted-bots';
				persist(config, configPath);
				return `Group mode: ${config.groupMode}.`;
			}
			if (key === 'bot') {
				const name = String(value ?? '').toLowerCase();
				const enabled = bool(args[2]);
				const bot = config.bots.find((entry) => entry.name.toLowerCase() === name);
				if (!bot) {
					return `Unknown bot. Available: ${config.bots.map((entry) => entry.name).join(', ')}`;
				}
				bot.enabled = enabled;
				persist(config, configPath);
				return `${bot.name} is now ${enabled ? 'enabled' : 'disabled'}.`;
			}

			return HELP;
		}

		return 'Unknown command. Try .help';
	} catch (err) {
		logger?.warn?.({ err: String(err?.message ?? err), command }, 'control command failed');
		return `Error: ${err?.message ?? err}`;
	}
}

/** Deep merge helper for profile application. */
function deepMerge(base, override) {
	if (Array.isArray(override)) return override;
	if (!override || typeof override !== 'object') return override;
	const out = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] =
			value && typeof value === 'object' && !Array.isArray(value)
				? deepMerge(base?.[key] ?? {}, value)
				: value;
	}
	return out;
}

function structuredClone(value) {
	return globalThis.structuredClone?.(value) ?? JSON.parse(JSON.stringify(value));
}
