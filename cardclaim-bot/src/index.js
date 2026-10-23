#!/usr/bin/env node
/**
 * Demonstar — WhatsApp card claim bot.
 *
 * Links to WhatsApp as a companion device using an 8-character pairing code
 * (never a QR code), watches messages from the configured game bots, and sends
 * the appropriate claim command under conservative rate limits.
 *
 * Human behaviour: marks chats read and shows typing before claiming.
 * Reliability: health checks, session expiry warnings, auto-repair, watchdog.
 */
import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
dotenv.config();

import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	isJidGroup,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from 'baileys';

import { isPhoneNumber, loadConfigWithEnv, normalisePhone } from './config.js';
import { createLogger } from './logger.js';
import { Claimer } from './claimer.js';
import { classifyGameMessage, extractText, parseCards } from './parser.js';
import {
	findTrustedBot,
	isAuthorizedControl,
	ownPhone,
	phoneFromJid,
} from './identity.js';
import { handleCommand, isCommand } from './commands.js';

const AUTH_DIR = 'auth_info';
const GROUP_WRITABLE_TTL_MS = 5 * 60 * 1000;
const SESSION_WARN_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-warn every 6 hours

const runtime = {
	stopping: false,
	socket: null,
	pairing: null, // { requested, timer } — cleared on repair/reconnect
	config: null,
	configPath: null,
	logger: null,
	claimer: null,
	reconnectTimer: null,
	reconnectAttempts: 0,
	pairingAttempts: 0,
	groupNames: new Map(),
	groupWritable: new Map(),
	sessionStartedAt: null,
	sessionWarnedAt: null,
	healthTimer: null,
	connecting: false, // prevent double-connect
};

function die(message) {
	console.error(`\n${message}\n`);
	process.exit(1);
}

function resolvePhone(config) {
	const value = process.env.CC_PHONE ?? config.phoneNumber;
	const phone = normalisePhone(value);
	if (!phone) {
		die(
			'No WhatsApp number configured. Set "phoneNumber" in config.json or CC_PHONE.\n' +
				'Use international format, digits only, e.g. 2349153327424.',
		);
	}
	if (!isPhoneNumber(phone)) {
		die(
			`"${value}" is not a valid international number.\n` +
				'Use country code and digits only, with no leading 0: e.g. 2349153327424.',
		);
	}
	return phone;
}

function clearPairingTimer() {
	if (runtime.pairing?.timer) {
		clearTimeout(runtime.pairing.timer);
		runtime.pairing.timer = null;
	}
}

function cacheGroups(groups) {
	for (const group of groups ?? []) {
		if (!group?.id) continue;
		runtime.groupNames.set(group.id, group.subject ?? '(no subject)');
		runtime.groupWritable.delete(group.id);
	}
}

async function requestPairingCode(sock, state, pairing) {
	if (runtime.stopping || state.creds.registered || pairing.requested) return;
	pairing.requested = true;
	runtime.pairingAttempts += 1;

	if (runtime.pairingAttempts > 8) {
		die(
			'Too many pairing-code attempts. Stop the bot, archive auth_info/, and start again.\n' +
				'On the phone use: WhatsApp Business → Settings → Linked devices → Link with phone number instead.',
		);
	}

	try {
		const code = await sock.requestPairingCode(runtime.config.phoneNumber);
		if (!code) throw new Error('WhatsApp returned an empty pairing code');
		const printable = String(code).toUpperCase();
		console.log('\n========================================');
		console.log(`  WHATSAPP PAIRING CODE: ${printable}`);
		console.log('========================================');
		console.log('\nOn the phone: WhatsApp Business → Settings → Linked devices');
		console.log('→ Link a device → Link with phone number instead');
		console.log('Enter the code above. No QR code is used.\n');

		pairing.timer = setTimeout(() => {
			if (runtime.stopping || state.creds.registered) return;
			pairing.requested = false;
			runtime.logger?.warn?.('pairing code expired; requesting a new one');
			void requestPairingCode(sock, state, pairing);
		}, 75000);
	} catch (err) {
		pairing.requested = false;
		runtime.logger?.error?.(
			{ err: String(err?.message ?? err) },
			'pairing-code request failed; will retry while the socket is alive',
		);
		pairing.timer = setTimeout(() => {
			if (runtime.stopping || state.creds.registered) return;
			void requestPairingCode(sock, state, pairing);
		}, 5000);
	}
}

