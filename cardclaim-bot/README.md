# Demonstar — WhatsApp card claim bot

Watches WhatsApp groups for card spawns from your trusted game bots, then types the
claim command under conservative rate limits so you don't miss a card without getting
flagged.

It is a plain [Baileys](https://github.com/WhiskeySockets/Baileys) companion client — no
WhatsApp Business API, no browser automation, no unofficial web scraping. It logs into
WhatsApp exactly like WhatsApp Web would.

## How it works

- **Login:** 8-character pairing code (no QR). The bot prints the code to the console; you
  enter it on your phone under WhatsApp Business → Settings → Linked devices → Link a
  device → Link with phone number instead.
- **Sources:** only the three configured game bots are trusted:
  - Joker — `233509676154` (`.j`)
  - Subaru — `2347014606422` (`.s`)
  - Jake — `2349133219812` (`.jk`)
  A human pasting an old card is ignored.
- **Scope:** it follows the bots into any group they post in. You can block individual
  groups with `.block`.
- **Claim policy:** tier-based rates and global caps. Tier IV is claimed most eagerly;
  Tier I is disabled by default. There are per-minute, per-hour, per-day, per-source and
  per-burst limits.
- **Controls:** you configure everything by DMing the bot's own number. Changes save to
  `config.json` immediately and survive restarts.
- **Confirmations:** it parses the game bot's `💠 *CLAIMED*` reply and matches it to your
  pending claim by name, series, and tier.

## Before you start

This automates a bot game, which usually breaks that game's terms of service and can get
your **number** banned rather than just the session. Things worth knowing:

- Use a spare number you can afford to lose, not your primary business line.
- Group admins can ban you for typing commands nobody else typed.
- Delays, cooldowns, caps and dedupe are built in to stay under a radar — they do not make
  this undetectable.
- WhatsApp requires you to open the primary phone at least once every 14 days, or linked
  devices can be logged out.

## Setup

```bash
cd cardclaim-bot
npm install
```

### 1. Configure your number

Open `config.json` and set `phoneNumber` to your number in international format, digits
only, no leading `0`. For a Nigerian `0915…` number that is:

```json
"phoneNumber": "2349153327424"
```

The file ships in **dry run** mode: cards are detected and logged, nothing is sent.

### 2. Pair with WhatsApp

```bash
npm start
```

The first run prints an 8-character pairing code:

```
========================================
  WHATSAPP PAIRING CODE: ABCD-EFGH
========================================

On the phone: WhatsApp Business → Settings → Linked devices
→ Link a device → Link with phone number instead
Enter the code above. No QR code is used.
```

On your phone, enter the code. Once linked, the session is saved in `auth_info/` and later
restarts reconnect without pairing again.

`auth_info/` **is your WhatsApp account**. Never commit or share it. It is in `.gitignore`.

### 3. Run in dry run first

Leave `"dryRun": true` for at least a day. Confirm the detected cards match what actually
spawned. Then set `"dryRun": false` (or send `.set dryrun off` in a DM) to go live.

Start conservative: Tier IV only for a day, then add Tier III and II if nothing flags.

## Configuration

All of `config.json`:

| Key | Meaning |
|---|---|
| `phoneNumber` | Your WhatsApp number, digits only, international format |
| `dryRun` | Log claims without sending them |
| `groupMode` | `trusted-bots` follows the three bots into any group; `allowlist` only claims in `groups` |
| `groups` | Group JIDs to watch (only used in allowlist mode) |
| `blockedGroups` | Group JIDs to never claim in |
| `bots` | Trusted game bots with phone, prefix, enabled |
| `tiers` | Per-tier claim probability and max per hour (tiers 1–6) |
| `limits` | Global min gap, jitter, per-minute/hour/day, per-burst caps, low-tier delay |
| `limits.lowTierDelayMs` | Extra ms delay before claiming tiers below IV (default 12000 = 12s) |
| `control.allowedNumbers` | Extra DM numbers allowed to change settings (your own chat is always allowed) |
| `backoff` | Pause a source after a rate-limit or send failure |
| `session` | Health check, session expiry warning, auto-repair, watchdog |
| `notify` | High-tier DM notifications and claim summary |
| `logLevel` | pino level |

Bad values are rejected at startup with every problem listed at once.

## Environment variables (`CC_*`) — for Katabump or local `.env`

Instead of editing `config.json`, set these in the Katabump dashboard Environment Variables,
or create a `.env` file locally (copy `.env.example` to `.env` and edit):

| Env var | Example | Effect |
|---|---|---|
| `CC_PHONE` | `2349153327424` | Your WhatsApp number |
| `CC_DRY_RUN` | `off` | Turn dry run off |
| `CC_PAUSED` | `on` | Start paused |
| `CC_PROFILE` | `aggressive` | Load a named profile |
| `CC_TIER_4` | `50` | Tier IV attempt chance in percent |
| `CC_MAX_MINUTE` | `6` | Global claims per minute |
| `CC_MAX_HOUR` | `20` | Global claims per hour |
| `CC_MAX_DAY` | `80` | Global claims per day |
| `CC_MIN_GAP` | `2500` | Minimum gap between sends (ms) |
| `CC_LOW_TIER_DELAY` | `12000` | Extra delay for tiers below IV (ms) |
| `CC_HEALTH_CHECK_MS` | `300000` | Session health check interval |
| `CC_SESSION_WARN_DAYS` | `13` | Warn when session is this many days old |
| `CC_AUTO_REPAIR` | `true` | Auto re-pair if session dies |
| `CC_WATCHDOG` | `true` | Restart on uncaught errors |
| `CC_NOTIFY_HIGH_TIER` | `true` | DM you when Tier V/VI appears |
| `CC_BOT_JOKER` | `on` | Enable/disable Joker |
| `CC_BOT_SUBARU` | `on` | Enable/disable Subaru |
| `CC_BOT_JAKE` | `on` | Enable/disable Jake |

Env vars override `config.json`, so you can change behaviour without editing files.

## Control commands (DM the bot's own number)

Send these to the bot's own "Message yourself" chat. They are ignored in groups and from
any other number unless listed in `control.allowedNumbers`.

| Command | Effect |
|---|---|
| `.status` | Connection, mode, tiers, limits, counters |
| `.rates` | Tier chances and global limits |
| `.menu` | Full command menu (same as `.help`) |
| `.pause` / `.resume` | Stop or resume all claiming |
| `.kill` | Stop everything and disconnect |
| `.t1 … .t6 on|off` | Enable/disable a tier |
| `.t4` | Show Tier IV status |
| `.set t4 50` | Set Tier IV attempt chance to 50% |
| `.profile` | List available profiles |
| `.profile balanced` | Switch to balanced (or conservative / aggressive / stealth) |
| `.set maxminute 6` | Global claims per minute |
| `.set maxhour 20` | Global claims per hour |
| `.set maxday 80` | Global claims per day |
| `.set gap 2500` | Minimum gap between sends, in ms |
| `.set batch 1` | Cards claimed per spawn burst |
| `.set lowtier 12000` | Extra delay for tiers below IV, in ms |
| `.set dryrun off` | Turn dry run off (sends real claims) |
| `.set mode trusted` | `trusted` or `allowlist` |
| `.set bot joker on` | Enable/disable Joker |
| `.block <groupJid>` | Never claim in this group |
| `.unblock <groupJid>` | Undo `.block` |
| `.groups` | List joined groups and JIDs |
| `.stats` | Claims today / this week, detected, sent, confirmed |
| `.last [n]` | Last n claimed cards |
| `.export` | Claim history as JSON |
| `.help` | This message |

Changes save to `config.json` immediately.

## Profiles (fixed rates + speeds)

Switch the whole claim policy at once:

| Profile | Tiers | Speed | Best for |
|---|---|---|---|
| `conservative` | T4+ only, slow | 3/min, 5s gap | Staying under the radar |
| `balanced` | T2+, moderate | 6/min, 2.5s gap | Everyday use (default) |
| `aggressive` | All tiers, fast | 12/min, 1s gap | Maximizing claims |
| `stealth` | T2+, very slow | 2/min, 8s gap | Maximum caution |

Use `.profile aggressive` or set `CC_PROFILE=aggressive` in Katabump.

## Human behaviour

Before sending a claim, the bot:
1. Marks the chat as read (like opening it)
2. Shows a typing indicator for 0.8–2 seconds
3. Clears typing, then sends the claim

Tiers below IV get an extra **12-second delay** by default (`lowTierDelayMs`) to look even more human.

## Default rate policy

| Tier | Try chance | Max per hour |
|---|---:|---:|
| Tier VI | 100% | 30 |
| Tier V | 100% | 20 |
| Tier IV | 100% | 12 |
| Tier III | 75% | 8 |
| Tier II | 25% | 4 |
| Tier I | off | 0 |

Global caps: 6/minute, 20/hour, 80/day. Minimum 2.5s gap between claims with 300–900ms jitter. Only 1 card is claimed per spawn burst (the best tier wins).

## Session health & reliability

- **Health check** every 5 minutes: verifies the WhatsApp session is alive
- **Session expiry warning**: alerts you in a DM when the session is 13+ days old (WhatsApp logs out linked devices after 14 days of phone inactivity)
- **Auto-repair**: if the session is logged out or mismatched, `auth_info/` is archived and the bot re-pairs automatically
- **Watchdog**: restarts the process on uncaught errors
- **High-tier notification**: DMs you when a Tier V or VI card appears, even if not claiming

## Running on Katabump

Katabump hosts Node.js apps and persists files, which is enough for this bot.

Free plan: **308 MB RAM, 716 MB disk, 25% CPU** — free renewal required every **4 days**.
Paid plans start at **€1.50/month** and renew monthly.

1. Create a Node.js server on Katabump.
2. Upload the project (exclude `node_modules/` and `auth_info/`).
3. Set the entry point to `src/index.js`.
4. Add environment variable `CC_PHONE=2349153327424` (or set `phoneNumber` in `config.json`).
5. Start the server and read the pairing code from the console logs.
6. Link the code on your phone.
7. Run dry run for a day, then go live.

Free servers must be renewed every 4 days from the dashboard, or the session will go
offline.

## Layout

```
src/config.js     loading, validation, and DM control helpers
src/parser.js     card and CLAIMED-response parsing (pure, tested)
src/claimer.js    tier/rate policy and send serialisation (pure, tested)
src/identity.js   sender JID resolution and DM authorisation
src/commands.js   .status / .pause / .set / .profile / .stats / .last / .export handling
src/index.js      Baileys socket, pairing-code login, health checks, auto-repair, watchdog
scripts/list-groups.js  lists joined groups with JIDs
```

## Tests

```bash
npm test        # 51 tests
```

The parser, claimer, config, identity, and command layers are all unit-tested without a
WhatsApp connection.
