/**
 * The catalogue of capabilities this deployment may enable, and the rule deciding admissibility.
 *
 * OpenBot-native capabilities are frozen here. Managed integrations are discovered from the
 * deployment's Composio project, filtered to OAuth applications Composio owns, and translated into
 * the same policy shape. The administrator still chooses which of those integrations the workspace
 * enables; a user cannot supply an arbitrary server or toolkit name.
 *
 * Remote managed tools always execute through the pinned Composio boundary. Direct custom MCP URLs
 * take the separate, fail-closed URL-validation path below. In both cases the address that receives
 * a credential is decided by reviewed code rather than by a model or browser request.
 */

/**
 * How a server is authenticated, and whose credential does it.
 *
 * The OAuth addresses are pinned here beside the MCP host, for the same reason and with the same
 * rule: they come from the vendor's published documentation and are never taken from a caller.
 * These are where this deployment sends a person's authorization code and receives the refresh
 * token that stands in for their access, so they are a reviewed source contract too.
 */
// The one place browsing and this check agree on: the addresses that hold the deployment's own
// cloud credentials. `target.ts` imports nothing itself, so asking it here adds no dependency.
import { isNeverAllowedHostname } from "../computer/target";
import type { ManagedToolkit } from "./managed-connector";
// Type-only, so naming the transport here creates no import cycle with the registry that resolves it.
import type { TransportKind } from "./transport";

export type CatalogueAuth =
  /** Answers without any credential at all. */
  | { kind: "none" }
  /** One token, held by the deployment, used for everybody. */
  | { kind: "deployment-bearer" }
  /**
   * The asker's private connection, held and refreshed by the named connector backend. OpenBot
   * receives only backend-owned connection metadata and never provisions an OAuth application.
   */
  | {
      kind: "managed-user";
      provider: "composio";
      toolkit: string;
    }
  /**
   * First-party and in-process. There is no credential, because there is nothing to authenticate
   * to: the call runs against this deployment's own tables, as the person whose turn it is.
   */
  | { kind: "builtin" }
  /**
   * The asker's own grant. The deployment registers an OAuth client; each person consents once and
   * the call runs on their token, so the vendor decides what comes back.
   */
  | {
      kind: "user-oauth";
      authorizationUrl: string;
      tokenUrl: string;
      /** Where a disconnect is sent, so revocation happens at the vendor and not just here. */
      revokeUrl: string;
      /**
       * What to ask a person to consent to. Narrow on purpose: a scope granted by everybody who
       * connects and used by nothing is a permission nobody remembers agreeing to. Empty for a
       * vendor whose consent screen itself is the scoping (Notion), where scope strings would
       * assert a control that does not exist.
       */
      scopes: readonly string[];
      /**
       * How the deployment gets its OAuth client. Absent means an administrator registers one at
       * the vendor and pastes it in. `dynamic` means the deployment registers ITSELF (RFC 7591)
       * on first connect — no admin step, no client secret; PKCE carries the proof instead.
       */
      clientRegistration?: "dynamic";
      /** The RFC 7591 endpoint. Pinned https, required when `clientRegistration` is `dynamic`. */
      registrationUrl?: string;
      /**
       * Vendor-specific consent-URL parameters. Google's offline/consent pair lives HERE rather
       * than in `authorizationUrlFor`, so one vendor's requirements are never sent to another —
       * an unknown parameter is a thing a strict vendor may refuse the whole request over.
       */
      authorizationParams?: Readonly<Record<string, string>>;
    };

