import {
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { storeMcpToken } from "@/lib/credentials/mutations";
import {
  addCuratedServerMutationOptions,
  connectAccountMutationOptions,
  refreshPluginServerMutationOptions,
  registerOAuthClientMutationOptions,
  removePluginServerMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  type PluginTool,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One vendor: what the workspace makes available and what safety hints its catalogue exposes.
 *
 * Its own page because what a connector needs configured differs by vendor and does not fit on a
 * row. A token for one, an OAuth client and a redirect URI for another, an instance hostname for a
 * third. Coworker capability choices deliberately live with the coworker instead of growing a
 * column per Bot here.
 */
export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
});

/** Which connector-setup dialog is open, or none. */
type OpenDialog = "token" | "client" | "instance" | null;
type ToolOperation = PluginTool["operation"];

/** The set with one member toggled, as a new set so React sees the change. */
function toggled<Member>(
  set: ReadonlySet<Member>,
  member: Member,
): ReadonlySet<Member> {
  const next = new Set(set);
  if (!next.delete(member)) next.add(member);
  return next;
}

function RouteComponent() {
  const { key } = useParams({ from: "/_authed/admin/plugins/$key" });
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  /*
   * The administrator's OWN connections, not the deployment's.
   *
   * On an admin screen that is a deliberate mixture, and it is the useful one: setting a per-person
   * connector up and finding out whether it works are two different questions, and the second has no
   * answer anywhere on this page without it. Nobody else's connection is readable here — the endpoint
   * only ever returns the caller's, so this cannot become a list of who has connected what.
   */
  const connections = useQuery(connectionsQueryOptions());
  const youConnected = (connections.data?.connections ?? []).some(
    (row) => row.serverId === key,
  );

  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [token, setToken] = useState("");
  const [instanceHost, setInstanceHost] = useState("");
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const [expandedPageOperations, setExpandedPageOperations] = useState<
    ReadonlySet<ToolOperation>
  >(new Set());

  /* Every write reports into one banner rather than each growing its own handler. */
  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const addCurated = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    ...report,
  });
  const registerClient = useMutation({
    ...registerOAuthClientMutationOptions(queryClient),
    ...report,
  });
  const refresh = useMutation({
    ...refreshPluginServerMutationOptions(queryClient),
    ...report,
  });
  const remove = useMutation({
    ...removePluginServerMutationOptions(queryClient),
    ...report,
  });
  const connectSelf = useMutation({
    // Back to this page afterwards, not to the personal settings screen.
    ...connectAccountMutationOptions("admin"),
    ...report,
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be
     * shown to this person in their own browser; there is deliberately nothing here that could
     * complete it for them, and nothing about being an administrator changes that.
     */
    onSuccess: (authorizationUrl) => {
      window.location.href = authorizationUrl;
    },
  });
  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = plugins.data?.servers.find((item) => item.id === key);

  /**
   * How this vendor is reached, from whichever record we have.
   *
   * A server added by URL has no catalogue entry, and nothing about it is reached as a person, so it
   * falls back to the shared-token shape.
   */
  const auth = entry?.auth ?? "deployment-bearer";
  const title = entry?.title ?? server?.title ?? key;

  /** Adding is two writes when a token was typed: the credential, then the record pointing at it. */
  const add = async () => {
    setError(null);
    try {
      const credentialId =
        auth === "deployment-bearer"
          ? await storeMcpToken(key, token || undefined)
          : undefined;
      await addCurated.mutateAsync({
        key,
        instanceHost: instanceHost || undefined,
        credentialId,
      });
      if (auth === "user-oauth" && client.clientId && client.clientSecret) {
        await registerClient.mutateAsync({ serverId: key, ...client });
      }
      setToken("");
      setClient({ clientId: "", clientSecret: "" });
      setDialog(null);
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  /* Nothing rather than a placeholder, so no sentence asserts anything while the fetch is open. */
  if (plugins.isPending) {
    return <PageShell title="Plugin">{null}</PageShell>;
  }
  if (!(entry || server)) {
    return (
      <PageShell
        backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
        description="This deployment does not have a plugin by that name, and the catalogue does not offer one."
        title="Not a plugin"
      >
        <PageEmpty>Nothing to configure.</PageEmpty>
      </PageShell>
    );
  }

  /*
   * The connector's operation hints explain what the workspace is enabling and support a stricter
   * destructive-operation boundary. The runtime still treats every managed call as a coarse write.
   */
  const reads = server?.tools.filter((tool) => tool.operation === "read") ?? [];
  const writes =
    server?.tools.filter((tool) => tool.operation === "write") ?? [];
  const deletes =
    server?.tools.filter((tool) => tool.operation === "delete") ?? [];
  const grantGroups = (
    [
      {
        operation: "read",
        title: "Read only",
        description: "Fetches or searches without changing provider data.",
        tools: reads,
      },
      {
        operation: "write",
        title: "Writes",
        description: "Creates or changes provider data.",
        tools: writes,
      },
      {
        operation: "delete",
        title: "Deletes or destructive",
        description:
          "Deletes, removes, revokes, cancels, or otherwise destroys data.",
        tools: deletes,
      },
    ] satisfies {
      operation: ToolOperation;
      title: string;
      description: string;
      tools: PluginTool[];
    }[]
  ).filter((group) => group.tools.length > 0);
  return (
    <PageShell
      backButton={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
      description={entry?.summary ?? server?.summary}
      title={title}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {/*
       * No section heading. This is one decision, and a heading over a single row that repeats the
       * row's own title tells a reader nothing they cannot already see.
       */}
      <PageSection>
        <PageRows className="mt-0">
          {/*
           * Binary and immediate, which is what the layout skill reserves a Switch for: it takes
           * effect when switched and there is no save. It replaces an "Add to deployment" button and
           * a destructive "Remove" row that were the same decision drawn twice, in two places, one of
           * them looking far more dangerous than the other.
           *
           * The description states the consequence in the present tense, in both directions, because
           * switching this off also removes the capabilities coworkers chose for this connector.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Enable for this deployment</ItemTitle>
              <ItemDescription>
                {server
                  ? "Available for coworker capabilities. Switching this off removes the connector and those capability grants."
                  : "Not available to coworkers. Switch it on to configure it for this workspace."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`Enable ${title} for this deployment`}
                checked={server !== undefined}
                onCheckedChange={(next) => {
                  setError(null);
                  if (next) void add();
                  else remove.mutate(key);
                }}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {server ? (
        <PageSection
          description={
            auth === "managed-user"
              ? "This vendor answers as whoever is asking. Composio provisions the OAuth app and holds each person's private connection; OpenBot keeps grants and audit state, not provider tokens."
              : auth === "user-oauth"
                ? "This vendor answers as whoever is asking. The deployment registers an OAuth client, and each person connects their own account, so a Bot only ever sees what that person can see."
                : auth === "builtin"
                  ? "Built into this deployment. There is no vendor to reach and no credential to hold — a call runs as whoever asked."
                  : "What this deployment presents to the vendor. One credential, used for everybody."
          }
          title="Connection"
        >
          {/*
           * Rows that DO something, and nothing else — with two admitted exceptions. The layout
           * skill's third row kind — a value with no chevron and nothing to click — earns its
           * place on a screen full of them, but among four actionable rows a dead one reads as a
           * control that has stopped working. The redirect URI is prose under the card instead.
           *
           * The first exception is the OAuth client row for a vendor with a dynamic client: there
           * is a real fact to state — this deployment registers itself, nobody configures it —
           * right where the actionable client row would otherwise sit. Leaving that slot empty
           * would read as a missing setup step, not as nothing to do.
           *
           * The second is the whole Connection card for a builtin server: there is nothing to
           * configure, but a card of nothing under a "Connection" heading reads as a missing setup
           * step rather than as the answer. The row states that plainly instead of leaving the
           * card empty — and being first, it also gives the docsUrl row below something other than
           * the card's own top border to sit its leading separator against.
           */}
          <PageRows>
            {auth === "builtin" ? (
              /*
               * Nothing to click. A builtin server runs inside this deployment, on tables it
               * already owns — there is no vendor to authenticate to and no credential to store.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>Connection</ItemTitle>
                  <ItemDescription>
                    Nothing to configure. These tools run inside this
                    deployment, on the tables it already owns.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    Built in
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "deployment-bearer" ? (
              <Item
                render={
                  <button onClick={() => setDialog("token")} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>Access token</ItemTitle>
                  <ItemDescription>
                    Sent as a bearer token on every call to this vendor.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "Held" : "Not set"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            ) : null}

            {auth === "managed-user" ? (
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>Connection service</ItemTitle>
                  <ItemDescription>
                    Composio owns the OAuth application, consent exchange, token
                    storage, and refresh. OpenBot stores no provider
                    credentials.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {plugins.data?.managedAuthConfigured
                      ? "Configured"
                      : "Needs COMPOSIO_API_KEY"}
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && server?.dynamicClient ? (
              /*
               * Nothing to click. This deployment registers its own OAuth client with the
               * vendor (RFC 7591) the first time anybody connects, so there is no client id
               * or secret for an administrator to hold, let alone paste.
               */
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>OAuth client</ItemTitle>
                  <ItemDescription>
                    This deployment registers itself with the vendor on first
                    connect. There is nothing to paste.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    Self-registered
                  </span>
                </ItemActions>
              </Item>
            ) : null}

            {auth === "user-oauth" && !server?.dynamicClient ? (
              <Item
                render={
                  <button onClick={() => setDialog("client")} type="button" />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>OAuth client</ItemTitle>
                  <ItemDescription>
                    Identifies this deployment to the vendor. It reaches
                    nobody's documents on its own.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-xs">
                    {server?.hasCredential ? "Registered" : "Not registered"}
                  </span>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </ItemActions>
              </Item>
            ) : null}

            {/*
             * The administrator's own account, on the setup screen.
             *
             * Setting a connector up and knowing whether it works are different questions, and the
             * second used to have no answer here: an administrator finished configuring Drive and
             * had to go to their personal settings to find out whether any of it was right. This row
             * answers it in place, and stays honest about being personal — it is this person's
             * connection, not deployment state, and it reaches their documents and nobody else's.
             *
             * It is NOT part of setup. The connector is fully configured without it, which is why it
             * sits below the client and says so rather than reading as the next required step.
             *
             * Shown once a client exists, because there is nothing to consent against before
             * that: a Connect button with no OAuth client behind it can only fail. A vendor with a
             * dynamic client is the exception — there is no client to register in advance, so
             * Connect is shown right away and is itself what creates one.
             */}
            {(auth === "managed-user" || auth === "user-oauth") &&
            (auth === "managed-user" ||
              server?.hasCredential ||
              server?.dynamicClient) ? (
              <>
                <Separator />
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>Your account</ItemTitle>
                    <ItemDescription>
                      {youConnected
                        ? `Connected. A coworker with this capability uses your ${title} as you when you run it. Everybody else connects their own.`
                        : "Connect your own account to try this connector. Setup is complete without it, and it reaches your documents only."}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {youConnected ? (
                      <>
                        {/* Decorative: the word beside it already says which. */}
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        <span className="text-muted-foreground text-xs">
                          Connected
                        </span>
                      </>
                    ) : (
                      /* The arrow says this leaves OpenBot for the vendor's consent page. It does. */
                      <Button
                        disabled={
                          connectSelf.isPending ||
                          (auth === "managed-user" &&
                            !plugins.data?.managedAuthConfigured)
                        }
                        onClick={() => {
                          setError(null);
                          connectSelf.mutate(key);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Connect
                        <IconArrowUpRight />
                      </Button>
                    )}
                  </ItemActions>
                </Item>
              </>
            ) : null}

            {entry?.perInstance ? (
              <>
                <Separator />
                <Item
                  render={
                    <button
                      onClick={() => setDialog("instance")}
                      type="button"
                    />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>Instance host</ItemTitle>
                    <ItemDescription>
                      This vendor gives every customer their own hostname,
                      checked against its pattern before anything is stored.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {server?.url ?? "Not set"}
                    </span>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}

            {entry?.docsUrl ? (
              <>
                <Separator />
                <Item
                  render={
                    <a href={entry.docsUrl} rel="noreferrer" target="_blank" />
                  }
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>
                      {auth === "builtin"
                        ? "Documentation"
                        : "Vendor documentation"}
                    </ItemTitle>
                    <ItemDescription>
                      {auth === "builtin"
                        ? "What these tools offer, from the people who maintain them."
                        : "What this server offers, from the people who maintain it."}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconExternalLink className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </>
            ) : null}
          </PageRows>

          {auth === "user-oauth" ? (
            <div className="mt-3 p-3">
              {server?.dynamicClient ? (
                <p className="text-muted-foreground text-sm">
                  The deployment registers its redirect URI itself, so there is
                  nothing to add at the vendor.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Add this to the client's authorised redirect URIs at the
                  vendor, exactly as written. A single wrong character fails
                  there, with a message that does not mention OpenBot.
                </p>
              )}
              {!plugins.data?.redirectUri ? (
                <p className="mt-3 text-destructive text-sm" role="alert">
                  This deployment has no public URL, so nobody can complete a
                  consent flow. Set OPENBOT_PUBLIC_URL.
                </p>
              ) : server?.dynamicClient ? null : (
                /* Selectable and monospaced: it is copied by hand into somebody else's console. */
                <code className="mt-3 block select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {plugins.data.redirectUri}
                </code>
              )}
            </div>
          ) : null}
        </PageSection>
      ) : null}

      {server ? (
        <PageSection
          /*
           * Beside the heading rather than on the page's own baseline. Refreshing is about this list
           * and nothing else on the screen — it asks the vendor what it offers now — so it belongs
           * where the list is named. Ghost, because it is a maintenance action rather than the thing
           * an administrator came here to do.
           */
          action={
            <Button
              disabled={
                refresh.isPending ||
                (auth === "managed-user" &&
                  !plugins.data?.managedAuthConfigured)
              }
              onClick={() => refresh.mutate(key)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Refresh tools
            </Button>
          }
          description="The workspace makes this catalogue available. Coworker owners choose an access level on the coworker's Capabilities page; workspace boundaries still decide every call."
          title="Tools"
        >
          {server.tools.length === 0 ? (
            <PageEmpty>
              {server.lastError ??
                (auth === "managed-user" && !plugins.data?.managedAuthConfigured
                  ? "Configure COMPOSIO_API_KEY to load this connector's tools."
                  : "No tools listed. Refresh to ask the vendor again.")}
            </PageEmpty>
          ) : (
            <div className="space-y-5">
              {grantGroups.map((group) => (
                <div key={group.operation}>
                  <div className="mb-2 flex items-start gap-2 rounded-md px-1 py-1">
                    <button
                      aria-expanded={expandedPageOperations.has(
                        group.operation,
                      )}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded text-left hover:bg-muted/50"
                      onClick={() =>
                        setExpandedPageOperations((previous) =>
                          toggled(previous, group.operation),
                        )
                      }
                      type="button"
                    >
                      {expandedPageOperations.has(group.operation) ? (
                        <IconChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <IconChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span
                          className={
                            group.operation === "delete"
                              ? "block font-medium text-destructive text-sm"
                              : group.operation === "write"
                                ? "block font-medium text-amber-600 text-sm dark:text-amber-500"
                                : "block font-medium text-sm"
                          }
                        >
                          {group.title}
                        </span>
                        <span className="block text-muted-foreground text-xs">
                          {group.description}
                        </span>
                      </span>
                    </button>
                    <span className="pt-1 text-muted-foreground text-xs">
                      {group.tools.length}
                    </span>
                  </div>
                  {expandedPageOperations.has(group.operation) ? (
                    <PageRows>
                      {group.tools.map((tool, index) => (
                        <React.Fragment key={tool.ref}>
                          {/* A real link with no children: children passed to `render` replace the row's own. */}
                          <Item
                            render={
                              <Link
                                params={{ key, tool: tool.name }}
                                to="/admin/plugins/$key/tools/$tool"
                              />
                            }
                            size="sm"
                          >
                            <ItemContent>
                              <ItemTitle className="font-mono text-xs">
                                {tool.name}
                              </ItemTitle>
                              <ItemDescription>
                                {tool.description}
                              </ItemDescription>
                            </ItemContent>
                            <ItemActions>
                              <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                            </ItemActions>
                          </Item>
                          {index !== group.tools.length - 1 && <Separator />}
                        </React.Fragment>
                      ))}
                    </PageRows>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </PageSection>
      ) : null}

      {/*
       * Only when there is something to say. An empty section here would teach a reader to scroll past
       * a heading that is usually blank, which is the opposite of the point.
       *
       * Its own section rather than rows inside Tools, because these are not tools: they are not
       * listed by the vendor, there is no page to open for one, and putting them in the same list
       * would make the count above it wrong.
       */}
      {server && server.withdrawn.length > 0 ? (
        <PageSection
          description="This vendor no longer lists these, so no coworker is told about them and no model can call one. The exact grant is retained for continuity and would become active again if the vendor relisted the tool. Choosing a capability again on the coworker's page replaces that legacy set."
          title="Held but not offered"
        >
          <PageRows>
            {server.withdrawn.map((held, index) => (
              <React.Fragment key={held.ref}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle className="font-mono text-xs">
                      {held.name}
                    </ItemTitle>
                    <ItemDescription>
                      Not listed by {title}
                      {server.toolsRefreshedAt ? ` as of the last refresh` : ""}
                      .
                    </ItemDescription>
                  </ItemContent>
                </Item>
                {index !== server.withdrawn.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <Dialog
        onOpenChange={(open) => setDialog(open ? dialog : null)}
        open={dialog !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "client"
                ? `OAuth client for ${title}`
                : dialog === "instance"
                  ? `Instance host for ${title}`
                  : `Access token for ${title}`}
            </DialogTitle>
            <DialogDescription>
              {dialog === "client"
                ? "From the vendor's console. The secret is stored in this deployment's vault and never read back."
                : dialog === "instance"
                  ? "Your own hostname with this vendor. It is checked against their pattern before anything is stored."
                  : "Stored in this deployment's vault and never read back."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              {dialog === "client" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="client-id">Client ID</FieldLabel>
                    <Input
                      id="client-id"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientId: event.target.value,
                        }))
                      }
                      value={client.clientId}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="client-secret">
                      Client secret
                    </FieldLabel>
                    <Input
                      id="client-secret"
                      onChange={(event) =>
                        setClient((c) => ({
                          ...c,
                          clientSecret: event.target.value,
                        }))
                      }
                      type="password"
                      value={client.clientSecret}
                    />
                  </Field>
                </>
              ) : dialog === "instance" ? (
                <Field>
                  <FieldLabel htmlFor="instance-host">Instance host</FieldLabel>
                  <Input
                    id="instance-host"
                    onChange={(event) => setInstanceHost(event.target.value)}
                    placeholder="https://your-instance.service-now.com"
                    value={instanceHost}
                  />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="access-token">Access token</FieldLabel>
                  <Input
                    id="access-token"
                    onChange={(event) => setToken(event.target.value)}
                    type="password"
                    value={token}
                  />
                </Field>
              )}
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setDialog(null)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!server) {
                  void add();
                  return;
                }
                if (dialog === "client") {
                  registerClient.mutate({ serverId: key, ...client });
                }
                setDialog(null);
              }}
              size="sm"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
