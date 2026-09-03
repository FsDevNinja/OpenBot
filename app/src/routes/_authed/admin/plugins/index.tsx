import { IconChevronRight, IconLoader2, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PluginMark } from "@/components/plugin-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { addCuratedServerMutationOptions } from "@/lib/plugins/mutations";
import {
  type CatalogueItem,
  connectionsQueryOptions,
  type PluginServer,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * What this deployment can reach, as one list per state.
 *
 * This screen used to be three tabs: a catalogue of what could be added, a second tab for what had
 * been, and skills. Answering one question about one vendor — is Drive available, and what can it
 * do — meant visiting two of them, and the third was a different kind of thing altogether. Two
 * lists say the same thing in one read: what is enabled, and what else there is.
 *
 * Enabled rows go to that vendor's own page, because connection and grant details do not fit here.
 * Available rows enable directly: Composio owns the OAuth application, so choosing a workspace
 * integration no longer requires an administrator to configure vendor credentials first.
 */
export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: RouteComponent,
});

function catalogueMeta(entry: CatalogueItem): string | null {
  const parts = [
    entry.toolsCount === null
      ? null
      : `${entry.toolsCount} ${entry.toolsCount === 1 ? "tool" : "tools"}`,
    entry.categories[0] ?? null,
  ];
  const value = parts.filter(Boolean).join(" · ");
  return value || null;
}

/**
 * What a connected row says on the right.
 *
 * The current answer rather than the field's name, which is what the layout skill asks of a summary:
 * "4 tools · 2 Bots" tells an administrator where this vendor stands, and "Tools" would not.
 *
 * A vendor reached as the person asking is a special case worth its own words. It can be fully
 * configured — client registered, tools listed — and still answer nothing, because the thing that
 * reads anything is a grant belonging to whoever is asking. "Not connected" is about you, not about
 * the deployment.
 */