export type CatalogueEntry = {
  /** Stable slug. Prefixes every tool name, so tools from two servers can never collide. */
  key: string;
  title: string;
  vendor: string;
  summary: string;
  /**
   * The one host this server lives on. Null for a vendor that gives every customer their own
   * hostname, where {@link CatalogueEntry.hostPattern} decides instead.
   */
  host: string | null;
  /**
   * Anchored pattern for a per-instance vendor. Only consulted when `host` is null, and written
   * anchored at both ends so it cannot match a host that merely ends in the vendor's domain.
   */
  hostPattern?: string;
  /** The path the MCP endpoint is served at. Frozen here, never taken from a caller. */
  path: string;
  /**
   * Whose credential this server is reached with.
   *
   * This used to be `needsCredential: boolean`, which said that a credential was required and not
   * whose it was. That is the one thing about a connector worth being unambiguous about: a reader
   * who has to guess guesses the deployment's, and a deployment-wide credential pointed at a
   * per-person system means everybody's question is answered from what one account can see. So the
   * shape names it, and every entry states it.
   *
   * `deployment-bearer` is a token an administrator holds on behalf of everybody. `user-oauth` is
   * the person's own grant, where the deployment holds only the OAuth client and each person
   * consents for themselves. `builtin` is neither: there is nothing to authenticate to, because the
   * call runs in this process against this deployment's own tables as the person whose turn it is.
   */
  auth: CatalogueAuth;
  /**
   * The tools this vendor's server exposes that change something.
   *
   * Kept so the policy can be written about effect rather than about tool names a rule author would
   * have to look up. Known-incomplete for some vendors, which is why {@link classifyTool} treats an
   * unknown tool as a write rather than as a read: a tool the server never advertised, so nothing
   * here could have named it, is safe to over-scrutinize as a write. The opposite direction is the
   * one that matters for this list: a tool the server DOES advertise but that is missing from here
   * classifies as a read, so an incomplete list is the failure mode, not a safe default — this list
   * has to lean over-inclusive.
   */
  writeTools: readonly string[];
  /**
   * Which protocol reaches this vendor. Absent means MCP, which is what every entry was.
   *
   * A field rather than an inference, because the answer is not derivable from the host: Google
   * serves Drive over both an MCP endpoint and an ordinary REST API, and which one this deployment
   * uses is a decision about availability and risk rather than a property of the vendor. Naming it
   * here keeps that decision beside the host it applies to, and makes reversing it a one-line diff.
   */
  transport?: TransportKind;
  docsUrl: string;
  /** Who supplies this catalogue row. Runtime trust and connection ownership still live above. */
  source?: "openbot" | "composio";
  /** Optional presentation metadata returned by the managed catalogue. */
  logoUrl?: string | null;
  categories?: readonly string[];
  toolsCount?: number | null;
};

/**
 * Static runtime entries.
 *
 * Drive and Notion keep their historical ids so an upgrade cannot orphan existing server, grant or
 * connection rows. They are not the admin catalogue: the live Composio response supplies those
 * choices and their presentation metadata. Routines is genuinely static because it runs inside
 * OpenBot and has no provider catalogue or credential behind it.
 */
export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    key: "google-drive",
    title: "Google Drive",
    vendor: "Google",
    summary: "Files in the Drive of whoever is asking.",
    /*
     * Composio's managed Google Drive toolkit. It owns the OAuth application and private account
     * connection; this host is descriptive catalogue metadata, never called with a provider token.
     */
    host: "https://backend.composio.dev",
    path: "/",
    // Two people asking the same question use separate private connections and see their own Drive.
    auth: Object.freeze({
      kind: "managed-user",
      provider: "composio",
      toolkit: "googledrive",
    }),
    // Managed catalogue entries fail closed as writes in `classifyTool`; names can change upstream.
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.composio.dev/toolkits/googledrive",
    source: "composio",
  },
  {
    key: "notion",
    title: "Notion",
    vendor: "Notion",
    summary: "Pages and databases of whoever is asking.",
    /*
     * The same managed boundary as Drive: Composio provisions the app and keeps each person's
     * credential; OpenBot keeps only its policy, grants and audit trail.
     */
    host: "https://backend.composio.dev",
    path: "/",
    auth: Object.freeze({
      kind: "managed-user",
      provider: "composio",
      toolkit: "notion",
    }),
    // Managed catalogue entries fail closed as writes in `classifyTool`; names can change upstream.
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.composio.dev/toolkits/notion",
    source: "composio",
  },
  {
    key: "routines",
    title: "Routines",
    vendor: "OpenBot",
    summary:
      "Standing instructions a Bot runs on a schedule, as whoever scheduled them.",
    /*
     * First-party and in-process: no host to dial, no credential to hold. In the catalogue anyway,
     * because the catalogue is where a deployment decides WHICH Bots may do WHAT — and scheduling
     * future work is a capability an administrator should grant as deliberately as a vendor.
     */
    host: "builtin://routines",
    path: "/",
    transport: "builtin-routines",
    auth: Object.freeze({ kind: "builtin" }),
    writeTools: Object.freeze([
      "create_routine",
      "update_routine",
      "delete_routine",
    ]),
    docsUrl: "https://github.com/CopilotKit/OpenBot/blob/main/docs/routines.md",
    source: "openbot",
  },
]);

