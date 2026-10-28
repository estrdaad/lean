# Integration status - 2026-10-28

## Completed

Five books, 6,871 passages, five read-only MCP tools, six passing official-client test groups. Desktop/mobile reader checks matched 171 passages exactly. Reader and index data are published to estrdaad/lean main.

## Production verified

Endpoint: https://goog-reader-mcp.estrdaad-reader.workers.dev/mcp

Account: e72f293e51d912ea1de6e89eef38ae15 (Estrdaad12).
Version: 70f9c833-a147-4646-a153-6e26fb1a32ef.

The official MCP client passed against production: 5 tools, 5 books, 3 search results, exact passage retrieval and chapter pagination (nextStart=2). chatgpt-config.json is now verified. No database or paid service was added. Wrangler device authorization succeeded with account:read, user:read, workers_scripts:write, workers_routes:write and its required offline_access. No credentials are in the repository.

## Remaining account-specific acceptance

Install a custom MCP connection in the user's ChatGPT account, using this endpoint with no authentication; invoke it in a conversation and verify a real tool call. This has NOT yet been verified. Service verification does not mean automatic installation in ChatGPT. See chatgpt-setup.html.

## Operational notes

Cloudflare rejects fetch redirect:error; manual mode now rejects redirects explicitly. Both workerd and production passed after the fix.

A separate Hello World Worker was created during browser troubleshooting in account 99acf431b91f215bf9ee27ce3ca6ed9e (Iamspecial0011), but it is not used by this integration. The final endpoint remains on the original Estrdaad12 account. Browser control failed; deployment was completed through official Wrangler device authorization.

Unrelated books and output/tmp files were preserved. See CHATGPT-INTEGRATION-PLAN.md for the plan and chatgpt-bridge/README.md for deployment and maintenance.
