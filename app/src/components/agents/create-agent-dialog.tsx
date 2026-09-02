import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useState } from "react";
import useMeasure from "react-use-measure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  agentInputFrom,
  emptyAgentForm,
} from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import {
  agentCapabilitiesQueryOptions,
  type ConnectionVerdict,
  testAgentConnection,
} from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

/**
 * Creating a coworker, one question at a time.
 *
 * A wizard rather than a form, because the answers are three different kinds of decision: who this
 * coworker is, who may see it, and what powers it. Provider credentials belong to the signed-in
 * person, not to the agent profile; a custom AG-UI endpoint remains the escape hatch.
 */
export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** The new coworker's id, so the caller can open its dialog on it. */
  onCreated: (agentId: string) => void;
}) {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent>
        {/* All wizard state lives below DialogContent, whose portal unmounts on close: dismissing
            the dialog mid-way discards the half-answered steps rather than pickling them. */}
        <CreateAgentWizard onClose={onClose} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

/** The steps, in the order they are asked. The name is the questionnaire item's name. */
const STEPS = ["identity", "visibility", "provider"] as const;
type StepName = (typeof STEPS)[number];

/** The two ways a coworker can be seen. */
const VISIBILITY_OPTIONS: Array<{
  value: AgentFormValues["visibility"];
  title: string;
  description: string;
}> = [
  {
    value: "private",
    title: "Private",
    description: "Only you can see it and start channels with it.",
  },
  {
    value: "public",
    title: "Public",
    description: "Everyone in the deployment can find and use it.",
  },
];

type ProviderChoice = string | "external";

/** The first step's slice of the form contract, so its errors match the server's limits. */
const identitySchema = agentFormSchema.pick({
  name: true,
  title: true,
  roleDescription: true,
});

type IdentityField = keyof typeof identitySchema.shape;

/** First message per field, or nothing when the step parses. */
function identityIssues(
  values: AgentFormValues,
): Partial<Record<IdentityField, string>> {
  const parsed = identitySchema.safeParse(values);
  if (parsed.success) return {};
  const issues: Partial<Record<IdentityField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as IdentityField | undefined;
    if (field && !issues[field]) issues[field] = issue.message;
  }
  return issues;
}

/** A pane arrives from the side the journey is moving toward, and leaves out the other. */
const variants = {
  initial: (direction: number) => ({ x: `${110 * direction}%`, opacity: 0 }),
  active: { x: "0%", opacity: 1 },
  exit: (direction: number) => ({ x: `${-110 * direction}%`, opacity: 0 }),
};

function CreateAgentWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agentId: string) => void;
}) {
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  const { data: capabilities } = useQuery(agentCapabilitiesQueryOptions());

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  /** Whether this step's Continue was pressed, which is when its errors become worth showing. */
  const [tried, setTried] = useState(false);
  const [values, setValues] = useState<AgentFormValues>(emptyAgentForm);
  /** Deliberately unanswered: provider choice is separate from the agent's identity. */
  const [provider, setProvider] = useState<ProviderChoice | null>(null);

  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);
  const [ref, bounds] = useMeasure();

  const last = step === STEPS.length - 1;
  const set = <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => setValues((current) => ({ ...current, [key]: value }));

  /** Test endpoint reachability from the server, which is what runs will use. */
  const testConnection = async () => {
    setTesting(true);
    setConnection(null);
    try {
      setConnection(
        await testAgentConnection(values.endpoint, values.authValue),
      );
    } finally {
      setTesting(false);
    }
  };

  const identityErrors = tried ? identityIssues(values) : {};
  const endpointError = !tried
    ? undefined
    : provider === "external" && values.endpoint.trim() === ""
      ? "An endpoint is required for a custom AG-UI provider."
      : agentFormSchema.shape.endpoint.safeParse(values.endpoint).error
          ?.issues[0]?.message;

  const stepValid = (): boolean => {
    if (STEPS[step] === "identity") {
      return identitySchema.safeParse(values).success;
    }
    if (STEPS[step] === "provider") {
      if (provider === null) return false;
      if (provider !== "external") {
        return Boolean(
          capabilities?.providers.some(
            (candidate) => candidate.id === provider && candidate.available,
          ),
        );
      }
      return (
        values.endpoint.trim() !== "" &&
        agentFormSchema.shape.endpoint.safeParse(values.endpoint).success
      );
    }
    // Visibility always holds an answer; the radio starts on private.
    return true;
  };

  const go = (to: number) => {
    setDirection(to > step ? 1 : -1);
    setTried(false);
    setStep(to);
  };

  /**
   * Every way forward lands here — the Continue button, Enter in a field, Enter on a choice — as
   * the questionnaire form's submit. Backwards never validates; half answers are fine to leave.
   */
  const advance = async () => {
    if (!stepValid()) {
      setTried(true);
      return;
    }
    if (!last) {
      go(step + 1);
      return;
    }
    const agent = await createAgent.mutateAsync(
      agentInputFrom(
        values,
        provider && provider !== "external" ? provider : undefined,
      ),
    );
    onCreated(agent.id);
  };

  return (
    <>
      {/* Read aloud, never shown: each step carries its own heading, and a dialog-level title
          above them made two heading sizes compete. The popup still needs an accessible name. */}
      <DialogTitle className="sr-only">New team member</DialogTitle>
      <DialogBody className="overflow-y-auto">
        <Questionnaire
          item={STEPS[step]}
          noValidate
          /*
           * Enter means Continue, handled here rather than through the form's submit. The
           * questionnaire's own submit path refuses any item it does not consider answered, and it
           * cannot see these fields: the identity inputs are this dialog's own, not registered
           * answers. Running first and preventing default also keeps the primitive's Enter
           * handling out of the way; a textarea keeps Enter for its line breaks.
           */
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              void advance();
            }
          }}
          onSubmit={(event) => event.preventDefault()}
        >
          {/* A plain element rather than QuestionnaireProgress: only the active step is mounted,
              so the primitive would count one question and announce the wrong total. */}
          <p className="text-xs font-medium text-muted-foreground tabular-nums">
            Step {step + 1} of {STEPS.length}
          </p>
          <MotionConfig
            transition={{ duration: 0.5, type: "spring", bounce: 0 }}
          >
            {/* The frame follows each pane's height, so the buttons glide instead of jumping.
                `relative` is load-bearing: popLayout positions the exiting pane absolutely, and an
                absolute element is clipped by overflow-hidden only on an ancestor that positions
                it. Without this its containing block is the dialog popup, and the old pane slides
                across the whole dialog instead of out of this frame. */}
            <motion.div
              animate={{ height: bounds.height > 0 ? bounds.height : "auto" }}
              className="relative overflow-hidden"
            >
              <div ref={ref}>
                <AnimatePresence
                  custom={direction}
                  initial={false}
                  mode="popLayout"
                >
                  <motion.div
                    animate="active"
                    className="pt-4"
                    custom={direction}
                    exit="exit"
                    initial="initial"
                    key={STEPS[step]}
                    variants={variants}
                  >
                    {STEPS[step] === "identity" ? (
                      <IdentityStep
                        errors={identityErrors}
                        set={set}
                        values={values}
                      />
                    ) : STEPS[step] === "visibility" ? (
                      <VisibilityStep set={set} values={values} />
                    ) : (
                      <ProviderStep
                        providers={capabilities?.providers ?? []}
                        endpointError={endpointError}
                        provider={provider}
                        onProvider={(next) => {
                          setProvider(next);
                          if (next !== "external") {
                            set("endpoint", "");
                            set("authValue", "");
                            setConnection(null);
                          }
                        }}
                        onTest={() => void testConnection()}
                        connection={connection}
                        set={set}
                        showProviderError={tried && provider === null}
                        testing={testing}
                        values={values}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </motion.div>
          </MotionConfig>

          {createAgent.error ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {createAgent.error.message}
            </p>
          ) : null}

          <div className="mt-6 flex justify-between gap-2">
            <Button
              onClick={step === 0 ? onClose : () => go(step - 1)}
              type="button"
              variant="outline"
            >
              {step === 0 ? "Cancel" : "Back"}
            </Button>
            <Button
              disabled={createAgent.isPending}
              onClick={() => void advance()}
              type="button"
            >
              {last
                ? createAgent.isPending
                  ? "Creating…"
                  : "Create team member"
                : "Continue"}
            </Button>
          </div>
        </Questionnaire>
      </DialogBody>
    </>
  );
}

