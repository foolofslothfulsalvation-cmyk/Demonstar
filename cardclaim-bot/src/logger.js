import pino from 'pino';

/**
 * pino logger. Uses pino-pretty for a human-readable stream when attached to a
 * TTY, and plain JSON when piped to a file or systemd journal.
 */
export function createLogger(level = 'info') {
	const pretty = Boolean(process.stdout.isTTY) && !process.env.CC_LOG_JSON;

	return pino({
		level,
		transport: pretty
			? {
					target: 'pino-pretty',
					options: {
						colorize: true,
						translateTime: 'HH:MM:ss',
						ignore: 'pid,hostname',
					},
				}
			: undefined,
	});
}