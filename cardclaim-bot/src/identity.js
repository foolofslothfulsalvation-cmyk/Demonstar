import { isController, normalisePhone } from './config.js';

/** The numeric/user part of a JID, without the device suffix. */
export function jidUser(jid) {
	if (typeof jid !== 'string') return null;
	const user = jid.split('@')[0]?.split(':')[0];
	return user || null;
}

/** Returns a phone number only for normal PN JIDs, never for @lid. */
export function phoneFromJid(jid) {
	if (typeof jid !== 'string') return null;
	if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@c.us')) return null;
	const user = jidUser(jid);
	return user && /^\d{8,15}$/.test(user) ? user : null;
}

function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

/**
 * All sender-related JIDs Baileys may attach to a message. Newer WhatsApp
 * versions can put an @lid in `participant` while the real phone number is in
 * `participantPn`, so every candidate is checked.
 */
export function candidateJids(msg) {
	const key = msg?.key ?? {};
	return unique([
		key.participantPn,
		key.senderPn,
		key.participantAlt,
		key.senderAlt,
		key.remoteJidAlt,
		key.participant,
		key.remoteJid,
	]);
}

export function phoneCandidates(msg) {
	return unique(candidateJids(msg).map(phoneFromJid));
}

/**
 * Finds the configured game bot that sent this message.
 * @returns {object|null} bot entry from config.bots
 */
export function findTrustedBot(config, msg) {
	const phones = new Set(phoneCandidates(msg));
	if (!phones.size) return null;
	return (
		config.bots.find(
			(bot) => bot.enabled && phones.has(normalisePhone(bot.phone)),
		) ?? null
	);
}

function ownIdentities(sock) {
	const user = sock?.user;
	const phones = new Set();
	const lids = new Set();

	for (const value of [user?.id, user?.phone]) {
		if (typeof value !== 'string') continue;
		const phone = phoneFromJid(value);
		if (phone) phones.add(phone);
		else if (/^\d{8,15}$/.test(value)) phones.add(value);
	}
	if (typeof user?.id === 'string' && user.id.endsWith('@lid')) {
		const lid = jidUser(user.id);
		if (lid) lids.add(lid);
	}
	if (typeof user?.lid === 'string' && user.lid.endsWith('@lid')) {
		const lid = jidUser(user.lid);
		if (lid) lids.add(lid);
	}

	return { phones, lids };
}

export function ownPhone(sock) {
	return [...ownIdentities(sock).phones][0] ?? null;
}

/**
 * True only for the bot's own "Message yourself" chat. This is what lets the
 * single account configure itself without accepting commands from groups.
 */
export function isSelfChat(msg, sock) {
	if (!msg?.key?.fromMe) return false;
	const remote = msg.key.remoteJid;
	if (!remote || remote.endsWith('@g.us')) return false;

	const { phones, lids } = ownIdentities(sock);
	if (remote.endsWith('@lid')) return lids.has(jidUser(remote));
	const phone = phoneFromJid(remote);
	return Boolean(phone && phones.has(phone));
}

/**
 * Control commands are accepted from the bot's own chat, or from an extra
 * phone number explicitly listed in config.control.allowedNumbers.
 */
export function isAuthorizedControl(msg, sock, config) {
	if (isSelfChat(msg, sock)) return true;
	if (!msg?.key || msg.key.fromMe) return false;
	if (msg.key.remoteJid?.endsWith('@g.us')) return false;
	return phoneCandidates(msg).some((phone) => isController(config, phone));
}
