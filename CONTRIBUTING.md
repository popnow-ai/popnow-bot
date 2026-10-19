# Contributing

Thanks for helping improve the PopNow Telegram and Discord bot.

1. Fork the repository and create a branch.
2. `npm ci`, then make your change.
3. Run `npm run check` (typecheck, lint and tests). Tests use a fake PopNow API and a local stand-in
   for the Telegram Bot API; they never call a live service or spend credits.
4. Open a pull request that explains what changed and why.

Guidelines:

- Every paid request must keep going through the price quote, the spend limits and the confirmation
  step in `src/core/flows.ts` and `src/core/media.ts`. Changes that skip them will not be merged.
- Follow the public API contract at [popnow.ai/docs/openapi.yaml](https://popnow.ai/docs/openapi.yaml).
  Do not call endpoints or send fields that are not documented there.
- PopNow is a general-audience product: commands, defaults, effects and copy must stay suitable for everyone.
- Keep the repository English-only; `test/repository.test.ts` checks it.
- Add a test for every behaviour change and a line to `CHANGELOG.md`.

For questions about the API itself (accounts, billing, models), contact [PopNow support](https://popnow.ai/contact).
