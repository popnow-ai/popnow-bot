<p align="center">
  <a href="https://popnow.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/popnow-wordmark-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="assets/popnow-wordmark.png">
      <img alt="PopNow" src="assets/popnow-wordmark.png" width="280">
    </picture>
  </a>
</p>

<h1 align="center">PopNow Bot — AI Image &amp; Video Generator for Telegram and Discord</h1>

<p align="center">
  <strong>popnow-bot is a self-hosted Telegram and Discord bot for the PopNow API</strong>: it generates AI
  images and videos, animates still images into video and applies trending video effects right in a chat,
  with a price quote before every paid run and daily spend limits you control.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6.svg">
  <img alt="Node 22.13+" src="https://img.shields.io/badge/node-%3E%3D22.13-339933.svg">
  <img alt="Docker" src="https://img.shields.io/badge/run%20with-Docker-2496ed.svg">
  <a href="https://popnow.ai"><img alt="Website" src="https://img.shields.io/badge/site-popnow.ai-ff5c8a.svg"></a>
</p>

PopNow is a browser-based AI studio for videos, images and music: image-to-video, text-to-video, AI images,
one-tap trending video effects and more, with models such as Kling, Seedance, Wan, Vidu, MiniMax, Nano Banana,
GPT Image and Flux. This bot brings the image and video side of it into your Telegram chats and Discord
servers. It runs on your own machine and pays from your own PopNow credits; failed runs are refunded.

- **Images**: `/pic a lighthouse at dusk`
- **Videos**: `/vid waves rolling onto a beach at sunset`
- **Animate**: tap **Animate** under any image the bot made, or reply to it with `/animate <how it should move>`
- **Video effects**: tap **Effects** under an image, or reply with `/effect tiny-planet`
- **Spend protection**: every request is priced first (free), expensive ones need a tap on Confirm,
  and per-person and whole-bot daily limits are enforced
- **Private by default**: only you can use it until you allow other people or groups

## Quickstart

