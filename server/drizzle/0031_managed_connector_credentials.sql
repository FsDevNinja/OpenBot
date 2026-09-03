-- Google Drive and Notion now use private Composio connections. Retire the OAuth clients and
-- refresh tokens older OpenBot builds stored locally before removing their pointers. Revoked vault
-- rows remain for the existing audit/history contract; no secret remains usable by OpenBot.
UPDATE "credentials"
SET "revoked_at" = COALESCE("revoked_at", now()), "updated_at" = now()
WHERE "id" IN (
	SELECT "credential_id"
	FROM "mcp_user_credentials"
	WHERE "server_id" IN ('google-drive', 'notion')
	UNION
	SELECT "credential_id"
	FROM "mcp_servers"
	WHERE "id" IN ('google-drive', 'notion') AND "credential_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "mcp_user_credentials"
WHERE "server_id" IN ('google-drive', 'notion');--> statement-breakpoint
-- The managed catalogue uses Composio tool slugs, not the former direct-connector names. A stale
-- grant must not look usable after this migration, so reset both the cached inventory and its grants.
DELETE FROM "plugin_grants"
WHERE "kind" = 'mcp'
	AND ("ref" LIKE 'google-drive/%' OR "ref" LIKE 'notion/%');--> statement-breakpoint
DELETE FROM "mcp_tools"
WHERE "server_id" IN ('google-drive', 'notion');--> statement-breakpoint
UPDATE "mcp_servers"
SET "credential_id" = NULL,
	"tools_refreshed_at" = NULL,
	"last_error" = NULL,
	"updated_at" = now()
WHERE "id" IN ('google-drive', 'notion');
