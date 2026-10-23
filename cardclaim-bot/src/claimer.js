import { groupAllowed, normalisePhone } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function normaliseText(value) {
	return String(value ?? '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

function countSince(timestamps, cutoff) {
	let count = 0;
	for (const at of timestamps) if (at >= cutoff) count += 1;
	return count;
}

/**
 * Decides whether to claim a card, applies tier/rate limits, and serialises
 * sends. The network call is injected so the whole policy can be tested
 * without WhatsApp.
 *
 * Human behaviour: before sending a claim, the bot marks the chat as read and
 * shows a typing indicator for a plausible duration, then clears it.
 */
export class Claimer {
	#config;
	#send;
	#presence; // (jid, type) => Promise<void>
	#markRead; // (messageKey) => Promise<void>
	#logger;
	#sleep;
	#random;
	#now;

	/** groupJid -> pending burst entries */
	#queues = new Map();
	/** groupJid -> burst timer */
	#timers = new Map();
	/** groupJid|sourcePhone|cardId -> first seen timestamp */
	#seen = new Map();
	/** pending claim responses, newest last */
	#pending = [];
	/** completed claims, newest last (for .last / .stats) */
	#history = [];

	#paused = false;
	#attempts = [];
	#tierAttempts = new Map();
	#sourceAttempts = new Map();
	#sourceBlockedUntil = new Map();
	#lastSentAt = 0;
	#runChain = Promise.resolve();

	stats = {
		detected: 0,
		claimed: 0,
		skipped: 0,
		failed: 0,
		dryRun: 0,
		confirmed: 0,
		rateLimited: 0,
		unmatchedConfirmations: 0,
	};

	constructor({
		config,
		send,
		presence,
		markRead,
		logger,
		sleep: sleepFn = sleep,
		random = Math.random,
		now = Date.now,
	}) {
		this.#config = config;
		this.#send = send;
		this.#presence = presence;
		this.#markRead = markRead;
		this.#logger = logger;
		this.#sleep = sleepFn;
		this.#random = random;
		this.#now = now;
		this.#paused = Boolean(config.paused);
	}

	commandFor(card, source) {
		const prefix = source?.prefix ?? '.j';
		if (card.claimPrefix && card.claimPrefix.toLowerCase() !== prefix.toLowerCase()) {
			this.#logger?.debug?.(
				{ card: card.id, hintPrefix: card.claimPrefix, sourcePrefix: prefix },
				'claim prefix differs from source config; using source prefix',
			);
		}
		return `${prefix} claim ${card.id}`;
	}

	#skip(reason, details = {}, level = 'debug') {
		this.stats.skipped += 1;
		this.#logger?.[level]?.({ ...details, reason }, 'skip');
		return { claimed: false, reason };
	}

	#prune(now = this.#now()) {
		const dayCutoff = now - DAY;
		const hourCutoff = now - HOUR;
		const minuteCutoff = now - MINUTE;

		this.#attempts = this.#attempts.filter((at) => at >= dayCutoff);
		for (const [tier, values] of this.#tierAttempts) {
			this.#tierAttempts.set(tier, values.filter((at) => at >= hourCutoff));
		}
		for (const [phone, values] of this.#sourceAttempts) {
			this.#sourceAttempts.set(phone, values.filter((at) => at >= minuteCutoff));
		}
		for (const [key, at] of this.#seen) {
			if (at < now - this.#config.limits.dedupeTtlMs) this.#seen.delete(key);
		}
		// Keep last 200 history entries
		if (this.#history.length > 200) this.#history = this.#history.slice(-200);
		if (this.#pending.length > 100) this.#pending = this.#pending.slice(-100);
	}

	#gate(entry) {
		if (this.#paused) return 'paused';
		if (!entry.source?.enabled) return 'source-disabled';
		if (!groupAllowed(this.#config, entry.groupJid)) return 'group-not-allowed';

		const tier = Number(entry.card.tier);
		const policy = this.#config.tiers?.[tier];
		if (!policy?.enabled || policy.probability <= 0) return 'tier-disabled';

		const now = this.#now();
		const maxAge = this.#config.limits.maxCardAgeMs;
		if (now - entry.timestamp > maxAge) return 'stale';

		const blockedUntil = this.#sourceBlockedUntil.get(normalisePhone(entry.source.phone)) ?? 0;
		if (blockedUntil > now) return 'source-backoff';

		this.#prune(now);
		const limits = this.#config.limits;
		if (limits.maxPerMinute <= 0 || countSince(this.#attempts, now - MINUTE) >= limits.maxPerMinute) {
			return 'minute-limit';
		}
		if (limits.maxPerHour <= 0 || countSince(this.#attempts, now - HOUR) >= limits.maxPerHour) {
			return 'hour-limit';
		}
		if (limits.maxPerDay <= 0 || countSince(this.#attempts, now - DAY) >= limits.maxPerDay) {
			return 'day-limit';
		}
		if (policy.maxPerHour <= 0) return 'tier-limit';
		const tierAttempts = this.#tierAttempts.get(tier) ?? [];
		if (countSince(tierAttempts, now - HOUR) >= policy.maxPerHour) return 'tier-limit';

		const phone = normalisePhone(entry.source.phone);
		const sourceAttempts = this.#sourceAttempts.get(phone) ?? [];
		if (
			limits.perSourceMaxPerMinute <= 0 ||
			countSince(sourceAttempts, now - MINUTE) >= limits.perSourceMaxPerMinute
		) {
			return 'source-minute-limit';
		}

		return null;
	}

	#delayFor(entry) {
		const now = this.#now();
		const { jitterMs, minGapMs } = this.#config.limits;
		const jitter = jitterMs.min + this.#random() * Math.max(0, jitterMs.max - jitterMs.min);
		const remainingGap = Math.max(0, minGapMs - (now - this.#lastSentAt));

		// Extra human delay for tiers below IV
		let lowTierDelay = 0;
		const tier = Number(entry.card.tier);
		if (tier < 4) {
			lowTierDelay = this.#config.limits.lowTierDelayMs;
		}

		return Math.max(Math.round(jitter), Math.round(remainingGap), Math.round(lowTierDelay));
	}

	#recordAttempt(tier, sourcePhone) {
		const now = this.#now();
		this.#lastSentAt = now;
		this.#attempts.push(now);

		const tierValues = this.#tierAttempts.get(tier) ?? [];
		tierValues.push(now);
		this.#tierAttempts.set(tier, tierValues);

		const phone = normalisePhone(sourcePhone);
		const sourceValues = this.#sourceAttempts.get(phone) ?? [];
		sourceValues.push(now);
		this.#sourceAttempts.set(phone, sourceValues);
	}

	#addHistory(entry, result) {
		this.#history.unshift({
			card: entry.card,
			source: entry.source.name,
			group: entry.groupJid,
			command: result.command,
			claimed: result.claimed,
			reason: result.reason,
			at: this.#now(),
		});
		if (this.#history.length > 200) this.#history = this.#history.slice(0, 200);
	}

	async #humaniseBeforeSend(entry) {
		// Mark the chat as read (like opening it)
		if (this.#markRead && entry.messageKey) {
			try {
				await this.#markRead(entry.messageKey);
			} catch (err) {
				this.#logger?.debug?.(
					{ group: entry.groupJid, err: String(err?.message ?? err) },
					'mark read failed',
				);
			}
		}

		// Show typing indicator for a human-like duration
		if (this.#presence) {
			try {
				await this.#presence(entry.groupJid, 'typing');
			} catch (err) {
				this.#logger?.debug?.(
					{ group: entry.groupJid, err: String(err?.message ?? err) },
					'typing on failed',
				);
			}
		}

		const typingMs = 800 + this.#random() * 1200; // 800ms–2s
		await this.#sleep(typingMs);

		// Clear typing indicator
		if (this.#presence) {
			try {
				await this.#presence(entry.groupJid, 'paused');
			} catch (err) {
				this.#logger?.debug?.(
					{ group: entry.groupJid, err: String(err?.message ?? err) },
					'typing off failed',
				);
			}
		}
	}

	async #execute(entry) {
		const pre = this.#gate(entry);
		if (pre) return this.#skip(pre, { card: entry.card.id, group: entry.groupJid });

		const delay = this.#delayFor(entry);
		if (delay > 0) await this.#sleep(delay);

		const post = this.#gate(entry);
		if (post) return this.#skip(post, { card: entry.card.id, group: entry.groupJid });

		const policy = this.#config.tiers[Number(entry.card.tier)];
		const { command } = entry;

		if (!this.#config.dryRun) {
			// Humanise: mark read + typing indicator before sending. Re-check the
			// gate afterwards so pause/backoff/staleness changes take effect.
			await this.#humaniseBeforeSend(entry);
			const beforeSend = this.#gate(entry);
			if (beforeSend) {
				return this.#skip(beforeSend, { card: entry.card.id, group: entry.groupJid });
			}
		}

		// Record at the actual send attempt, not before the variable typing
		// delay, so minGapMs remains a real gap between network sends.
		this.#recordAttempt(Number(entry.card.tier), entry.source.phone);

		if (this.#config.dryRun) {
			this.stats.dryRun += 1;
			this.#logger?.info?.(
				{
					card: entry.card.id,
					name: entry.card.name,
					series: entry.card.series,
					tier: entry.card.tier,
					group: entry.groupJid,
					source: entry.source.name,
					command,
					probability: policy.probability,
				},
				'DRY RUN — would claim',
			);
			const result = { claimed: false, reason: 'dry-run', command };
			this.#addHistory(entry, result);
			return result;
		}

		try {
			await this.#send(entry.groupJid, command);
			this.stats.claimed += 1;
			this.#pending.push({
				card: entry.card,
				sourcePhone: normalisePhone(entry.source.phone),
				groupJid: entry.groupJid,
				at: this.#now(),
				name: normaliseText(entry.card.name),
				series: normaliseText(entry.card.series),
				tier: Number(entry.card.tier),
			});
			this.#logger?.info?.(
				{
					card: entry.card.id,
					name: entry.card.name,
					series: entry.card.series,
					tier: entry.card.tier,
					group: entry.groupJid,
					source: entry.source.name,
					command,
				},
				'claim sent',
			);
			const result = { claimed: true, reason: 'sent', command };
			this.#addHistory(entry, result);
			return result;
		} catch (err) {
			this.stats.failed += 1;
			this.noteRateLimit(entry.source.phone, this.#config.backoff.sendFailureMs, 'send-failure');
			this.#logger?.error?.(
				{
					card: entry.card.id,
					group: entry.groupJid,
					source: entry.source.name,
					err: String(err?.message ?? err),
				},
				'claim send failed',
			);
			const result = { claimed: false, reason: 'send-failed', command };
			this.#addHistory(entry, result);
			return result;
		}
	}

	#queueRun(entry) {
		const next = this.#runChain.then(() => this.#execute(entry));
		this.#runChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async #flush(groupJid) {
		const entries = this.#queues.get(groupJid) ?? [];
		this.#queues.delete(groupJid);
		if (!entries.length) return;

		entries.sort((a, b) => {
			const tierDiff = Number(b.card.tier) - Number(a.card.tier);
			if (tierDiff !== 0) return tierDiff;
			return a.timestamp - b.timestamp;
		});

		const maxPerBatch = Math.max(1, this.#config.limits.maxPerBatch);
		let attempted = 0;

		for (const entry of entries) {
			if (attempted >= maxPerBatch) {
				entry.resolve(this.#skip('batch-limit', { card: entry.card.id, group: groupJid }));
				continue;
			}

			let result;
			try {
				result = await this.#queueRun(entry);
			} catch (err) {
				this.stats.failed += 1;
				this.#logger?.error?.(
					{ card: entry.card.id, group: groupJid, err: String(err?.message ?? err) },
					'claim pipeline threw',
				);
				result = { claimed: false, reason: 'error' };
			}
			entry.resolve(result);
			if (['sent', 'dry-run', 'send-failed'].includes(result.reason)) attempted += 1;
		}
	}

	#scheduleFlush(groupJid) {
		if (this.#timers.has(groupJid)) return;
		const timer = setTimeout(() => {
			this.#timers.delete(groupJid);
			void this.#flush(groupJid).catch((err) => {
				this.#logger?.error?.(
					{ group: groupJid, err: String(err?.message ?? err) },
					'burst flush failed',
				);
			});
		}, Math.max(0, this.#config.limits.batchWindowMs));
		this.#timers.set(groupJid, timer);
	}

	/**
	 * Adds a card to the group's short burst queue. Resolves when the card has
	 * either been sent, skipped, or dropped in favour of a better card.
	 */
	enqueue(card, context) {
		const { groupJid, source, messageKey = null, timestamp = this.#now() } = context ?? {};
		this.stats.detected += 1;

		if (!source) return Promise.resolve(this.#skip('untrusted-source', { card: card?.id }));
		if (!card?.id) return Promise.resolve(this.#skip('invalid-card', { card: card?.id }));
		if (!groupJid?.endsWith('@g.us')) {
			return Promise.resolve(this.#skip('not-a-group', { card: card.id, group: groupJid }));
		}
		if (!groupAllowed(this.#config, groupJid)) {
			return Promise.resolve(this.#skip('group-not-allowed', { card: card.id, group: groupJid }));
		}

		const tier = Number(card.tier);
		const policy = this.#config.tiers?.[tier];
		if (!policy?.enabled || policy.probability <= 0) {
			return Promise.resolve(
				this.#skip('tier-disabled', { card: card.id, tier, group: groupJid }, 'info'),
			);
		}
		if (this.#now() - timestamp > this.#config.limits.maxCardAgeMs) {
			return Promise.resolve(this.#skip('stale', { card: card.id, tier, group: groupJid }));
		}
		if (this.#random() > policy.probability) {
			return Promise.resolve(
				this.#skip(
					'tier-probability',
					{ card: card.id, tier, probability: policy.probability },
					'info',
				),
			);
		}

		this.#prune();
		const key = `${groupJid}|${normalisePhone(source.phone)}|${card.id}`;
		if (this.#seen.has(key)) {
			return Promise.resolve(this.#skip('duplicate', { card: card.id, group: groupJid }));
		}
		this.#seen.set(key, this.#now());

		return new Promise((resolve) => {
			const entry = {
				card,
				groupJid,
				source,
				messageKey,
				timestamp,
				command: this.commandFor(card, source),
				resolve,
			};
			const queue = this.#queues.get(groupJid) ?? [];
			queue.push(entry);
			this.#queues.set(groupJid, queue);
			this.#scheduleFlush(groupJid);
		});
	}

	/** Pauses all claims without disconnecting. */
	setPaused(paused) {
		this.#paused = Boolean(paused);
		return this.#paused;
	}

	isPaused() {
		return this.#paused;
	}

	/** Blocks a game bot temporarily after a cooldown/rate-limit response. */
	noteRateLimit(sourcePhone, durationMs = this.#config.backoff.rateLimitMs, reason = 'rate-limit') {
		const phone = normalisePhone(sourcePhone);
		const until = this.#now() + Math.max(0, Number(durationMs) || 0);
		this.#sourceBlockedUntil.set(phone, until);
		this.stats.rateLimited += 1;
		this.#logger?.warn?.(
			{ source: phone, durationMs, until, reason },
			'source temporarily backed off',
		);
	}

	/**
	 * Matches a game-bot CLAIMED response to a pending send by group, source,
	 * name, series, and tier. Returns true when a pending claim was found.
	 */
	confirmClaim(confirmation, sourcePhone, groupJid = null) {
		if (!confirmation) return false;
		const phone = normalisePhone(sourcePhone);
		const now = this.#now();
		this.#pending = this.#pending.filter((item) => now - item.at <= 5 * MINUTE);

		const name = normaliseText(confirmation.name);
		const series = normaliseText(confirmation.series);
		const tier = confirmation.tier === null || confirmation.tier === undefined
			? null
			: Number(confirmation.tier);

		for (let i = this.#pending.length - 1; i >= 0; i -= 1) {
			const item = this.#pending[i];
			if (groupJid && item.groupJid !== groupJid) continue;
			if (item.sourcePhone !== phone) continue;
			if (name && item.name !== name) continue;
			if (series && item.series !== series) continue;
			if (tier !== null && item.tier !== tier) continue;

			this.#pending.splice(i, 1);
			this.stats.confirmed += 1;
			this.#logger?.info?.(
				{
					card: item.card.id,
					name: item.card.name,
					series: item.card.series,
					tier: item.card.tier,
					group: item.groupJid,
				},
				'claim confirmed by game bot',
			);
			return true;
		}

		this.stats.unmatchedConfirmations += 1;
		this.#logger?.debug?.(
			{ source: phone, group: groupJid, name: confirmation.name, series: confirmation.series, tier },
			'unmatched CLAIMED response',
		);
		return false;
	}

	pendingCount() {
		return this.#pending.length;
	}

	/** Last N claims, newest first. */
	recent(limit = 10) {
		return this.#history.slice(0, limit);
	}

	/** Claims in the last 24 hours. */
	claimedToday() {
		const cutoff = this.#now() - DAY;
		return this.#history.filter((h) => h.at >= cutoff && h.claimed).length;
	}

	/** Claims in the last 7 days. */
	claimedWeek() {
		const cutoff = this.#now() - 7 * DAY;
		return this.#history.filter((h) => h.at >= cutoff && h.claimed).length;
	}

	/** Resolves when every queued/send operation for a group has settled. */
	async drain(groupJid) {
		const timer = this.#timers.get(groupJid);
		if (timer) {
			clearTimeout(timer);
			this.#timers.delete(groupJid);
			await this.#flush(groupJid);
		}
		await this.#runChain;
	}
}
