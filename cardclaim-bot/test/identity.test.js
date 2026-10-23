import assert from 'node:assert/strict';
import test from 'node:test';

import {
	candidateJids,
	findTrustedBot,
	isAuthorizedControl,
	ownPhone,
	phoneFromJid,
} from '../src/identity.js';
import { loadConfig } from '../src/config.js';

test('phoneFromJid returns digits only for PN JIDs', () => {
	assert.equal(phoneFromJid('2349153327424@s.whatsapp.net'), '2349153327424');
	assert.equal(phoneFromJid('2349153327424@c.us'), '2349153327424');
	assert.equal(phoneFromJid('2349153327424@lid'), null);
	assert.equal(phoneFromJid('120363000000000001@g.us'), null);
	assert.equal(phoneFromJid('2349153327424@s.whatsapp.net:wa'), null);
});

test('candidateJids harvests all sender candidates', () => {
	const ids = candidateJids({
		key: {
			remoteJid: '120363000000000001@g.us',
			participant: '233509676154@lid',
			participantPn: '233509676154@s.whatsapp.net',
			senderPn: '233509676154@s.whatsapp.net',
		},
	});
	assert.ok(ids.includes('233509676154@s.whatsapp.net'));
	assert.ok(ids.includes('233509676154@lid'));
});

test('findTrustedBot matches candidate phones', () => {
	const config = loadConfig();
	const message = {
		key: {
			remoteJid: '120363000000000001@g.us',
			participantPn: '233509676154@s.whatsapp.net',
		},
	};
	const bot = findTrustedBot(config, message);
	assert.equal(bot?.name, 'Joker');
	assert.equal(bot?.prefix, '.j');

	const untrusted = {
		key: { remoteJid: '120363000000000001@g.us', participantPn: '9999999999999@s.whatsapp.net' },
	};
	assert.equal(findTrustedBot(config, untrusted), null);
});

test('disabled bots are not trusted', () => {
	const config = loadConfig();
	config.bots.forEach((bot) => (bot.enabled = false));
	const message = {
		key: {
			remoteJid: '120363000000000001@g.us',
			participantPn: '233509676154@s.whatsapp.net',
		},
	};
	assert.equal(findTrustedBot(config, message), null);
});

test('ownPhone prefers the user id phone', () => {
	const sock1 = { user: { id: '2349153327424@s.whatsapp.net' } };
	assert.equal(ownPhone(sock1), '2349153327424');

	const sock2 = { user: { id: '2349153327424@lid', phone: '2349153327424' } };
	assert.equal(ownPhone(sock2), '2349153327424');

	assert.equal(ownPhone({ user: {} }), null);
});

test('isAuthorizedControl accepts DMs from configured numbers', () => {
	const config = loadConfig();
	config.control.allowedNumbers = ['2349153327424'];

	const sock = { user: { id: '2349153327424@s.whatsapp.net' } };

	// Self chat DM
	const ownDm = {
		key: {
			fromMe: true,
			remoteJid: '2349153327424@s.whatsapp.net',
		},
	};
	assert.equal(isAuthorizedControl(ownDm, sock, config), true);

	// Controller DM
	const controllerDm = {
		key: {
			fromMe: false,
			remoteJid: '2349153327424@s.whatsapp.net',
			participantPn: '2349153327424@s.whatsapp.net',
		},
	};
	assert.equal(isAuthorizedControl(controllerDm, sock, config), true);

	// Group chat is never a control chat
	const group = {
		key: { fromMe: true, remoteJid: '120363000000000001@g.us' },
	};
	assert.equal(isAuthorizedControl(group, sock, config), false);

	// Random DM is not authorized
	const random = {
		key: { fromMe: false, remoteJid: '9999999999999@s.whatsapp.net' },
	};
	assert.equal(isAuthorizedControl(random, sock, config), false);
});