const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]));

/** Compiled once from the frozen source strings above. Never from anything a caller supplied. */
const PATTERNS = new Map(
  CATALOGUE.filter((entry) => entry.hostPattern !== undefined).map((entry) => [
    entry.key,
    new RegExp(entry.hostPattern as string),
  ]),
);

/**
 * Which kind of credential this entry's server record may be pointed at, or null when it takes none
 * from the caller.
 *
 * Beside the entry rather than at the call site, because it is a property of the vendor's auth and
 * not of the request. `deployment-bearer` is the only kind that means "one token this deployment
 * holds for this server", which is what `mcp` names in the vault. A `user-oauth` server is answered
 * with the asker's own grant and its OAuth client is registered through its own call, which mints
 * the credential itself, so an id offered when the server is added is never the right one whatever
 * kind it names. A server needing no credential takes none.
 */
export function serverCredentialKind(entry: CatalogueEntry): "mcp" | null {
  return entry.auth.kind === "deployment-bearer" ? "mcp" : null;
}

export function catalogueEntry(key: string): CatalogueEntry | null {
  const compiled = BY_KEY.get(key);
  if (compiled) return compiled;

  const toolkit = composioToolkitSlug(key);
  if (!toolkit) return null;
  const title = toolkit
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return managedCatalogueEntry({
    slug: toolkit,
    name: title,
    description: `Use ${title} through your own connected account.`,
    logoUrl: null,
    categories: [],
    toolsCount: null,
  });
}

/** Existing ids remain stable so upgrades do not orphan grants or connected-account links. */
const LEGACY_COMPOSIO_KEYS = new Map([
  ["googledrive", "google-drive"],
  ["notion", "notion"],
]);
const LEGACY_COMPOSIO_TOOLKITS = new Map(
  [...LEGACY_COMPOSIO_KEYS].map(([toolkit, key]) => [key, toolkit]),
);
const COMPOSIO_KEY_PREFIX = "composio-";
const COMPOSIO_TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,119}$/;

/** The stable server id used for a toolkit selected from Composio's live catalogue. */
export function composioServerKey(toolkit: string): string {
  return (
    LEGACY_COMPOSIO_KEYS.get(toolkit) ?? `${COMPOSIO_KEY_PREFIX}${toolkit}`
  );
}

/** Recover the remote toolkit from a persisted server id, without a schema-level metadata copy. */
export function composioToolkitSlug(key: string): string | null {
  const legacy = LEGACY_COMPOSIO_TOOLKITS.get(key);
  if (legacy) return legacy;
  if (!key.startsWith(COMPOSIO_KEY_PREFIX)) return null;
  const slug = key.slice(COMPOSIO_KEY_PREFIX.length);
  return COMPOSIO_TOOLKIT_SLUG.test(slug) ? slug : null;
}

/** Turn a toolkit Composio currently offers into the reviewed managed-execution shape OpenBot uses. */
export function managedCatalogueEntry(toolkit: ManagedToolkit): CatalogueEntry {
  return {
    key: composioServerKey(toolkit.slug),
    title: toolkit.name,
    vendor: toolkit.name,
    summary: toolkit.description,
    // Descriptive boundary metadata. Tool discovery and execution go through ManagedConnector.
    host: "https://backend.composio.dev",
    path: "/",
    auth: {
      kind: "managed-user",
      provider: "composio",
      toolkit: toolkit.slug,
    },
    // A remote catalogue may add tools between deploys. Every managed tool therefore fails closed.
    writeTools: Object.freeze([]),
    docsUrl: `https://docs.composio.dev/toolkits/${encodeURIComponent(toolkit.slug)}`,
    source: "composio",
    logoUrl: toolkit.logoUrl,
    categories: Object.freeze([...toolkit.categories]),
    toolsCount: toolkit.toolsCount,
  };
}

