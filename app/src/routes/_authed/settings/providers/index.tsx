import { IconExternalLink, IconKey, IconLogin } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelProviderOAuthMutationOptions,
  connectProviderMutationOptions,
  disconnectProviderMutationOptions,
  invalidateProviders,
  startProviderOAuthMutationOptions,
} from "@/lib/providers/mutations";
import {
  type ProviderConnection,
  providerConnectionsQueryOptions,
  type ProviderOAuthSession,
  providerOAuthStatusQueryOptions,
} from "@/lib/providers/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/providers/")({
  component: RouteComponent,
});

function RouteComponent() {
  const providers = useQuery(providerConnectionsQueryOptions());
  const [selected, setSelected] = useState<ProviderConnection | null>(null);
  const closeSelected = useCallback(() => setSelected(null), []);

  return (
    <PageShell
      description="Connect your own model accounts. Agents choose a provider type; when you run one, it uses your connection for that type. Your credentials are never shared with the agent's creator or another user."
      title="AI providers"
    >
      {providers.error ? (
        <p className="text-destructive text-sm" role="alert">
          Your AI providers could not be loaded.
        </p>
      ) : providers.data ? (
        <PageSection>
          <PageRows>
            {providers.data.map((provider, index) => (
              <React.Fragment key={provider.id}>
                <Item size="sm">
                  <RowMark>
                    {provider.authentication === "api-key" ? (
                      <IconKey className="size-4" />
                    ) : (
                      <IconLogin className="size-4" />
                    )}
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{provider.name}</ItemTitle>
                    <ItemDescription>
                      {provider.description}
                      {!provider.runtimeAvailable
                        ? " This deployment does not currently have a runtime for it."
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full",
                        provider.connected
                          ? "bg-emerald-500"
                          : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="text-muted-foreground text-xs">
                      {provider.connected ? "Connected" : "Not connected"}
                    </span>
                    <Button
                      onClick={() => setSelected(provider)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {provider.connected ? "Manage" : "Connect"}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== providers.data.length - 1 ? <Separator /> : null}
              </React.Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <ProviderDialog onClose={closeSelected} provider={selected} />
    </PageShell>
  );
}

function ProviderDialog({
  provider,
  onClose,
}: {
  provider: ProviderConnection | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const connect = useMutation(connectProviderMutationOptions(queryClient));
  const startOAuth = useMutation(startProviderOAuthMutationOptions());
  const cancelOAuth = useMutation(cancelProviderOAuthMutationOptions());
  const disconnect = useMutation(
    disconnectProviderMutationOptions(queryClient),
  );
  const [credential, setCredential] = useState("");
  const [oauthSession, setOAuthSession] = useState<ProviderOAuthSession | null>(
    null,
  );
  const oauthStatus = useQuery(
    providerOAuthStatusQueryOptions(
      provider?.id ?? "",
      oauthSession?.sessionId ?? "",
    ),
  );
  const error =
    connect.error ??
    startOAuth.error ??
    disconnect.error ??
    oauthStatus.error ??
    (oauthStatus.data?.status === "failed"
      ? new Error(oauthStatus.data.error)
      : null);
  const oauthPending =
    Boolean(oauthSession) &&
    oauthStatus.data?.status !== "connected" &&
    oauthStatus.data?.status !== "failed";

  useEffect(() => {
    if (oauthStatus.data?.status !== "connected") return;
    void invalidateProviders(queryClient).then(() => {
      setOAuthSession(null);
      setCredential("");
      onClose();
    });
  }, [oauthStatus.data?.status, onClose, queryClient]);

  const close = () => {
    if (
      provider &&
      oauthSession &&
      oauthStatus.data?.status !== "connected" &&
      oauthStatus.data?.status !== "failed"
    ) {
      cancelOAuth.mutate({
        providerId: provider.id,
        sessionId: oauthSession.sessionId,
      });
    }
    setOAuthSession(null);
    setCredential("");
    onClose();
  };
  const save = async () => {
    if (!provider) return;
    try {
      await connect.mutateAsync({
        providerId: provider.id,
        ...(provider.authentication === "api-key" ? { credential } : {}),
      });
      close();
    } catch {
      // The mutation's error is rendered in this dialog.
    }
  };
  const authorize = async () => {
    if (!provider) return;
    try {
      setOAuthSession(await startOAuth.mutateAsync(provider.id));
    } catch {
      // The mutation's error is rendered in this dialog.
    }
  };
  const remove = async () => {
    if (!provider) return;
    try {
      await disconnect.mutateAsync(provider.id);
      close();
    } catch {
      // The mutation's error is rendered in this dialog.
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && close()} open={provider !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{provider?.name ?? "Provider"}</DialogTitle>
          <DialogDescription>
            {provider?.authentication === "oauth"
              ? "Authorize your own ChatGPT account. Codex keeps its OAuth tokens in an isolated account directory for your connection; other workspace users receive separate connections."
              : "The API key is encrypted in the credential vault. It is sent only to this provider's configured runtime when you run an agent, and it is never shown again."}
          </DialogDescription>
        </DialogHeader>
        {provider?.authentication === "api-key" ? (
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="provider-key">
              API key
            </label>
            <Input
              autoComplete="off"
              id="provider-key"
              onChange={(event) => setCredential(event.target.value)}
              placeholder={
                provider.connected
                  ? "Enter a replacement key"
                  : "Paste your API key"
              }
              type="password"
              value={credential}
            />
          </div>
        ) : null}
        {provider?.authentication === "oauth" && oauthSession ? (
          <div className="grid gap-3 rounded-lg border bg-muted/30 p-4">
            <div className="grid gap-1">
              <span className="text-sm font-medium">One-time code</span>
              <code className="w-fit rounded bg-background px-3 py-2 font-semibold text-base tracking-widest">
                {oauthSession.userCode}
              </code>
            </div>
            <p className="text-muted-foreground text-sm">
              Open ChatGPT, sign in to the account you want this connection to
              use, then enter the code. This page will update when authorization
              finishes.
            </p>
            <Button
              onClick={() =>
                window.open(
                  oauthSession.verificationUrl,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
              type="button"
            >
              Open ChatGPT sign-in
              <IconExternalLink className="size-4" />
            </Button>
            <span className="text-muted-foreground text-xs" role="status">
              {oauthStatus.data?.status === "pending"
                ? "Waiting for ChatGPT authorization…"
                : "Checking authorization…"}
            </span>
          </div>
        ) : null}
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
        <DialogFooter className="justify-between sm:justify-between">
          {provider?.connected ? (
            <Button
              disabled={
                disconnect.isPending ||
                connect.isPending ||
                startOAuth.isPending ||
                oauthPending
              }
              onClick={() => void remove()}
              type="button"
              variant="destructive"
            >
              Disconnect
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={close} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={
                connect.isPending ||
                startOAuth.isPending ||
                disconnect.isPending ||
                oauthPending ||
                (provider?.authentication === "api-key" && !credential.trim())
              }
              onClick={() =>
                void (provider?.authentication === "oauth"
                  ? authorize()
                  : save())
              }
              type="button"
            >
              {connect.isPending
                ? "Saving…"
                : startOAuth.isPending
                  ? "Starting…"
                  : provider?.authentication === "oauth"
                    ? oauthStatus.data?.status === "failed"
                      ? "Try authorization again"
                      : provider.connected
                        ? "Reconnect ChatGPT"
                        : "Authorize with ChatGPT"
                    : provider?.connected
                      ? "Replace connection"
                      : "Connect"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
