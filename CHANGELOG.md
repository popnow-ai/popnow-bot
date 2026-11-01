# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-01

The PopNow API bills in exact USD from its own API balance, separate from website credits. The bot now
prices, limits, confirms and reports in USD.

### Added

- USD spend settings: `DAILY_BUDGET_USD` (default 5), `USER_DAILY_BUDGET_USD` (1), `MAX_USD_PER_REQUEST` (1)
  and `CONFIRM_ABOVE_USD` (0.10). They accept up to nine decimal places.

### Changed

- Quotes are read from `maxChargeUsd` (`expectedChargeUsd` when there is no ceiling), and createTask confirms the
  hold with `expectedCostUsd` set to the quote's exact `maxChargeUsd` instead of `expectedCredits`. Holds come
  from `estimatedCostUsd` and charges from `costUsd`.
- Every amount is kept as whole nanodollars, so limits and totals are exact; nothing is parsed into a float.
- Messages, buttons, captions, `/spend`, `/help` and model prices show US dollars (`$0.0405`, `$5.00`). The owner's
  `/spend` shows the API balance from `availableUsd`.
- Insufficient balance (`40201`) tells the operator to add funds at https://popnow.ai/api/console/billing.
- `state.json` stores USD; a ledger written by 0.1.x is converted (1 credit = $0.001) the first time 0.2.0 starts.
- README, `.env.example` and llms.txt describe the USD settings, API pricing, API billing and the developer MCP.
- `User-Agent: popnow-bot/0.2.0`.

### Deprecated

- `DAILY_BUDGET_CREDITS`, `USER_DAILY_BUDGET_CREDITS`, `MAX_CREDITS_PER_REQUEST` and `CONFIRM_ABOVE_CREDITS`.
  They still work, converted at 1 credit = $0.001, and log a warning with the USD setting to use; when both are
  set, the USD setting wins.
- Reading the API's credit fields (`maxCredits`, `expectedCredits`, `estimatedCredits`, `credits`,
  `availableCredits`). They are used only when a response carries no USD field, and `expectedCredits` is sent
  only when a quote has no USD amount at all.
- Note for 0.1.0 users: a credit has been worth $0.001 since 2026-10-19 (it was $0.01 when 0.1.0 shipped), and
  the deprecated settings are read at that rate. A `*_CREDITS` value you set yourself under 0.1.0 is therefore
  worth a tenth of what it was; replace it with the USD setting.

## [0.1.0] - 2026-10-19

### Added

- Telegram (long polling, grammY) and Discord (slash commands, discord.js) front ends sharing one core.
- `/pic` text-to-image, `/vid` text-to-video and `/animate` image-to-video, plus an Animate button under
  every image the bot makes.
- Trending video effects: `/effect`, `/effects` and an Effects button, driven by `effects/default.json`.
- A price quote before every paid run, confirmation above `CONFIRM_ABOVE_CREDITS`, refusal above
  `MAX_CREDITS_PER_REQUEST`, and per-person and whole-bot daily credit limits.
- Owner and allow lists for people and group chats; groups stay off until listed.
- Idempotency keys derived from the chat event, so double taps and redelivered updates never pay twice.
- Restart-safe ledger with a reconciler for tasks that finished while the bot was down.
- Per-person model choice with `/models`, `/spend`, `/report` and an optional one-time usage rules prompt.
- Dockerfile and docker-compose setup with the ledger on a volume.