/**
 * Is this host one this entry is allowed to be pointed at?
 *
 * Compares the RAW host string, case-sensitively, and returns false for anything it does not
 * positively recognise. Every branch that cannot prove admissibility returns false rather than
 * falling through, because the failure mode of the opposite arrangement is a deployment reaching an
 * address nobody chose.
 */
export function hostAdmissible(entry: CatalogueEntry, host: string): boolean {
  if (entry.host !== null) return entry.host === host;
  const pattern = PATTERNS.get(entry.key);
  if (!pattern) return false;
  return pattern.test(host);
}

/**
 * The URL this server is reached at, or null if the request is not admissible.
 *
 * `instanceHost` is only consulted for a per-instance vendor, and only after the pattern accepts it.
 * The path is always the catalogue's, never the caller's, so an admissible host cannot reach some
 * other endpoint on the same machine.
 */
export function resolveServerUrl(
  key: string,
  instanceHost?: string,
): { url: string; entry: CatalogueEntry } | null {
  const entry = catalogueEntry(key);
  if (!entry) return null;

  const host = entry.host ?? instanceHost ?? null;
  if (host === null) return null;
  if (!hostAdmissible(entry, host)) return null;

  // The path is joined rather than concatenated blindly so a root path does not produce a double
  // slash, which some servers treat as a different route.
  const path = entry.path === "/" ? "" : entry.path;
  return { url: `${host}${path}`, entry };
}

/**
 * What this tool does, in the only two categories a policy author cares about.
 *
 * Unknown counts as a write. A tool named in {@link CatalogueEntry.writeTools} is a write. A tool
 * the server never advertised at all is a write, because the only thing that produced the name was
 * a model. A server with no catalogue entry behind it is a write throughout, because nothing
 * reviewed says any tool of theirs only reads.
 *
 * Only a tool the server itself listed AND that is absent from the write list is treated as a read.
 * That is the one case where both sources agree, and it is the only one where guessing permissively
 * is recoverable.
 */
export function classifyTool(
  entry: CatalogueEntry | null,
  toolName: string,
  advertised: boolean,
): "read" | "write" {
  // A server an administrator added by URL has no reviewed tool catalogue behind it, so nothing here
  // can say a tool of theirs only reads. Everything it offers is a write.
  if (!entry) return "write";
  // Managed catalogues may add tools without a corresponding OpenBot deploy. Until effect metadata
  // is reviewed here, every one is governed as a write rather than silently inheriting read access.
  if (entry.auth.kind === "managed-user") return "write";
  if (!advertised) return "write";
  return entry.writeTools.includes(toolName) ? "write" : "read";
}

/**
 * Words that make a parameter name a credential, wherever they appear in it.
 *
 * A containment test rather than a list of exact names, because the exact-name version of this rule
 * refused `?token=` and accepted `?auth_token=`, `?api_token=`, `?session_token=` and every other
 * spelling one word away. An operator has no way to know which of those the check happens to hold,
 * so a rule that only refuses the names somebody thought of reads as a guard while behaving like a
 * gap.
 *
 * Not shared with `sensitiveKeys` in `audit.ts`: that module reaches the database and this function
 * deliberately imports nothing that does. The two also want different contents, since audit redacts
 * `content`, `prompt` and `result`, which are payload field names and mean nothing here.
 */
const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "bearer",
];

/**
 * Names that are a credential on their own but are too short to contain safely.
 *
 * `sig` is the reason this list is separate from the one above: "design" contains it. These are
 * compared whole, so an ordinary word carrying the same three letters is left alone.
 */
const CREDENTIAL_NAMES = new Set([
  "auth",
  "authorization",
  "pass",
  "pwd",
  "sig",
]);

/**
 * Does this parameter name say it holds a credential?
 *
 * Names are compared with their separators dropped, so `api_key`, `apiKey` and `x-api-key` are one
 * question rather than three. A name ending in "key" is a credential and a name merely containing it
 * is not, which is what keeps `keyword` and `monkey` apart; "author" is likewise not "auth".
 *
 * It over-refuses in one direction on purpose. A parameter this rule misreads costs an operator a
 * rename, and one it misses is written to an append-only audit row that cannot be deleted.
 */
