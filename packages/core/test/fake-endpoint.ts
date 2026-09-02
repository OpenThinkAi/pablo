/**
 * An in-process OpenAI-compatible endpoint for the adapter tests: SSE chat
 * completions, on a random free port, with the request timings recorded. The
 * real local writer on `:8002` is a shared, one-prompt-at-a-time server and is
 * never called from a unit test.
 */

export interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
  readonly startedAt: number;
  endedAt: number;
}

export interface FakeEndpointOptions {
  readonly tokens?: readonly string[];
  /** Milliseconds between tokens; the serialization test needs the stream to last. */
  readonly gapMs?: number;
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
  /** Answer with headers and then never send a byte, so the adapter must time out. */
  readonly silent?: boolean;
  readonly status?: number;
  readonly errorBody?: string;
  /**
   * How to answer a request that carries `tools`. The tool path is unstreamed,
   * so these produce a plain JSON completion rather than an SSE stream.
   */
  readonly tool?: {
    readonly name?: string;
    /** An object is serialized; a string is sent verbatim, for the malformed-argument cases. */
    readonly arguments?: Record<string, unknown> | string;
  };
  /** Answer a tool request with prose instead of a tool call, the way a model that ignores the schema does. */
  readonly toolRefusal?: string;
}

export interface FakeEndpoint {
  /** Base URL in the shape a config entry takes: `http://127.0.0.1:<port>/v1`. */
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  stop(): void;
}

const encoder = new TextEncoder();

export function startFakeEndpoint(options: FakeEndpointOptions = {}): FakeEndpoint {
  const requests: RecordedRequest[] = [];
  const tokens = options.tokens ?? ["The ", "valley ", "kept ", "its own time."];
  const gapMs = options.gapMs ?? 5;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const record: RecordedRequest = {
        body: (await request.json()) as Record<string, unknown>,
        authorization: request.headers.get("authorization"),
        startedAt: Date.now(),
        endedAt: 0,
      };
      requests.push(record);

      if (options.status !== undefined) {
        record.endedAt = Date.now();
        return new Response(options.errorBody ?? "upstream said no", { status: options.status });
      }

      if (record.body["tools"] !== undefined && !options.silent) {
        record.endedAt = Date.now();
        return Response.json(toolCompletion(options));
      }

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          if (options.silent) return;
          for (const token of tokens) {
            await Bun.sleep(gapMs);
            controller.enqueue(encoder.encode(event({ choices: [{ index: 0, delta: { content: token } }] })));
          }
          if (options.usage) controller.enqueue(encoder.encode(event({ choices: [], usage: options.usage })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          record.endedAt = Date.now();
          controller.close();
        },
      });

      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The unstreamed shape mlx_lm returns for a forced tool call, or a model ignoring the schema. */
function toolCompletion(options: FakeEndpointOptions): unknown {
  if (options.toolRefusal !== undefined) {
    return { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: options.toolRefusal } }] };
  }
  const args = options.tool?.arguments ?? { replacement: "The valley kept its own time." };
  return {
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: options.tool?.name ?? "propose_edit",
                arguments: typeof args === "string" ? args : JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  };
}