/**
 * `hidden={false}` and `inert={false}` on every item, against the questionnaire's own hiding.
 *
 * The primitive blanks any item that is not the active one, which is right for its stacked layout
 * and wrong here: only the active step is mounted, except for the instant an old pane is sliding
 * out under AnimatePresence — exactly when the primitive would blank it mid-slide. The item's
 * visibility is the animation's job in this dialog, never the questionnaire's.
 */
function StepItem({
  name,
  children,
}: {
  name: StepName;
  children: React.ReactNode;
}) {
  return (
    <QuestionnaireItem hidden={false} inert={false} name={name}>
      {children}
    </QuestionnaireItem>
  );
}

function IdentityStep({
  values,
  errors,
  set,
}: {
  values: AgentFormValues;
  errors: Partial<Record<IdentityField, string>>;
  set: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
}) {
  return (
    <StepItem name="identity">
      <QuestionnaireTitle>Who is this coworker?</QuestionnaireTitle>
      <QuestionnaireDescription>
        The role you write here applies in every channel this coworker works in.
      </QuestionnaireDescription>
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="create-agent-name">Name</FieldLabel>
          <Input
            aria-invalid={errors.name ? true : undefined}
            id="create-agent-name"
            onChange={(event) => set("name", event.target.value)}
            placeholder="Chief of Staff"
            value={values.name}
          />
          {errors.name ? (
            <FieldError errors={[{ message: errors.name }]} />
          ) : null}
        </Field>
        <Field data-invalid={errors.title ? true : undefined}>
          <FieldLabel htmlFor="create-agent-title">Title</FieldLabel>
          <Input
            aria-invalid={errors.title ? true : undefined}
            id="create-agent-title"
            onChange={(event) => set("title", event.target.value)}
            placeholder="Operations and Planning"
            value={values.title}
          />
          {errors.title ? (
            <FieldError errors={[{ message: errors.title }]} />
          ) : null}
        </Field>
        <Field data-invalid={errors.roleDescription ? true : undefined}>
          <FieldLabel htmlFor="create-agent-role">Role</FieldLabel>
          <Textarea
            aria-invalid={errors.roleDescription ? true : undefined}
            id="create-agent-role"
            onChange={(event) => set("roleDescription", event.target.value)}
            placeholder="Turn priorities into plans, keep decisions organized, and surface anything that needs my attention."
            rows={4}
            value={values.roleDescription}
          />
          {errors.roleDescription ? (
            <FieldError errors={[{ message: errors.roleDescription }]} />
          ) : null}
        </Field>
      </FieldGroup>
    </StepItem>
  );
}

function VisibilityStep({
  values,
  set,
}: {
  values: AgentFormValues;
  set: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
}) {
  return (
    <StepItem name="visibility">
      <QuestionnaireTitle>Who can see it?</QuestionnaireTitle>
      <QuestionnaireChoices>
        {VISIBILITY_OPTIONS.map((option) => (
          <QuestionnaireChoice
            checked={values.visibility === option.value}
            key={option.value}
            onChange={() => set("visibility", option.value)}
            value={option.value}
          >
            <span className="font-medium">{option.title}</span>
            <QuestionnaireChoiceDescription>
              {option.description}
            </QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
        ))}
      </QuestionnaireChoices>
    </StepItem>
  );
}

