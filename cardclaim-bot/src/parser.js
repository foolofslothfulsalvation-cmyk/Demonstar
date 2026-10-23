/**
 * Card alert parser.
 *
 * Handles the current alert format:
 *
 *   🎴  *CARD APPEARED*
 *
 *   🏷️ ⟢ *Name:* _Tokitaka Tokiwa_
 *   📺 ⟢ *Series:* _Ahiru no Sora_
 *   🏆 ❖ *Tier:* _TIER II_
 *   🎨 ⟢ *Artist:* _Kruggles_
 *   📝 ⟢ *Description:* _Tokitaka Tokiwa from Ahiru no Sora_
 *
 *   🆔 ⟢ _2-05430_
 *   ⌨️ ⟢ _Type .j claim 2-05430_
 *
 * Also handles the old `Name › value` layout, chat-export prefixes such as
 * `[10/22, 6:04 PM] Lapis:`, and multiple cards in one message.
 *
 * Pure functions only. Nothing here touches the network.
 */

const HEADER_RE = /CARD\s+APPEARED/i;
const ID_RE = /(?<!\d)([1-9]\d?)-(\d{5})(?!\d)/;
const TIER_RE = /\bTIER\b\s*[›>:\uFF1A]?\s*([IVXLCDM]+|\d{1,2})(?![IVXLCDM\d])/i;
const HINT_RE = /\bType\s+([./][A-Za-z]{1,5})\s+claim\s+(\d+-\d+)/i;
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;
const MARKDOWN_RE = /[*_~`]/g;
const DECORATION_RE = /[\u2726\u2727\u2728]+/g;

function squish(value) {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Strips invisible characters and normalises line endings. */
export function normalise(raw) {
	if (typeof raw !== 'string') return '';
	return raw
		.normalize('NFKC')
		.replace(INVISIBLE_RE, '')
		.replace(/\r\n?/g, '\n');
}

/** Removes WhatsApp markdown markers. */
function stripMarkdown(value) {
	return String(value ?? '').replace(MARKDOWN_RE, '');
}

/** Cleans a field value captured from a line. */
function cleanValue(value) {
	return squish(
		stripMarkdown(value)
			.replace(DECORATION_RE, ' ')
			.replace(/^[\s:›>|•⟢❖◆◇\-–—]+/, '')
			.replace(/[\s:›>|•⟢❖◆◇\-–—]+$/, ''),
	);
}

/** Converts a roman numeral or plain number to an integer. */
export function romanToInt(value) {
	const compact = squish(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (!compact) return null;
	if (/^\d{1,2}$/.test(compact)) return Number(compact);
	if (ROMAN[compact]) return ROMAN[compact];
	const stripped = compact.replace(/^TIER/, '');
	return ROMAN[stripped] ?? null;
}

function parseTierValue(value) {
	if (value === null || value === undefined) return null;
	const text = squish(value);
	const embedded = text.match(TIER_RE);
	if (embedded) return romanToInt(embedded[1]);
	return romanToInt(text);
}

/**
 * Splits a message into per-card blocks at each `CARD APPEARED` header.
 * Anything before the first header is ignored.
 */
function splitBlocks(text) {
	const blocks = [];
	let current = null;

	for (const line of text.split('\n')) {
		if (HEADER_RE.test(line)) {
			if (current !== null) blocks.push(current);
			current = '';
			continue;
		}
		if (current !== null) current += `${line}\n`;
	}

	if (current !== null) blocks.push(current);
	return blocks;
}

/** Reads a labelled field such as `*Name:* _Tokitaka Tokiwa_`. */
function field(block, ...labels) {
	for (const line of block.split('\n')) {
		const cleaned = stripMarkdown(line);
		for (const label of labels) {
			const re = new RegExp(`\\b${label}\\b\\s*[:\\uFF1A›]\\s*(.+)$`, 'i');
			const match = cleaned.match(re);
			if (match) {
				const value = cleanValue(match[1]);
				if (value) return value;
			}
		}
	}
	return null;
}

function idFromBlock(block) {
	const lines = block.split('\n').map(stripMarkdown);
	const preferred = lines.find((line) => /🆔|\bID\b/i.test(line));
	const match = (preferred ?? block).match(ID_RE);
	return match ? { id: `${match[1]}-${match[2]}`, tierFromId: Number(match[1]) } : null;
}

function tierFromBlock(block) {
	const value = field(block, 'Tier');
	if (value !== null) {
		const tier = parseTierValue(value);
		if (tier !== null) return { tier, label: value };
	}

	const embedded = stripMarkdown(block).match(TIER_RE);
	if (embedded) {
		const tier = romanToInt(embedded[1]);
		if (tier !== null) return { tier, label: `TIER ${embedded[1].toUpperCase()}` };
	}
	return null;
}

function claimPrefixFromBlock(block) {
	const match = stripMarkdown(block).match(HINT_RE);
	return match ? match[1].toLowerCase() : null;
}

function parseBlock(block) {
	const idInfo = idFromBlock(block);
	if (!idInfo) return null;

	const tierInfo = tierFromBlock(block);
	const tier = tierInfo?.tier ?? idInfo.tierFromId;
	const name = field(block, 'Name');
	const series = field(block, 'Series');
	const artist = field(block, 'Artist', 'Art');
	const description = field(block, 'Description');

	return {
		id: idInfo.id,
		tier,
		tierLabel: tierInfo?.label ?? `TIER ${tier}`,
		name,
		series,
		artist,
		description,
		claimPrefix: claimPrefixFromBlock(block),
		raw: block.trim(),
	};
}

/**
 * Parses every card in a message body.
 *
 * @param {string} raw message text
 * @param {{senderJid?: string}} [options]
 * @returns {Array<object>} cards in the order they appeared
 */
export function parseCards(raw, options = {}) {
	const text = normalise(raw);
	if (!text) return [];

	const cards = [];
	const seen = new Set();

	for (const block of splitBlocks(text)) {
		const card = parseBlock(block);
		if (!card || seen.has(card.id)) continue;
		seen.add(card.id);
		if (typeof options.senderJid === 'string') card.senderJid = options.senderJid;
		cards.push(card);
	}

	return cards;
}

function valueAfterEmoji(line, emojiRe) {
	return cleanValue(
		stripMarkdown(line)
			.replace(emojiRe, ' ')
			.replace(/\uFE0F/g, ' ')
			.replace(/[⟢|•]/g, ' '),
	);
}

/**
 * Parses a successful claim response:
 *
 *   💠 *CLAIMED*
 *   🏷️⟢ _Souta Mizusaka_
 *   📺 ⟢ _Celestial Method_
 *   🏆 _TIER II_ ⟢ 🔢 _#1_
 *   📦 _Added to collection_
 *
 * The response does not include the card ID, so the caller matches it to a
 * pending claim by name, series, and tier.
 */
export function parseClaimConfirmation(raw) {
	const text = normalise(raw);
	if (!/CLAIMED/i.test(text)) return null;

	let name = field(text, 'Name');
	let series = field(text, 'Series');
	const tierInfo = tierFromBlock(text);

	for (const line of text.split('\n')) {
		if (!name && /🏷️/u.test(line)) name = valueAfterEmoji(line, /🏷️/u) || null;
		if (!series && /📺/u.test(line)) series = valueAfterEmoji(line, /📺/u) || null;
	}

	if (!name && !series && !tierInfo) return null;

	return {
		name,
		series,
		tier: tierInfo?.tier ?? null,
		tierLabel: tierInfo?.label ?? null,
		raw: text.trim(),
	};
}

const RATE_LIMIT_RE =
	/(slow\s*down|too\s*fast|rate[-\s]?limit|cooldown|try\s+again\s+in|claim(?:ing)?\s+limit|limit\s+reached|exceeded|wait\s+\d+\s*(?:s|sec|second|m|min|minute))/i;
const ALREADY_CLAIMED_RE = /(already\s+claimed|someone\s+else\s+claimed|not\s+available|already\s+owned)/i;

/**
 * Classifies a message from a trusted game bot that is not a card spawn.
 * @returns {{type: string, confirmation?: object}|null}
 */
export function classifyGameMessage(raw) {
	const text = normalise(raw);
	if (!text) return null;
	if (HEADER_RE.test(text)) return null;

	if (ALREADY_CLAIMED_RE.test(text)) return { type: 'already-claimed' };
	if (/CLAIMED/i.test(text)) {
		const confirmation = parseClaimConfirmation(text);
		return confirmation ? { type: 'claimed', confirmation } : { type: 'claimed', confirmation: null };
	}
	if (RATE_LIMIT_RE.test(text)) return { type: 'rate-limit' };
	return null;
}

/** Text-bearing fields, in preference order, at each nesting level. */
const TEXT_FIELDS = [
	'conversation',
	'caption',
	'text',
	'hydratedContentText',
	'contentText',
	'description',
	'title',
];

/** Wrappers that hold only quoted/stored copies of a message. */
const SKIP_FIELDS = new Set([
	'contextInfo',
	'imageContextInfo',
	'videoContextInfo',
	'documentContextInfo',
	'messageContextInfo',
	'ephemeralSharedSecret',
]);

/** Pulls readable text out of a Baileys message object. */
export function extractText(message, depth = 0) {
	if (!message || typeof message !== 'object' || depth > 6) return '';

	for (const key of TEXT_FIELDS) {
		const value = message[key];
		if (typeof value === 'string' && value.trim()) return value;
	}

	for (const [key, value] of Object.entries(message)) {
		if (SKIP_FIELDS.has(key)) continue;
		if (value && typeof value === 'object') {
			const found = extractText(value, depth + 1);
			if (found) return found;
		}
	}

	return '';
}
