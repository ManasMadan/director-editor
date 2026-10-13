-- Whether an MCP access token's grant still stands: the user still approves the client
-- for that workspace (disconnecting deletes the consent) and is still a member of it.
-- Both MCP servers ask on every request, so disconnecting an app or leaving a
-- workspace takes effect at once, not when the token expires. One definition for
-- both languages; neither service needs the tables themselves.
CREATE OR REPLACE FUNCTION auth.mcp_grant_active(client_id text, user_id uuid, org_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.oauth_consent c
    WHERE c.client_id = mcp_grant_active.client_id
      AND c.user_id = mcp_grant_active.user_id
      AND c.reference_id = mcp_grant_active.org_id
  ) AND EXISTS (
    SELECT 1 FROM auth.member m
    WHERE m.organization_id = mcp_grant_active.org_id AND m.user_id = mcp_grant_active.user_id
  )
$$;
REVOKE EXECUTE ON FUNCTION auth.mcp_grant_active(text, uuid, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO app_ai;
GRANT EXECUTE ON FUNCTION auth.mcp_grant_active(text, uuid, uuid) TO app_api, app_ai;