function readsAsCredential(name: string): boolean {
  const normalized = name.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (CREDENTIAL_NAMES.has(normalized) || normalized.endsWith("key")) {
    return true;
  }
  return CREDENTIAL_WORDS.some((word) => normalized.includes(word));
}

/**
 * Is this a URL an administrator may point the deployment at?
 *
 * A curated entry is reviewed in code; this is the other path, and it needs its own floor because
 * "add an MCP server" is otherwise a request-forgery primitive aimed at whatever the server can
 * reach: cloud metadata endpoints, databases on the same network, admin panels bound to localhost.
 * The rules are deliberately blunt.
 *
 * HTTPS only, because the credential is a bearer token and plaintext is not negotiable.
 * No address literals, localhost or internal suffixes, because those point at the deployment rather
 * than a vendor service.
 *
 * This is static URL validation: it checks the literal host string and scheme before storage. DNS
 * resolution and per-request network policy are separate deployment controls.
 */
export function customUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL.";
  }

  if (url.protocol !== "https:") {
    return "An MCP server must be reached over https.";
  }

  // Userinfo is not part of the host, so none of the host rules below would look at it, and what is
  // typed here is stored verbatim: addCustomServer writes the string into mcp_servers.url and into
  // the configuration.changed audit payload, whose redaction keys on the field name rather than the
  // value. A secret written this way would sit in the trail in clear text. The refusal deliberately
  // does not echo the URL back.
  if (url.username || url.password) {
    return "Put the credential in the token field rather than in the address.";
  }

  /*
   * The query is the other half of the same hole, and the fragment is the half after that.
   *
   * No host rule below reads either one, and both are stored and audited with the rest of the
   * string, so a token written here is as durable and as readable as one written into the userinfo.
   * The fragment never reaches the server at all, which is why it is not a request-forgery concern
   * and is still a disclosure one: what this rule is about is where the string ends up, not where
   * the request goes.
   *
   * The test is on the parameter name rather than on the presence of a query, because vendors
   * legitimately route and version with parameters. A floor that refused every one of them would be
   * one an operator works around rather than with, and an ordinary `#section` is left alone for the
   * same reason.
   */
  const hash = url.hash.replace(/^#/, "");
  const marker = hash.indexOf("?");
  const fragment =
    marker === -1 ? [hash] : [hash.slice(0, marker), hash.slice(marker + 1)];
  const named = [
    ...url.searchParams.keys(),
    ...fragment.flatMap((part) => [...new URLSearchParams(part).keys()]),
  ];
  if (named.some(readsAsCredential)) {
    return "Put the credential in the token field rather than in the address.";
  }

  // A trailing dot is the root-anchored spelling of the same name and resolves to the same place, so
  // they are stripped here rather than added to each comparison below. Without it "localhost."
  // misses the equality test, "vault.internal." misses the suffix tests, and "database." picks up
  // the dot that the single-label test keys on, so the fully qualified form of every name this
  // function refuses walks straight through it.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");

  // Bracketed IPv6 arrives with the brackets already stripped by URL, so the colon test catches it.
  if (host.includes(":") || /^[0-9.]+$/.test(host)) {
    return "Give a hostname rather than an IP address.";
  }
  /*
   * The cloud metadata endpoint, by name rather than by luck.
   *
   * `metadata.goog` is Google's own short alias for it, published beside `metadata.google.internal`,
   * and it carries a dot and none of the suffixes below, so it read as an ordinary vendor name. The
   * long spelling was refused only incidentally, by the `.internal` test.
   *
   * Asked of the list browsing already uses rather than a second copy here. That list holds the
   * aliases somebody has already had to think about, including the ones Alibaba and ECS answer on,
   * and a new alias added there should not have to be remembered here as well.
   */
  if (isNeverAllowedHostname(host)) {
    return "That address holds this deployment's own cloud credentials.";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "That address is local to the deployment.";
  }
  if (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    // How a Kubernetes service is addressed from inside the cluster. It carries dots and none of
    // the suffixes above, so without this it reads as an ordinary vendor name.
    host.endsWith(".svc") ||
    !host.includes(".")
  ) {
    return "That address is not reachable from outside this network.";
  }

  return null;
}
