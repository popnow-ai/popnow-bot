# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
