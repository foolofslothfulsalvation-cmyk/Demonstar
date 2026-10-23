#!/usr/bin/env node
/**
 * Prints the JID of every group the linked account has joined, so you can fill
 * in the `groups` allowlist or `blockedGroups` in config.json.
 *
 *   npm run groups
 *
 * Read-only: it opens a socket to list groups but sends nothing. It uses the
 * same pairing-code flow as the main bot (no QR).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import makeWASocket, {
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
} from 'baileys';

import { createLogger } from '../src/logger.js';
import { isPhoneNumber, loadConfig, normalisePhone } from '../src/config.js';

const AUTH_DIR = 'auth_info';

function die(message) {
	console.error(`\n${message}\n`);
	process.exit(1);
}

function resolvePhoneNumber(config) {
	const fromEnv = process.env.CC_PHONE?.trim();
	if (fromEnv) return normalisePhone(fromEnv);
	if (config.phoneNumber) return normalisePhone(config.phoneNumber);
	if (!process.stdin.isTTY) return null;

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return (async () => {
		const ask = () =>
			new Promise((resolve) => rl.question('Phone number (digits only): ', resolve));
		for (;;) {
			const answer = (await ask()).trim().replace(/[^\d]/g, '');
			if (isPhoneNumber(answer)) return answer;
			console.log('That does not look like a phone number.');
		}
	})();
}

async function pairWithCode(sock, phoneNumber, logger) {
	logger.info({ phone: phoneNumber }, 'requesting pairing code');
	const code = await sock.requestPairingCode(phoneNumber);

	console.log('\n========================================');
	console.log('  WHATSAPP PAIRING CODE: ' + String(code).toUpperCase());
	console.log('========================================');
	console.log('\nOn your phone: WhatsApp Business → Settings → Linked devices');
	console.log('→ Link a device → Link with phone number instead');
	console.log('Enter the code above.\n');

	return code;
}

async function main() {
	const configPath = process.env.CC_CONFIG ?? 'config.json';
	let config;
	try {
		config = loadConfig(configPath);
	} catch (err) {
		die(err.message);
	}

	const phone = await resolvePhoneNumber(config);
	if (!phone) {
		die(
			'No phone number provided. Set "phoneNumber" in config.json or CC_PHONE, or run in a TTY.',
		);
	}
	if (!isPhoneNumber(phone)) {
		die(`"${phone}" is not a valid international phone number.`);
	}

	const logger = createLogger('warn');
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();

	const sock = makeWASocket({
		...(version ? { version } : {}),
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		browser: ['Ubuntu', 'Chrome', '22.04'],
		markOnlineOnConnect: false,
		syncFullHistory: false,
		generateHighQualityLinkPreview: false,
		shouldSyncHistoryMessage: () => false,
		getMessage: async () => undefined,
	});

	let pairingRequested = false;
	let pairingTimer = null;

	sock.ev.on('creds.update', saveCreds);

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr && !state.creds.registered && !pairingRequested) {
			pairingRequested = true;
			try {
				await pairWithCode(sock, phone, logger);
				console.log('Waiting for you to enter the code on your phone…');
				pairingTimer = setTimeout(() => {
					if (!state.creds.registered) {
						pairingRequested = false;
						console.log('Pairing code expired; requesting a new one…');
						void pairWithCode(sock, phone, logger);
					}
				}, 75000);
			} catch (err) {
				pairingRequested = false;
				logger.error({ err: String(err?.message ?? err) }, 'pairing failed');
			}
		}

		if (connection === 'open') {
			if (pairingTimer) clearTimeout(pairingTimer);
		}

		if (connection === 'close') {
			if (pairingTimer) clearTimeout(pairingTimer);
			const statusCode = lastDisconnect?.error?.output?.statusCode;
			if (statusCode === 401 || statusCode === 406) {
				die(
					'Session invalid. Archive auth_info/ and re-pair with a fresh code.',
				);
			}
		}
	});

	// Wait for the socket to finish connecting before querying groups.
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timed out connecting to WhatsApp')), 60000);
		sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
			if (connection === 'open') {
				clearTimeout(timer);
				resolve();
			}
			if (connection === 'close') {
				clearTimeout(timer);
				reject(new Error(lastDisconnect?.error?.message ?? 'connection closed'));
			}
		});
	});

	const all = Object.values(await sock.groupFetchAllParticipating()).sort((a, b) =>
		String(a.subject ?? '').localeCompare(String(b.subject ?? '')),
	);

	if (!all.length) {
		console.log('No groups found on this account.');
	} else {
		for (const group of all) {
			const members = group.size ?? group.participants?.length ?? 0;
			const locked = group.announce ? '  [announce-only]' : '';
			console.log(`${group.subject ?? '(no subject)'}${locked}\n  ${group.id}   ${members} members`);
		}
	}

	await sock.end(undefined);
	process.exit(0);
}

main().catch((err) => {
	console.error('Failed:', err?.message ?? err);
	process.exit(1);
});
