import { randomUUID } from "node:crypto";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import { from, type Observable } from "rxjs";
import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";

export type BuiltInAgentConfiguration =
  | {
      model: string;
      prompt: string;
      apiKey: string;
      tools?: GrantedTool[];
      maxSteps?: number;
    }
  | {
      type: "custom";
      factory: (input: RunAgentInput) => AsyncIterable<BaseEvent>;
    };

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

/** Translate the protocol's durable transcript into the model API's conversation. */
export function toOpenAIMessages(
  messages: Message[],
): ChatCompletionMessageParam[] {
  return messages.flatMap((message): ChatCompletionMessageParam[] => {
    if (message.role === "activity" || message.role === "reasoning") return [];
    if (message.role === "tool") {
      return [
        {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: textContent(message.content),
        },
      ];
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map(
        (call): ChatCompletionMessageToolCall => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        }),
      );
      return [
        {
          role: "assistant",
          content: textContent(message.content) || null,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        },
      ];
    }
    if (message.role === "developer") {
      return [{ role: "developer", content: message.content }];
    }
    if (message.role === "system") {
      return [{ role: "system", content: message.content }];
    }
    return [{ role: "user", content: textContent(message.content) }];
  });
}

function schemaOf(parameters: unknown): Record<string, unknown> {
  try {
    if (parameters instanceof z.ZodType) {
      return z.toJSONSchema(parameters) as Record<string, unknown>;
    }
  } catch {}
  return parameters && typeof parameters === "object"
    ? (parameters as Record<string, unknown>)
    : { type: "object", properties: {} };
}

function modelTools(
  serverTools: GrantedTool[],
  clientTools: RunAgentInput["tools"],
): ChatCompletionTool[] {
  const tools = new Map<string, ChatCompletionTool>();
  for (const tool of [...serverTools, ...(clientTools ?? [])]) {
    tools.set(tool.name, {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schemaOf(tool.parameters),
      },
    });
  }
  return [...tools.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A small, native AG-UI model agent.
 *
 * Server tools execute here. Browser tools are emitted and deliberately end this run; the browser
 * records their result and starts the next run. That keeps the model loop independent of any UI SDK.
 */
export class BuiltInAgent extends AbstractAgent {
  private configuration: BuiltInAgentConfiguration;
  private controller = new AbortController();

  constructor(configuration: BuiltInAgentConfiguration) {
    super({ description: "OpenBot built-in agent" });
    this.configuration = configuration;
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    if ("factory" in this.configuration) {
      return from(this.configuration.factory(input));
    }
    this.controller = new AbortController();
    return from(this.stream(input));
  }

  override abortRun(): void {
    this.controller.abort();
    super.abortRun();
  }

  override clone(): BuiltInAgent {
    const clone = new BuiltInAgent(this.configuration);
    clone.agentId = this.agentId;
    clone.threadId = this.threadId;
    clone.setMessages([...this.messages]);
    clone.setState(this.state);
    return clone;
  }

  private async *stream(input: RunAgentInput): AsyncGenerator<BaseEvent> {
    const configuration = this.configuration;
    if ("factory" in configuration) {
      yield* configuration.factory(input);
      return;
    }

    const model = configuration.model.replace(/^openai\//, "");
    const client = new OpenAI({ apiKey: configuration.apiKey });
    const serverTools = new Map(
      (configuration.tools ?? []).map((tool) => [tool.name, tool]),
    );
    const tools = modelTools(configuration.tools ?? [], input.tools);
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: configuration.prompt },
      ...toOpenAIMessages(input.messages),
    ];

    yield {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent;

    try {
      const maxSteps = configuration.maxSteps ?? 1;
      for (let step = 0; step < maxSteps; step += 1) {
        yield {
          type: EventType.STEP_STARTED,
          stepName: `model-${step + 1}`,
        } as BaseEvent;

        const response = await client.chat.completions.create(
          {
            model,
            messages,
            stream: true,
            ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          },
          { signal: this.controller.signal },
        );

        const messageId = randomUUID();
        let textStarted = false;
        let text = "";
        const pending = new Map<number, PendingToolCall>();

        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            if (!textStarted) {
              textStarted = true;
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              } as BaseEvent;
            }
            text += delta.content;
            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: delta.content,
            } as BaseEvent;
          }

          for (const part of delta.tool_calls ?? []) {
            const index = part.index;
            let call = pending.get(index);
            if (!call) {
              call = {
                id: part.id ?? randomUUID(),
                name: part.function?.name ?? "",
                arguments: "",
              };
              pending.set(index, call);
              if (call.name) {
                yield {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: call.id,
                  toolCallName: call.name,
                  parentMessageId: messageId,
                } as BaseEvent;
              }
            }
            if (part.id) call.id = part.id;
            if (part.function?.name && !call.name) {
              call.name = part.function.name;
              yield {
                type: EventType.TOOL_CALL_START,
                toolCallId: call.id,
                toolCallName: call.name,
                parentMessageId: messageId,
              } as BaseEvent;
            }
            if (part.function?.arguments) {
              call.arguments += part.function.arguments;
              yield {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: call.id,
                delta: part.function.arguments,
              } as BaseEvent;
            }
          }
        }

        if (textStarted) {
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
          } as BaseEvent;
        }

        const calls = [...pending.values()];
        for (const call of calls) {
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: call.id,
          } as BaseEvent;
        }

        const assistant: ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: text || null,
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        };
        messages.push(assistant);

        if (calls.length === 0) {
          yield {
            type: EventType.STEP_FINISHED,
            stepName: `model-${step + 1}`,
          } as BaseEvent;
          break;
        }

        // A client-side call ends this server run. The native browser loop executes and resumes it.
        if (calls.some((call) => !serverTools.has(call.name))) {
          yield {
            type: EventType.STEP_FINISHED,
            stepName: `model-${step + 1}`,
          } as BaseEvent;
          break;
        }

        for (const call of calls) {
          const tool = serverTools.get(call.name);
          if (!tool) continue;
          let result: string;
          try {
            const args = JSON.parse(call.arguments || "{}");
            result = await tool.execute(args);
          } catch (error) {
            result = `That tool could not be called: ${errorMessage(error)}`;
          }
          yield {
            type: EventType.TOOL_CALL_RESULT,
            messageId: randomUUID(),
            toolCallId: call.id,
            content: result,
            role: "tool",
          } as BaseEvent;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }

        yield {
          type: EventType.STEP_FINISHED,
          stepName: `model-${step + 1}`,
        } as BaseEvent;
      }

      yield {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent;
    } catch (error) {
      yield {
        type: EventType.RUN_ERROR,
        message: errorMessage(error),
        code: "MODEL_RUN_FAILED",
      } as BaseEvent;
    }
  }
}