function scheduleReconnect(reason, baseDelayMs = 3000) {
	if (runtime.stopping || runtime.reconnectTimer || runtime.connecting) return;
	runtime.reconnectAttempts += 1;
	const delay = Math.min(
		120000,
		baseDelayMs * 2 ** Math.min(runtime.reconnectAttempts - 1, 5),
	);
	const jitter = Math.floor(Math.random() * 1000);
	runtime.logger?.warn?.(
		{ reason, delayMs: delay + jitter, attempt: runtime.reconnectAttempts },
		'reconnecting',
	);
	runtime.reconnectTimer = setTimeout(() => {
		runtime.reconnectTimer = null;
		void safeConnect().catch((err) => {
			runtime.logger?.error?.(
				{ err: String(err?.message ?? err) },
				'socket setup failed',
			);
			scheduleReconnect('setup-failed', 5000);
		});
	}, delay + jitter);
}

function handleClose(lastDisconnect) {
	if (runtime.stopping) return;
	const statusCode = lastDisconnect?.error?.output?.statusCode;
	runtime.logger?.warn?.({ statusCode }, 'connection closed');

	if (statusCode === DisconnectReason.loggedOut) {
		if (runtime.config.session.autoRepair) {
			runtime.logger?.warn?.(
				'Session logged out. Auto-repair: archiving auth_info/ and re-pairing.',
			);
			archiveAndRepair();
			return;
		}
		die(
			'WhatsApp unlinked this device.\n' +
				'Archive auth_info/ and start again to pair with a new code.',
		);
	}
	if (statusCode === DisconnectReason.multideviceMismatch) {
		if (runtime.config.session.autoRepair) {
			runtime.logger?.warn?.(
				'Multi-device mismatch. Auto-repair: archiving auth_info/ and re-pairing.',
			);
			archiveAndRepair();
			return;
		}
		die(
			'Multi-device mismatch: another client re-linked this session.\n' +
				'Archive auth_info/ and pair only one bot instance.',
		);
	}

	scheduleReconnect(
		'connection-closed',
		statusCode === DisconnectReason.restartRequired ? 1000 : 3000,
	);
}