function summaryFor(
  server: PluginServer,
  /**
   * The vendor's auth kind, from the catalogue rather than the server record.
   *
   * A server row says what this deployment has stored; whose credential reaches it is a fact about
   * the vendor. Undefined for a server added by URL, which has no catalogue entry and is therefore
   * never reached as a person.
   */
  auth: CatalogueItem["auth"] | undefined,
  youConnected: boolean,
): string {
  if ((auth === "user-oauth" || auth === "managed-user") && !youConnected)
    return "Your account not connected";
  if (server.tools.length === 0) return "No tools yet";

  const bots = new Set(server.tools.flatMap((tool) => tool.grantedTo)).size;
  const tools = `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
  if (bots === 0) return `${tools} · no Bots`;
  return `${tools} · ${bots} ${bots === 1 ? "Bot" : "Bots"}`;
}

function RouteComponent() {
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const [enableError, setEnableError] = useState<string | null>(null);
  const enable = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    onError: (error: Error) => setEnableError(error.message),
  });

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));
  const available = (plugins.data?.catalogue ?? []).filter(
    (entry) => !added.has(entry.key),
  );
  const builtins = available.filter((entry) => entry.source === "openbot");
  const composio = available.filter((entry) => entry.source === "composio");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredComposio = composio.filter((entry) =>
    [entry.title, entry.summary, entry.vendor, ...entry.categories]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedSearch),
  );
  const visibleComposio = filteredComposio.slice(0, visibleCount);
  /** Keyed by catalogue key, which is also the server id, so a row can ask how it is reached. */
  const catalogueByKey = new Map(
    (plugins.data?.catalogue ?? []).map((entry) => [entry.key, entry]),
  );

  return (
    <PageShell
      description="Choose which integrations this workspace may use. Each person connects their own account separately, and each Bot still needs an explicit tool grant."
      title="Plugins"
    >
      {enableError ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {enableError}
        </p>
      ) : null}
      {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
      {plugins.isPending ? null : plugins.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          Plugins could not be loaded.
        </p>
      ) : (
        <>
          <PageSection
            description="Allowed for this workspace. Open one to connect your own account, refresh its tools, and decide which Bots may use them."
            title="Enabled for workspace"
          >
            {plugins.data?.servers.length === 0 ? (
              <PageEmpty>
                Nothing enabled yet. Choose an integration below.
              </PageEmpty>
            ) : (
              <PageRows>
                {plugins.data?.servers.map((server, index) => {
                  const entry = catalogueByKey.get(server.id);
                  return (
                    <React.Fragment key={server.id}>
                      {/*
                       * A real link with no children. `useRender` merges props, and children passed
                       * here replace the row's own — the media, content and actions all vanish and
                       * the row draws empty. Its accessible name comes from the title inside it.
                       */}
                      <Item
                        data-testid={`plugin-${server.id}`}
                        render={
                          <Link
                            params={{ key: server.id }}
                            to="/admin/plugins/$key"
                          />
                        }
                        size="sm"
                      >
                        <PluginMark
                          logoUrl={entry?.logoUrl}
                          pluginKey={server.id}
                        />
                        <ItemContent>
                          <ItemTitle>{server.title}</ItemTitle>
                          {/*
                           * The vendor's last failure takes the description's place when there is
                           * one. A server with no tools and no explanation reads as a server that
                           * offers nothing, which sends somebody looking in the wrong place.
                           */}
                          <ItemDescription
                            className={
                              server.lastError ? "text-destructive" : undefined
                            }
                          >
                            {server.lastError ??
                              entry?.summary ??
                              server.summary}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {summaryFor(
                              server,
                              entry?.auth,
                              connected.has(server.id),
                            )}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== (plugins.data?.servers.length ?? 0) - 1 && (
                        <Separator />
                      )}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description="Live from this workspace's Composio project. These choices use OAuth applications and tokens managed by Composio; OpenBot stores grants and audit history, not provider credentials."
            title="Available through Composio"
          >
            <div className="relative mt-4">
              <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search Composio integrations"
                className="pl-8"
                onChange={(event) => {
                  setSearch(event.target.value);
                  setVisibleCount(50);
                }}
                placeholder="Search integrations"
                type="search"
                value={search}
              />
            </div>
            {plugins.data?.catalogueError ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {plugins.data.catalogueError}
              </p>
            ) : null}
            {filteredComposio.length === 0 ? (
              <PageEmpty>
                {normalizedSearch
                  ? "No Composio integrations match that search."
                  : "Every available Composio integration is already enabled."}
              </PageEmpty>
            ) : (
              <PageRows>
                {visibleComposio.map((entry: CatalogueItem, index) => {
                  const isEnabling =
                    enable.isPending && enable.variables?.key === entry.key;
                  return (
                    <React.Fragment key={entry.key}>
                      <Item data-testid={`plugin-${entry.key}`} size="sm">
                        <PluginMark
                          logoUrl={entry.logoUrl}
                          pluginKey={entry.key}
                        />
                        <ItemContent>
                          <ItemTitle>{entry.title}</ItemTitle>
                          <ItemDescription>{entry.summary}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          {catalogueMeta(entry) ? (
                            <span className="hidden text-muted-foreground text-xs sm:inline">
                              {catalogueMeta(entry)}
                            </span>
                          ) : null}
                          <Button
                            disabled={
                              enable.isPending ||
                              !plugins.data?.managedAuthConfigured
                            }
                            onClick={() => {
                              setEnableError(null);
                              enable.mutate({ key: entry.key });
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {isEnabling ? (
                              <IconLoader2 className="animate-spin" />
                            ) : null}
                            {isEnabling ? "Enabling" : "Enable"}
                          </Button>
                        </ItemActions>
                      </Item>
                      {index !== visibleComposio.length - 1 && <Separator />}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
            {visibleComposio.length < filteredComposio.length ? (
              <div className="mt-3 flex justify-center">
                <Button
                  onClick={() => setVisibleCount((count) => count + 50)}
                  type="button"
                  variant="ghost"
                >
                  Show 50 more
                </Button>
              </div>
            ) : null}
          </PageSection>

          {builtins.length > 0 ? (
            <PageSection
              description="Capabilities maintained inside OpenBot. They need no external account or OAuth application."
              title="OpenBot capabilities"
            >
              <PageRows>
                {builtins.map((entry, index) => (
                  <React.Fragment key={entry.key}>
                    <Item data-testid={`plugin-${entry.key}`} size="sm">
                      <PluginMark
                        logoUrl={entry.logoUrl}
                        pluginKey={entry.key}
                      />
                      <ItemContent>
                        <ItemTitle>{entry.title}</ItemTitle>
                        <ItemDescription>{entry.summary}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          disabled={enable.isPending}
                          onClick={() => {
                            setEnableError(null);
                            enable.mutate({ key: entry.key });
                          }}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {enable.isPending &&
                          enable.variables?.key === entry.key
                            ? "Enabling"
                            : "Enable"}
                        </Button>
                      </ItemActions>
                    </Item>
                    {index !== builtins.length - 1 && <Separator />}
                  </React.Fragment>
                ))}
              </PageRows>
            </PageSection>
          ) : null}
        </>
      )}
    </PageShell>
  );
}