function ProviderStep({
  providers,
  provider,
  onProvider,
  showProviderError,
  values,
  set,
  endpointError,
  connection,
  testing,
  onTest,
}: {
  providers: Array<{
    id: string;
    name: string;
    description: string;
    runtimeAvailable: boolean;
    connected: boolean;
    available: boolean;
  }>;
  provider: ProviderChoice | null;
  onProvider: (provider: ProviderChoice) => void;
  showProviderError: boolean;
  values: AgentFormValues;
  set: <K extends keyof AgentFormValues>(
    key: K,
    value: AgentFormValues[K],
  ) => void;
  endpointError?: string;
  connection: ConnectionVerdict | null;
  testing: boolean;
  onTest: () => void;
}) {
  return (
    <StepItem name="provider">
      <QuestionnaireTitle>What powers this agent?</QuestionnaireTitle>
      <QuestionnaireDescription>
        The provider supplies the model. The name, role, tools, and conversation
        belong to this agent.
      </QuestionnaireDescription>
      <QuestionnaireChoices>
        {providers.map((option) => (
          <QuestionnaireChoice
            checked={provider === option.id}
            disabled={!option.available}
            key={option.id}
            onChange={() => onProvider(option.id)}
            value={option.id}
          >
            <span className="font-medium">{option.name}</span>
            <QuestionnaireChoiceDescription>
              {option.description}{" "}
              {option.available
                ? ""
                : !option.runtimeAvailable
                  ? "Not available on this deployment."
                  : "Connect it in Settings first."}
            </QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
        ))}
        <QuestionnaireChoice
          checked={provider === "external"}
          onChange={() => onProvider("external")}
          value="external"
        >
          <span className="font-medium">Custom AG-UI</span>
          <QuestionnaireChoiceDescription>
            Use an agent runtime you host at your own endpoint.
          </QuestionnaireChoiceDescription>
        </QuestionnaireChoice>
      </QuestionnaireChoices>
      {providers.some(
        (option) => option.runtimeAvailable && !option.connected,
      ) ? (
        <Button
          render={<Link to="/settings/providers" />}
          size="sm"
          type="button"
          variant="outline"
        >
          Manage AI providers
        </Button>
      ) : null}
      {showProviderError ? (
        <p className="text-sm text-destructive" role="alert">
          Choose what powers this agent.
        </p>
      ) : null}
      {provider === "external" ? (
        <FieldGroup>
          <Field data-invalid={endpointError ? true : undefined}>
            <FieldLabel htmlFor="create-agent-endpoint">
              Agent endpoint
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                aria-invalid={endpointError ? true : undefined}
                id="create-agent-endpoint"
                onChange={(event) => set("endpoint", event.target.value)}
                placeholder="https://your-agent.example.com/ag-ui"
                value={values.endpoint}
              />
              <Button
                disabled={!values.endpoint || testing}
                onClick={onTest}
                type="button"
                variant="outline"
              >
                {testing ? "Testing…" : "Test"}
              </Button>
            </div>
            {endpointError ? (
              <FieldError errors={[{ message: endpointError }]} />
            ) : null}
            {connection ? (
              <p
                className={`text-sm ${connection.ok ? "text-muted-foreground" : "text-destructive"}`}
                role="status"
              >
                {connection.ok
                  ? `It answered: ${connection.events.join(", ")}`
                  : connection.reason}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                Anything that speaks AG-UI works. This server dials your agent,
                so an agent on your own machine has to be reachable from here.
              </p>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="create-agent-key">
              Key for that agent (optional)
            </FieldLabel>
            <Input
              autoComplete="off"
              id="create-agent-key"
              onChange={(event) => set("authValue", event.target.value)}
              placeholder="Bearer …"
              type="password"
              value={values.authValue}
            />
            <p className="text-muted-foreground text-sm">
              Sent as an <code>Authorization</code> header on every run, and
              kept in the credential vault.
            </p>
          </Field>
        </FieldGroup>
      ) : null}
    </StepItem>
  );
}