function archiveAndRepair() {
	clearPairingTimer();
	stopSessionChecks();

	// End the old socket so its pairing timer and listeners don't linger.
	if (runtime.socket) {
		try {
			runtime.socket.end(undefined);
		} catch {}
		runtime.socket = null;
	}
	if (runtime.reconnectTimer) {
		clearTimeout(runtime.reconnectTimer);
		runtime.reconnectTimer = null;
	}

	const backup = `auth_info.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
	try {
		if (fs.existsSync(AUTH_DIR)) {
			fs.renameSync(AUTH_DIR, backup);
			runtime.logger?.info?.({ backup }, 'auth_info archived');
		}
	} catch (err) {
		runtime.logger?.error?.({ err: String(err?.message ?? err) }, 'could not archive auth_info');
	}
	runtime.reconnectAttempts = 0;
	runtime.pairingAttempts = 0;
	runtime.sessionStartedAt = null;
	runtime.sessionWarnedAt = null;
	runtime.connecting = false;
	void safeConnect().catch((err) => {
		runtime.logger?.error?.(
			{ err: String(err?.message ?? err) },
			'socket setup failed after session repair',
		);
		scheduleReconnect('repair-setup-failed', 5000);
	});
}

async function onConnectionUpdate(sock, state, update, pairing) {
	const { connection, lastDisconnect, qr } = update;

	if (qr && !state.creds.registered) {
		await requestPairingCode(sock, state, pairing);
	}

	if (connection === 'open') {
		clearPairingTimer();
		runtime.reconnectAttempts = 0;
		runtime.pairingAttempts = 0;
		runtime.sessionStartedAt = runtime.sessionStartedAt ?? Date.now();
		runtime.sessionWarnedAt = null;
		runtime.logger?.info?.(
			{ me: sock.user?.id ?? 'unknown', phone: runtime.config.phoneNumber },
			'connected to WhatsApp',
		);
		startSessionChecks(sock);
	}

	if (connection === 'close') {
		clearPairingTimer();
		stopSessionChecks();
		handleClose(lastDisconnect);
	}
}

function startSessionChecks(sock) {
	stopSessionChecks();
	const { healthCheckMs, warnAgeDays } = runtime.config.session;

	if (healthCheckMs > 0) {
		runtime.healthTimer = setInterval(() => {
			void healthCheck(sock);
		}, healthCheckMs);
	}

	if (warnAgeDays > 0 && runtime.sessionStartedAt) {
		const ageMs = Date.now() - runtime.sessionStartedAt;
		const ageDays = ageMs / (1000 * 60 * 60 * 24);
		if (ageDays >= warnAgeDays && (!runtime.sessionWarnedAt || Date.now() - runtime.sessionWarnedAt >= SESSION_WARN_INTERVAL_MS)) {
			runtime.sessionWarnedAt = Date.now();
			runtime.logger?.warn?.(
				{ ageDays: Math.round(ageDays * 10) / 10 },
				'SESSION EXPIRY WARNING: WhatsApp linked devices can be logged out after 14 days. Open WhatsApp on your primary phone soon.',
			);
			void notifyDm(
				`⚠️ Session age: ${Math.round(ageDays)} days. WhatsApp logs out linked devices after 14 days of phone inactivity. Open WhatsApp on your primary phone to stay linked.`,
			);
		}
	}
}

function stopSessionChecks() {
	if (runtime.healthTimer) {
		clearInterval(runtime.healthTimer);
		runtime.healthTimer = null;
	}
}

async function healthCheck(sock) {
	try {
		// Use the same ping IQ as Baileys' own keep-alive. `query` is a function;
		// it has no `presence` method.
		await sock.query({
			tag: 'iq',
			attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p' },
			content: [{ tag: 'ping', attrs: {} }],
		});
		runtime.logger?.debug?.('health check ok');
	} catch (err) {
		runtime.logger?.warn?.(
			{ err: String(err?.message ?? err) },
			'health check failed',
		);
		// Don't auto-repair on health check failure — just reconnect.
		// Auto-repair (archiving auth_info) is only for loggedOut/multideviceMismatch.
		if (!runtime.stopping && !runtime.reconnectTimer && !runtime.connecting) {
			scheduleReconnect('health-check-failed', 5000);
		}
	}
}

async function notifyDm(text) {
	if (!runtime.socket) return;
	try {
		const me = runtime.socket.user?.id;
		if (me) await runtime.socket.sendMessage(me, { text });
	} catch (err) {
		runtime.logger?.debug?.({ err: String(err?.message ?? err) }, 'DM notify failed');
	}
}

async function isGroupWritable(sock, jid) {
	const now = Date.now();
	const cached = runtime.groupWritable.get(jid);
	if (cached && now - cached.at < GROUP_WRITABLE_TTL_MS) return cached.writable;

	let writable = true;
	try {
		const meta = await sock.groupMetadata(jid);
		if (meta.announce) {
			const meId = sock.user?.id;
			const meLid = sock.user?.lid;
			const mePhone = ownPhone(sock);
			const me = meta.participants?.find((participant) => {
				if (participant.id === meId || participant.id === meLid) return true;
				if (participant.lid && meLid && participant.lid === meLid) return true;
				if (participant.phoneNumber) {
					return phoneFromJid(participant.phoneNumber) === mePhone;
				}
				return phoneFromJid(participant.id) === mePhone;
			});
			writable = Boolean(me && ['admin', 'superadmin'].includes(me.admin));
		}
	} catch (err) {
		runtime.logger?.debug?.(
			{ group: jid, err: String(err?.message ?? err) },
			'could not read group metadata',
		);
	}

	runtime.groupWritable.set(jid, { at: now, writable });
	if (!writable) {
		runtime.logger?.info?.({ group: jid }, 'skipping announce-only group (bot is not admin)');
	}
	return writable;
}

async function handleMessage(sock, msg) {
	const key = msg?.key;
	const remoteJid = key?.remoteJid;
	if (!remoteJid) return;
	if (
		msg.message?.protocolMessage ||
		msg.message?.reactionMessage ||
		msg.message?.pollUpdateMessage
	) {
		return;
	}

	const text = extractText(msg.message);
	if (!text) return;

	const group = isJidGroup(remoteJid);
	const trimmed = text.trim();

	// Control commands are only accepted in a DM, never in a group.
	if (!group && isCommand(trimmed)) {
		if (!isAuthorizedControl(msg, sock, runtime.config)) {
			runtime.logger?.debug?.({ jid: remoteJid }, 'ignored unauthorized control command');
			return;
		}
		const killRequested = /^\.kill\b/i.test(trimmed);
		try {
			const reply = await handleCommand({
				text: trimmed,
				config: runtime.config,
				configPath: runtime.configPath,
				claimer: runtime.claimer,
				sock,
				logger: runtime.logger,
				notifyDm,
			});
			if (reply) await sock.sendMessage(remoteJid, { text: reply });
		} finally {
			// A kill command must not trigger the normal close/reconnect path.
			if (killRequested) await shutdown();
		}
		return;
	}

	// Never react to our own group messages, including our own claim commands.
	if (key.fromMe) return;

	const source = findTrustedBot(runtime.config, msg);
	if (!source) return;

	if (!group) {
		runtime.logger?.debug?.(
			{ source: source.name, jid: remoteJid },
			'ignoring card-like DM from game bot (this bot claims in groups)',
		);
		return;
	}

	const cards = parseCards(text, {
		senderJid: key.participant ?? remoteJid,
	});
	const timestamp = Number(msg.messageTimestamp ?? 0) * 1000 || Date.now();

	if (cards.length) {
		if (!(await isGroupWritable(sock, remoteJid))) return;

		for (const card of cards) {
			runtime.logger?.info?.(
				{
					card: card.id,
					name: card.name,
					series: card.series,
					tier: card.tier,
					group: remoteJid,
					groupName: runtime.groupNames.get(remoteJid),
					source: source.name,
				},
				'card detected',
			);

			// High-tier notification: DM yourself when Tier V/VI appears
			if (
				runtime.config.notify.highTier &&
				Number(card.tier) >= 5
			) {
				void notifyDm(
					`🎴 Tier ${card.tier} appeared!\n${card.name} — ${card.series}\nID: ${card.id}\nGroup: ${runtime.groupNames.get(remoteJid) ?? remoteJid}`,
				);
			}

			void runtime.claimer
				.enqueue(card, { groupJid: remoteJid, source, messageKey: key, timestamp })
				.catch((err) => {
					runtime.logger?.error?.(
						{ card: card.id, err: String(err?.message ?? err) },
						'claim enqueue failed',
					);
				});
		}
		return;
	}

	const notice = classifyGameMessage(text);
	if (notice?.type === 'claimed') {
		const matched = runtime.claimer.confirmClaim(notice.confirmation, source.phone, remoteJid);
		runtime.logger?.[matched ? 'info' : 'debug']?.(
			{
				source: source.name,
				cardName: notice.confirmation?.name,
				series: notice.confirmation?.series,
				tier: notice.confirmation?.tier,
			},
			matched ? 'claim confirmation matched' : 'unmatched claim confirmation',
		);
		return;
	}
	if (notice?.type === 'rate-limit') {
		runtime.logger?.warn?.(
			{ source: source.name, text: text.slice(0, 300) },
			'game bot sent a cooldown/rate-limit notice',
		);
		runtime.claimer.noteRateLimit(source.phone);
		return;
	}
	if (notice?.type === 'already-claimed') {
		runtime.logger?.debug?.({ source: source.name }, 'game bot says the card is already claimed');
		return;
	}

	if (/\bCARD\b/i.test(text)) {
		runtime.logger?.warn?.(
			{ source: source.name, text: text.slice(0, 500) },
			'trusted card message did not match the parser',
		);
	}
}

async function onMessages(sock, payload) {
	if (payload?.type !== 'notify') return;
	for (const message of payload.messages ?? []) {
		try {
			await handleMessage(sock, message);
		} catch (err) {
			runtime.logger?.error?.(
				{ err: String(err?.message ?? err) },
				'message handler failed',
			);
		}
	}
}

async function safeConnect() {
	if (runtime.stopping || runtime.connecting) return;
	runtime.connecting = true;

	try {
		const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
		let version;
		try {
			({ version } = await fetchLatestBaileysVersion());
		} catch (err) {
			runtime.logger?.warn?.(
				{ err: String(err?.message ?? err) },
				'could not fetch latest WhatsApp version; using Baileys default',
			);
		}

		const sock = makeWASocket({
			...(version ? { version } : {}),
			logger: runtime.logger,
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys, runtime.logger),
			},
			browser: ['Ubuntu', 'Chrome', '22.04'],
			markOnlineOnConnect: false,
			syncFullHistory: false,
			generateHighQualityLinkPreview: false,
			shouldSyncHistoryMessage: () => false,
			getMessage: async () => undefined,
		});
		runtime.socket = sock;

		runtime.pairing = { requested: false, timer: null };

		sock.ev.on('creds.update', saveCreds);
		sock.ev.on('connection.update', (update) => {
			void onConnectionUpdate(sock, state, update, runtime.pairing).catch((err) => {
				runtime.logger?.error?.(
					{ err: String(err?.message ?? err) },
					'connection update handler failed',
				);
			});
		});
		sock.ev.on('messages.upsert', (payload) => {
			void onMessages(sock, payload);
		});
		sock.ev.on('groups.upsert', cacheGroups);
		sock.ev.on('groups.update', cacheGroups);

		runtime.logger?.info?.(
			{ authDir: path.resolve(AUTH_DIR) },
			'opening WhatsApp connection',
		);
	} finally {
		// A failed setup must not leave reconnects permanently locked out.
		runtime.connecting = false;
	}
}

async function connect() {
	return safeConnect();
}

async function main() {
	runtime.configPath = process.env.CC_CONFIG ?? 'config.json';
	try {
		runtime.config = loadConfigWithEnv(runtime.configPath);
	} catch (err) {
		die(err.message);
	}

	runtime.logger = createLogger(runtime.config.logLevel);
	runtime.config.phoneNumber = resolvePhone(runtime.config);

	runtime.claimer = new Claimer({
		config: runtime.config,
		logger: runtime.logger,
		send: async (jid, text) => {
			if (!runtime.socket) throw new Error('not connected');
			return runtime.socket.sendMessage(jid, { text });
		},
		presence: async (jid, type) => {
			if (!runtime.socket) return;
			return runtime.socket.sendPresenceUpdate(type, jid);
		},
		markRead: async (messageKey) => {
			if (!runtime.socket || !messageKey) return;
			return runtime.socket.readMessages([messageKey]);
		},
	});

	if (runtime.config.dryRun) {
		runtime.logger.warn(
			'DRY RUN is ON — cards will be detected and logged, but no claims will be sent. Use .set dryrun off in a DM when ready.',
		);
	} else {
		runtime.logger.warn(
			'LIVE MODE — the bot will send claim commands. Automation may violate the game bot and WhatsApp rules.',
		);
	}

	// Watchdog: restart on uncaught errors if enabled
	if (runtime.config.session.watchdog) {
		process.on('uncaughtException', (err) => {
			runtime.logger?.fatal?.(
				{ err: String(err?.message ?? err), stack: err.stack },
				'uncaught exception — watchdog restart',
			);
			setTimeout(() => process.exit(1), 1000);
		});
	}

	await connect();
}

async function shutdown(exitCode = 0) {
	if (runtime.stopping) return;
	runtime.stopping = true;
	clearPairingTimer();
	stopSessionChecks();
	if (runtime.reconnectTimer) {
		clearTimeout(runtime.reconnectTimer);
		runtime.reconnectTimer = null;
	}
	try {
		await runtime.socket?.end(undefined);
	} catch {}
	process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		void shutdown();
	});
}

process.on('unhandledRejection', (err) => {
	runtime.logger?.error?.(
		{ err: String(err?.message ?? err) },
		'unhandled promise rejection',
	);
});

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
