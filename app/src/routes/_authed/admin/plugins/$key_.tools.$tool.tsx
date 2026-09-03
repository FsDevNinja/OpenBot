import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * One tool, as an administrator reviews the workspace catalogue.
 *
 * Capability assignment lives on the coworker. This page is deliberately only the catalogue fact:
 * what the provider says the tool does and how workspace policy will classify it.
 *
 * `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page rather
 * than becoming a layout with an outlet.
 */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/tools/$tool",
)({ component: RouteComponent });

function RouteComponent() {
  const { key, tool: toolName } = useParams({
    from: "/_authed/admin/plugins/$key_/tools/$tool",
  });
  const plugins = useQuery(pluginsPageQueryOptions());

  const server = plugins.data?.servers.find((row) => row.id === key);
  const tool = server?.tools.find((row) => row.name === toolName);

  const back = {
    label: server?.title ?? "Plugin",
    linkProps: {
      params: { key },
      to: "/admin/plugins/$key" as const,
    },
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return <PageShell title="Tool">{null}</PageShell>;
  }

  if (!tool) {
    return (
      <PageShell
        backButton={back}
        description="This connector does not advertise a tool by that name."
        title={toolName}
      >
        {/*
         * Says which of the two it is. A tool disappears from this list when the vendor stops
         * offering it, and that reads very differently from a mistyped address.
         */}
        <PageEmpty>
          {server
            ? "It may have been withdrawn since the tool list was last refreshed."
            : "This deployment has not enabled that connector."}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={tool.description || "This tool came with no description."}
      title={toolName}
    >
      <PageSection
        description={
          tool.operation === "delete"
            ? 'The provider marks this operation as destructive. Workspace boundaries may block it with mcp.operation == "delete".'
            : tool.operation === "write"
              ? "This tool changes something at the provider. A boundary written about writes applies to it."
              : "The provider marks this operation as read only. Runtime enforcement remains fail closed for managed catalogues."
        }
        title="What it does"
      >
        <PageRows>
          {/*
           * Read-only, and the layout skill's third row kind is right here: there is one of it, it is
           * the fact the section exists to state, and nothing about it is switchable. The effect
           * comes from the vendor's own classification, not from the tool's name.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Safety category</ItemTitle>
              <ItemDescription>
                Taken from connector metadata, not inferred from the tool name.
                Anything unrecognised is treated as a write.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span
                className={
                  tool.operation === "delete"
                    ? "text-destructive text-xs"
                    : tool.operation === "write"
                      ? "text-amber-600 text-xs dark:text-amber-500"
                      : "text-muted-foreground text-xs"
                }
              >
                {tool.operation === "delete"
                  ? "destructive"
                  : tool.operation === "write"
                    ? "write"
                    : "read only"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