You need a computer or server that stays on, with [Docker](https://docs.docker.com/get-docker/) installed.

**1. Get the keys.** Create an API key just for this bot at
[popnow.ai/api/console/keys](https://popnow.ai/api/console/keys) and give it a spend cap there. Then open
[@BotFather](https://t.me/BotFather) in Telegram, send `/newbot` and copy the bot token.

**2. Configure.**

```sh
git clone https://github.com/popnow-ai/popnow-bot.git
cd popnow-bot
cp .env.example .env
```

Fill in the three required lines in `.env`:

```sh
POPNOW_API_KEY=sk-popnow-...
TELEGRAM_BOT_TOKEN=123456789:AA...
OWNER_ID=your-telegram-user-id
```

Don't know your Telegram user ID? Put `OWNER_ID=0` for now, start the bot, send it any message and it
replies with your ID. Then set it and restart.

**3. Build and start.** The image is built locally from this repository; no registry is involved.

```sh
docker compose up -d --build
docker compose logs -f     # "Telegram bot @yourbot is running"
```

Open your bot, send `/start`, accept the short usage rules once, and send `/pic a cozy cabin in the snow`.
To update later: `git pull && docker compose up -d --build`.

## Features

| Feature | Telegram | Discord | PopNow API used |
|---|---|---|---|
| Text to image (`/pic`) | yes | yes | `jobs/quote`, `jobs/createTask`, `jobs/recordInfo` |
| Text to video (`/vid`) | yes | yes | same |
| Animate an image the bot made (button) | yes | yes | `jobs/recordInfo` for a fresh image link, then a new task |
| Animate your own photo (`/animate`) | reply to a photo | attachment option | `common/upload-url` + `files/{id}/commit` (`popnow://f/...`) |
| Trending video effects (`/effect`, `/effects`, button) | yes | yes (select menu) | image-to-video task with a preset prompt |
| Model picker with prices (`/models`) | buttons | autocomplete | `GET /api/v1/models`, `GET /api/v1/models/{model}` |
| Spend summary (`/spend`), owner sees balance | yes | yes | `GET /api/v1/chat/credit` (balance) |
| Report to the operator (`/report`) | yes | yes | none |

Uploading your own photos is **off by default** (`ALLOW_PHOTO_UPLOADS=false`): until you turn it on,
Animate and effects work only on images the bot generated.

### Video effects

Effects are presets in [`effects/default.json`](effects/default.json): a name, a one-line description, an
image-to-video model and a ready-made motion prompt with locked settings. The default set includes Tiny Planet,
Hyperdrive, Crash Zoom, Marble Statue, Liquid Chrome, Unfurl Wings, Clone Split and more. To change them,
copy the file, edit it and point `EFFECTS_FILE` at your copy (`EFFECTS_FILE=off` hides effects):

```json
{
  "effects": [
    {
      "id": "tiny-planet",
      "name": "Tiny Planet",
      "description": "Your world curls into a little planet, with you on top.",
      "model": "minimax/h3/image-to-video",
      "imageField": "image_url",
      "prompt": "The camera shoots straight up into the sky while the ground curls into a tiny round planet...",
      "input": { "duration_seconds": 5, "resolution": "768p" }
    }
  ]
}
```

`input` is merged into the task input; the photo (in `imageField`) and the prompt always win. Every effect
is quoted like any other request before it runs. Browse the live effects at [popnow.ai/effects](https://popnow.ai/effects).

## Commands

| Command | What it does |
|---|---|
| `/pic <prompt>` | Generate an image |
| `/vid <prompt>` | Generate a video from text |
| `/animate <motion>` | Reply to an image to turn it into a video |
| `/effect <name>` | Reply to an image to apply a video effect (Discord: pick the effect and attach an image) |
| `/effects` | List the video effects and their ids |
| **Animate** / **Effects** buttons | Under every generated image |
| `/models` | Choose your image, video and animate models |
| `/spend` | What you have spent today; the owner also sees the whole bot and the account balance |
| `/report <text>` | Send a report to the operator |
| `/help` | Summary of all of this |

The names are deliberately not `/image` or `/video`, which other popular bots use, so the bot can share a
group with them. On Discord, `/animate` and `/effect` appear only when `ALLOW_PHOTO_UPLOADS=true`; the buttons
always work.

## How spending works

1. **Price first.** Each request is quoted with `POST /api/v1/jobs/quote` before anything happens. Quotes are free.
2. **Hard ceiling.** A request that could cost more than `MAX_CREDITS_PER_REQUEST` (default 100 credits) is
   refused. Nothing is charged.
3. **Confirmation.** Above `CONFIRM_ABOVE_CREDITS` (default 10 credits) the bot shows the price with
   **Confirm** and **Cancel** buttons. Only the person who asked can confirm.
4. **Daily limits.** Each person may spend `USER_DAILY_BUDGET_CREDITS` (default 100) per UTC day, the whole
   bot `DAILY_BUDGET_CREDITS` (default 500). Generations still running count as spent until they finish, so
   several requests at once cannot slip past a limit. Owners are only bound by the whole-bot limit.
5. **No double charges.** Each task is created with the signed `quoteId`, the confirmed `expectedCredits` and an
   `Idempotency-Key` derived from the chat message or button tap, so a duplicated update or a double tap returns
   the task that already exists.
6. **Results.** Progress is shown by editing one message every few seconds. The result shows the actual charge
   and the task ID.

1 credit = $0.01; see [popnow.ai/pricing](https://popnow.ai/pricing). A started generation cannot be cancelled.
Failed generations are refunded. The bot's ledger lives in `DATA_DIR/state.json`; the key's spend cap in the
PopNow API console is the limit that can never be lost.

## Discord setup (optional)

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application,
   open **Bot**, reset and copy the token, and turn **Public Bot** off so only you can add it to servers.
   No privileged intents are needed.
2. Under **OAuth2 → URL Generator**, tick the scopes `bot` and `applications.commands` and the permissions
   **Send Messages**, **Attach Files** and **Embed Links**. Open the link and add the bot to your server.
3. Set `DISCORD_TOKEN` in `.env` (and `DISCORD_GUILD_ID` with your server ID for instant command
   registration), add your Discord user ID to `OWNER_ID` (for example `OWNER_ID=tg:123,dc:456`), and add the
   channel or server ID to `ALLOWED_CHAT_IDS`.

To find IDs, turn on Developer Mode (User Settings → Advanced) and right-click a user, channel or server → Copy ID.

## Configuration

Every setting is an environment variable; [`.env.example`](.env.example) explains each one.

| Variable | Default | |
|---|---|---|
| `POPNOW_API_KEY` | required | Your key (`sk-popnow-...`) |
| `TELEGRAM_BOT_TOKEN` / `DISCORD_TOKEN` | one required | Which platforms to run |
| `OWNER_ID` | required | Your user ID(s); `tg:` / `dc:` prefixes pin a platform |
| `ALLOWED_USER_IDS` | empty | Other people allowed in private chats |
| `ALLOWED_CHAT_IDS` | empty | Groups, channels or servers where the bot answers |
| `DAILY_BUDGET_CREDITS` / `USER_DAILY_BUDGET_CREDITS` | `500` / `100` | Daily limits (UTC) |
| `MAX_CREDITS_PER_REQUEST` / `CONFIRM_ABOVE_CREDITS` | `100` / `10` | Per-request ceiling and confirmation threshold |
| `DEFAULT_IMAGE_MODEL` | `alibaba/z-image-turbo/text-to-image` | Any text-to-image model |
| `DEFAULT_VIDEO_MODEL` / `DEFAULT_ANIMATE_MODEL` | `minimax/h3/text-to-video` / `minimax/h3/image-to-video` | Any text-to-video / image-to-video model |
| `ALLOWED_MODELS` | empty (all) | Exact IDs or prefixes such as `alibaba/*` |
| `VIDEO_SECONDS` / `VIDEO_RESOLUTION` | `5` / `480p` | Snapped to what each model allows |
| `EFFECTS_FILE` | `effects/default.json` | Your own effect presets, or `off` |
| `ALLOW_PHOTO_UPLOADS` | `false` | Use photos people upload |
| `REQUIRE_CONSENT` | `true` | Ask everyone to accept the usage rules once |
| `RETENTION_SECONDS` | account default | Delete results and prompts sooner (`X-PopNow-Retention`) |
| `POPNOW_BASE_URL` | `https://api.popnow.ai` | Only change for testing |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where `state.json` lives |

The live model list with prices is at [popnow.ai/models](https://popnow.ai/models) and `GET /api/v1/models`.

## Running without Docker

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run build
npm start                  # reads the environment; or: npm run dev (loads .env)
```

Any container host works too: build the `Dockerfile`, set the variables, mount a volume at `/data` and keep
**one replica** (two copies polling the same Telegram token fight over updates). The bot needs no public
domain and no open port.

## Safety and privacy

- **Private by default.** Strangers who find the bot are told it is private and given their user ID to send
  you. Groups are ignored until listed in `ALLOWED_CHAT_IDS`; once listed, every member can use the bot.
  `ALLOWED_USER_IDS=*` makes the bot public and lets anyone spend your credits.
- **Usage rules.** With `REQUIRE_CONSENT=true`, everyone accepts a short set of rules once: keep it suitable
  for everyone, only upload photos you may use, never impersonate or embarrass a real person.
- **Uploaded photos are off by default.** If you enable `ALLOW_PHOTO_UPLOADS`, the bot downloads the image
  and uploads it to PopNow storage. Telegram file links are never passed on, because they contain your bot token.
- **What is stored.** `state.json` holds daily spend totals, each person's model choice and who accepted the
  rules. Logs contain task IDs and amounts, never prompts or media.
- **Reports.** `/report` forwards a message to the owner. You can also reach PopNow at
  [popnow.ai/contact](https://popnow.ai/contact).

You operate this bot and are responsible for who you let use it. PopNow's [terms](https://popnow.ai/terms) apply.

## Error handling

| Message or symptom | What to do |
|---|---|
| "out of credits" (`40201`) | Top up at [popnow.ai/pricing](https://popnow.ai/pricing) |
| "reached the spend cap" (`40202`) | The key's cap was reached; raise it in the API console or wait |
| "not allowed to use that model" (`40301`) | Allow the model on the key, or pick another with `/models` |
| "has not verified its email" (`40310`) | Open the verification link PopNow emailed you |
| "The price changed" (`40901`) | The bot re-quotes once on its own; if the new price is higher than what was confirmed, it asks again |
| "The model declined this request" | Reword the prompt or pick another model. Refunded |
| `Conflict: terminated by other getUpdates request` | Two copies of the bot use the same token. Stop one |
| Discord commands missing | Global commands can take a moment to appear; set `DISCORD_GUILD_ID` for instant registration |
| Network errors behind a proxy | Node's `fetch` ignores `HTTPS_PROXY` unless started with `NODE_USE_ENV_PROXY=1` |

## FAQ

### How do I make a Telegram bot that generates AI images?

Create a bot with @BotFather, create a PopNow API key, put both in `.env` and run `docker compose up -d --build`.
`/pic <prompt>` then generates an image with the model you choose.

### How do I generate a video from an image with a chat bot?

Tap **Animate** under an image the bot made, or reply to it with `/animate <how it should move>`. The bot
sends the image to an image-to-video model such as MiniMax and posts the clip back in the chat.

### Can the bot add trending video effects to a photo?

Yes. Tap **Effects** under an image (or reply with `/effect <name>`) and pick one, such as Tiny Planet or
Liquid Chrome. Effects are presets you can edit in `effects/default.json`.

### How much does it cost, and can I see the price first?

Every request is quoted before it runs, in PopNow credits (1 credit = $0.01). Above your confirmation
threshold the bot asks first, above your ceiling it refuses, and failed runs are refunded. There is no
subscription; credit packs are on [popnow.ai/pricing](https://popnow.ai/pricing).

### How do I stop other people from spending my credits?

The bot only answers you until you list other users (`ALLOWED_USER_IDS`) or groups (`ALLOWED_CHAT_IDS`).
Per-person and whole-bot daily limits apply on top, and the key's own spend cap holds even if the bot's data is lost.

### Does the bot work on Discord too?

Yes. Set `DISCORD_TOKEN` and the same commands appear as slash commands, with an effect picker menu and
model autocomplete. Telegram and Discord can run from the same process.

### Which AI models can the bot use?

Any image or video model in the PopNow catalog: Kling, Seedance, Wan, Vidu, MiniMax, Nano Banana, GPT Image,
Flux and more. Each person picks theirs with `/models`; `ALLOWED_MODELS` limits the menu.

## Development

```sh
npm ci
npm run check        # typecheck, lint, tests
npm run dev          # build and run with .env
```

The tests use a fake PopNow API and a stand-in Telegram Bot API on localhost, so they need no keys or network.
`npm run live-check` runs the core flow against the real API with `POPNOW_API_KEY` (one image and one 480p
image-to-video; set `LIVE_EFFECT=tiny-planet` to also try an effect) without Telegram or Discord. It spends real credits.

Built on [grammY](https://grammy.dev), [discord.js](https://discord.js.org) and the official
[`popnow`](https://github.com/popnow-ai/popnow-js) TypeScript SDK. Every request carries
`User-Agent: popnow-bot/0.1.0`.

## Links

- Website: [popnow.ai](https://popnow.ai) · Pricing: [popnow.ai/pricing](https://popnow.ai/pricing)
- Docs: [popnow.ai/docs](https://popnow.ai/docs) · API reference: [popnow.ai/docs/openapi](https://popnow.ai/docs/openapi) ([openapi.yaml](https://popnow.ai/docs/openapi.yaml)) · [llms.txt](https://popnow.ai/llms.txt)
- MCP server for AI assistants: [popnow.ai/mcp](https://popnow.ai/mcp)
- Other PopNow repositories:
  [popnow-mcp](https://github.com/popnow-ai/popnow-mcp) ·
  [popnow-skills](https://github.com/popnow-ai/popnow-skills) ·
  [popnow-python](https://github.com/popnow-ai/popnow-python) ·
  [popnow-js](https://github.com/popnow-ai/popnow-js) ·
  [popnow-api](https://github.com/popnow-ai/popnow-api) ·
  [popnow-blender](https://github.com/popnow-ai/popnow-blender) ·
  [popnow-comfyui](https://github.com/popnow-ai/popnow-comfyui) ·
  [n8n-nodes-popnow](https://github.com/popnow-ai/n8n-nodes-popnow) ·
  [popnow-cli](https://github.com/popnow-ai/popnow-cli) ·
  [popnow-go](https://github.com/popnow-ai/popnow-go) ·
  [popnow-php](https://github.com/popnow-ai/popnow-php)

## License

[MIT](LICENSE) © PopNow
