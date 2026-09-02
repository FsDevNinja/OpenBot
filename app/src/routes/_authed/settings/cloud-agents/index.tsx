import { IconCloudCode, IconExternalLink, IconKey } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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
import {
  connectCloudAgentProviderMutationOptions,
  disconnectCloudAgentProviderMutationOptions,
} from "@/lib/cloud-agents/mutations";
import {
  type CloudAgentProvider,
  cloudAgentProvidersQueryOptions,
} from "@/lib/cloud-agents/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/cloud-agents/")({
  component: RouteComponent,
});

function RouteComponent() {
  const providers = useQuery(cloudAgentProvidersQueryOptions());
  const [selected, setSelected] = useState<CloudAgentProvider | null>(null);

  return (
    <PageShell
      title="Cloud agents"
      description="Connect the development workers your agents can delegate repository work to. These providers do not power an agent's personality or reasoning; they receive bounded implementation tasks from it. Every connection and task belongs only to you."
    >
      {providers.error ? (
        <p className="text-destructive text-sm" role="alert">
          Your cloud-agent providers could not be loaded.
        </p>
      ) : providers.data ? (
        <PageSection>
          <PageRows>
            {providers.data.map((provider) => (
              <Item key={provider.id} size="sm">
                <RowMark>
                  <IconCloudCode className="size-4" />
                </RowMark>
                <ItemContent>
                  <ItemTitle>{provider.name}</ItemTitle>
                  <ItemDescription>{provider.description}</ItemDescription>
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
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <CloudAgentProviderDialog
        onClose={() => setSelected(null)}
        provider={selected}
      />
    </PageShell>
  );
}

function CloudAgentProviderDialog({
  provider,
  onClose,
}: {
  provider: CloudAgentProvider | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const connect = useMutation(
    connectCloudAgentProviderMutationOptions(queryClient),
  );
  const disconnect = useMutation(
    disconnectCloudAgentProviderMutationOptions(queryClient),
  );
  const [credential, setCredential] = useState("");
  const error = connect.error ?? disconnect.error;

  const close = () => {
    setCredential("");
    connect.reset();
    disconnect.reset();
    onClose();
  };

  const save = async () => {
    if (!provider) return;
    try {
      await connect.mutateAsync({ providerId: provider.id, credential });
      close();
    } catch {
      // The mutation's error is shown below.
    }
  };

  const remove = async () => {
    if (!provider) return;
    try {
      await disconnect.mutateAsync(provider.id);
      close();
    } catch {
      // The mutation's error is shown below.
    }
  };

  return (
    <Dialog onOpenChange={(open) => !open && close()} open={provider !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{provider?.name ?? "Cloud agent provider"}</DialogTitle>
          <DialogDescription>
            Your API key is encrypted in OpenBot&apos;s credential vault. Agents
            can start and manage tasks through OpenBot, but neither the agent
            definition nor another workspace user receives this key.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="cloud-agent-key">
              Cursor API key
            </label>
            <Input
              autoComplete="off"
              id="cloud-agent-key"
              onChange={(event) => setCredential(event.target.value)}
              placeholder={
                provider?.connected
                  ? "Enter a replacement key"
                  : "Paste your Cursor API key"
              }
              type="password"
              value={credential}
            />
          </div>
          {provider ? (
            <Button
              onClick={() =>
                window.open(
                  provider.dashboardUrl,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
              type="button"
              variant="outline"
            >
              <IconKey className="size-4" />
              Create a key in Cursor
              <IconExternalLink className="size-4" />
            </Button>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Delegated work always starts on a separate Cursor branch. OpenBot
            may ask Cursor to open a pull request; it never merges or deploys
            it.
          </p>
        </div>
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
        <DialogFooter className="justify-between sm:justify-between">
          {provider?.connected ? (
            <Button
              disabled={connect.isPending || disconnect.isPending}
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
                connect.isPending || disconnect.isPending || !credential.trim()
              }
              onClick={() => void save()}
              type="button"
            >
              {connect.isPending
                ? "Verifying…"
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
