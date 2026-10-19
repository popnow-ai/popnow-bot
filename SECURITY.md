# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Open a [private security advisory](https://github.com/popnow-ai/popnow-bot/security/advisories/new) on GitHub, or
- email **support@popnow.ai** with "Security" in the subject.

Include a description, steps to reproduce and the bot version or commit. We aim to acknowledge reports
within a few business days.

## Running the bot safely

- Create a dedicated API key for the bot at [popnow.ai/api/console/keys](https://popnow.ai/api/console/keys)
  and give it a spend cap there. That cap is enforced by PopNow no matter what happens to the bot.
- Keep `POPNOW_API_KEY`, `TELEGRAM_BOT_TOKEN` and `DISCORD_TOKEN` in `.env` or a secret store. Never commit them.
- Leave `ALLOWED_USER_IDS` and `ALLOWED_CHAT_IDS` empty or explicit; `*` lets anyone spend your credits.
- If a key or token leaks, revoke it (PopNow API console, @BotFather or the Discord Developer Portal) and create a new one.
- The bot never forwards Telegram file links (they contain the bot token) or Discord attachment links to
  PopNow; it downloads the bytes and uploads them with `/api/v1/common/upload-url`.
