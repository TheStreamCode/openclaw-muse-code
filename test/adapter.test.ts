import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ADAPTER_VERSION,
  COLLIDING_TOOL_NAMES,
  DEFAULT_UPSTREAM,
  SseRestorer,
  planToolAliases,
  startMuseCodeAdapter,
  transformRequestBody,
  transformResponseBody,
} from "../src/adapter.js";

type Json = Record<string, unknown>;

const tool = (name: string, extra: Json = {}): Json => ({
  type: "function",
  name,
  description: `Tool ${name}.`,
  parameters: { type: "object", properties: {} },
  ...extra,
});

const sse = (events: Json[]): string =>
  events.map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`).join("");

type FakeUpstream = {
  origin: string;
  close: () => Promise<void>;
};

async function fakeUpstream(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<FakeUpstream> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake upstream has no port");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("adapter contract", () => {
  it("pins the contract version, the upstream and the builtin collision set", () => {
    expect(ADAPTER_VERSION).toBe(3);
    expect(DEFAULT_UPSTREAM).toBe("https://api.meta.ai");
    for (const name of [
      "read_file",
      "write_file",
      "edit_file",
      "bash",
      "web_search",
      "web_fetch",
      "workflow",
      "search",
      "write_todos",
      "apply_patch",
      "create_goal",
      "send_session_message",
      "tool_search",
      "subagent_send_message",
      "subagent_cancel",
    ]) {
      expect(COLLIDING_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(COLLIDING_TOOL_NAMES.has("get_weather")).toBe(false);
    expect(COLLIDING_TOOL_NAMES.size).toBe(40);
  });
});

describe("planToolAliases", () => {
  it("aliases only colliding flat function tools", () => {
    const plan = planToolAliases([
      tool("bash"),
      tool("get_weather"),
      tool("read_file"),
      { type: "namespace", name: "muse", tools: [tool("bash")] },
      { type: "web_search" },
    ]);
    expect([...plan.aliases.entries()]).toEqual([
      ["bash", "client_bash"],
      ["read_file", "client_read_file"],
    ]);
    expect(plan.reverse.get("client_bash")).toBe("bash");
  });

  it("gives an already-declared alias a stable suffix", () => {
    const plan = planToolAliases([tool("bash"), tool("client_bash")]);
    expect(plan.aliases.get("bash")).toBe("client_bash_2");
  });

  it("aliases every flat function tool in all mode", () => {
    const plan = planToolAliases(
      [tool("read"), tool("bash"), { type: "web_search" }, tool("get_weather")],
      { all: true },
    );
    expect([...plan.aliases.keys()]).toEqual(["read", "bash", "get_weather"]);
  });
});

describe("transformRequestBody", () => {
  it("aliases tools, history calls and forced choice and normalizes parameters", () => {
    const original: Json = {
      model: "muse-spark-1.3",
      tools: [tool("bash"), tool("get_weather")],
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
      tool_choice: { type: "function", name: "bash" },
      reasoning_effort: "low",
      max_output_tokens: 8,
    };
    const { body, notes } = transformRequestBody(original);
    expect((body["tools"] as Json[]).map((entry) => entry["name"])).toEqual([
      "client_bash",
      "get_weather",
    ]);
    expect((body["input"] as Json[])[1]?.["name"]).toBe("client_bash");
    expect((body["input"] as Json[])[2]?.["name"]).toBeUndefined();
    expect(body["tool_choice"]).toBe("auto");
    expect(body["reasoning"]).toEqual({ effort: "low" });
    expect(body["reasoning_effort"]).toBeUndefined();
    expect(body["max_output_tokens"]).toBe(16);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect((original["tools"] as Json[])[0]?.["name"]).toBe("bash");
    expect(notes).toHaveLength(5);
  });

  it("maps thinking-off effort and honors a host output floor", () => {
    const { body, notes } = transformRequestBody(
      {
        model: "muse-spark-1.3",
        reasoning: { effort: "none" },
        max_output_tokens: 8,
      },
      undefined,
      { minOutputTokens: 1024 },
    );
    expect(body["reasoning"]).toEqual({ effort: "minimal" });
    expect(body["max_output_tokens"]).toBe(1024);
    expect(notes).toContain("reasoning.effort none->minimal");
    expect(notes).toContain("max_output_tokens>=1024");
  });

  it("only normalizes parameters when no name collides", () => {
    const { body, notes } = transformRequestBody({
      model: "muse-spark-1.3",
      tools: [tool("get_weather")],
      tool_choice: "auto",
      max_output_tokens: 64,
      include: ["reasoning.encrypted_content"],
    });
    expect((body["tools"] as Json[]).map((entry) => entry["name"])).toEqual(["get_weather"]);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["max_output_tokens"]).toBe(64);
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(notes).toEqual([]);
  });
});

describe("SseRestorer", () => {
  it("restores names everywhere and repairs empty arguments from the deltas", () => {
    const reverse = new Map([
      ["client_bash", "bash"],
      ["client_read_file", "read_file"],
    ]);
    const restorer = new SseRestorer(reverse);
    const events: Json[] = [
      {
        type: "response.created",
        response: { tools: [tool("client_bash", { description: "Runs a command." })], output: [] },
      },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", name: "client_bash", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"command":"ls"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        name: "client_bash",
        arguments: '{"command":"ls"}',
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_1", name: "client_bash", arguments: "" },
      },
      {
        type: "response.completed",
        response: {
          tools: [tool("client_bash", { description: "Runs a command." })],
          output: [{ type: "function_call", id: "fc_1", name: "client_bash", arguments: "" }],
        },
      },
    ];
    const out = sse(events)
      .split("\n")
      .map((line) => (line.startsWith("data:") ? restorer.feed(line) : line))
      .join("\n");
    expect(out).not.toMatch(/client_bash/);
    expect(out).toMatch(/"name":"bash"/);
    expect(out).toMatch(/"arguments":"\{\\"command\\":\\"ls\\"\}"/);
  });

  it("leaves non-data lines and malformed payloads untouched", () => {
    const restorer = new SseRestorer(new Map([["client_bash", "bash"]]));
    expect(restorer.feed("event: response.created")).toBe("event: response.created");
    expect(restorer.feed("data: not-json")).toBe("data: not-json");
    expect(restorer.feed("data: [DONE]")).toBe("data: [DONE]");
  });
});

describe("transformResponseBody", () => {
  it("restores aliased names and leaves other items alone", () => {
    const body = {
      output: [
        { type: "reasoning", id: "rs_1", encrypted_content: "x" },
        { type: "function_call", id: "fc_1", name: "client_bash", arguments: '{"command":"ls"}' },
        { type: "message", role: "assistant", content: [] },
      ],
    };
    const out = transformResponseBody(body, new Map([["client_bash", "bash"]]));
    expect((out["output"] as Json[])[1]?.["name"]).toBe("bash");
    expect((out["output"] as Json[])[0]?.["encrypted_content"]).toBe("x");
  });
});

describe("startMuseCodeAdapter", () => {
  it("rewrites the forwarded body and restores the streamed answer", async () => {
    const seen: Array<{ url: string; body: Json }> = [];
    const upstream = await fakeUpstream((request, response, body) => {
      seen.push({ url: request.url ?? "", body: JSON.parse(body) as Json });
      const events: Json[] = [
        { type: "response.created", response: { tools: [], output: [] } },
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_1", name: "client_bash", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          delta: '{"command":"ls"}',
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", name: "client_bash", arguments: "" },
        },
        { type: "response.completed", response: { tools: [], output: [] } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse(events));
    });
    const adapter = await startMuseCodeAdapter({ upstream: upstream.origin, ports: [0] });
    cleanups.push(adapter.close, upstream.close);
    const res = await fetch(`${adapter.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer LLM|test", "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        tools: [tool("bash")],
        tool_choice: "required",
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/client_bash/);
    expect(text).toMatch(/"name":"bash"/);
    expect(text).toMatch(/"arguments":"\{\\"command\\":\\"ls\\"\}"/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/v1/responses");
    expect((seen[0]?.body["tools"] as Json[])[0]?.["name"]).toBe("client_bash");
    expect(seen[0]?.body["tool_choice"]).toBe("auto");
  });

  it("restores non-streaming JSON answers and relays other paths untouched", async () => {
    const upstream = await fakeUpstream((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "GET") {
        response.end(JSON.stringify({ object: "list", data: [{ id: "muse-spark-1.3" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          output: [
            { type: "function_call", id: "fc_1", name: "client_read_file", arguments: '{"path":"a"}' },
          ],
        }),
      );
    });
    const adapter = await startMuseCodeAdapter({ upstream: upstream.origin, ports: [0] });
    cleanups.push(adapter.close, upstream.close);
    const res = await fetch(`${adapter.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", tools: [tool("read_file")] }),
    });
    const body = (await res.json()) as Json;
    expect((body["output"] as Json[])[0]?.["name"]).toBe("read_file");

    const catalog = await fetch(`${adapter.baseUrl}/models`, {
      headers: { authorization: "Bearer test" },
    });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ object: "list", data: [{ id: "muse-spark-1.3" }] });
  });

  it("retries once with every tool aliased when the gate refuses", async () => {
    const bodies: Json[] = [];
    const upstream = await fakeUpstream((_request, response, body) => {
      const parsed = JSON.parse(body) as Json;
      bodies.push(parsed);
      const unaliased = ((parsed["tools"] as Json[]) ?? []).filter(
        (entry) => entry["type"] === "function" && !String(entry["name"]).startsWith("client_"),
      );
      if (unaliased.length > 0) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "client_attestation_denied", type: "permission_error" } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          output: [
            { type: "function_call", id: "fc_1", name: (parsed["tools"] as Json[])[0]?.["name"], arguments: "{}" },
          ],
        }),
      );
    });
    const adapter = await startMuseCodeAdapter({ upstream: upstream.origin, ports: [0] });
    cleanups.push(adapter.close, upstream.close);
    const res = await fetch(`${adapter.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", tools: [tool("future_muse_tool"), tool("get_weather")] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect((body["output"] as Json[])[0]?.["name"]).toBe("future_muse_tool");
    expect(bodies).toHaveLength(2);
    expect(((bodies[1] as Json)["tools"] as Json[]).map((entry) => entry["name"])).toEqual([
      "client_future_muse_tool",
      "client_get_weather",
    ]);
  });

  it("relays the original body in passthrough mode", async () => {
    const seen: Json[] = [];
    const upstream = await fakeUpstream((_request, response, body) => {
      seen.push(JSON.parse(body) as Json);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
    });
    const adapter = await startMuseCodeAdapter({
      upstream: upstream.origin,
      ports: [0],
      passthrough: true,
    });
    cleanups.push(adapter.close, upstream.close);
    const payload = { model: "muse-spark-1.3", tools: [tool("bash")], tool_choice: "required" };
    const res = await fetch(`${adapter.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual(payload);
  });

  it("keeps the default upstream and port list on the local interface", async () => {
    const adapter = await startMuseCodeAdapter({ ports: [0] });
    cleanups.push(adapter.close);
    expect(adapter.baseUrl).toBe(`http://127.0.0.1:${String(adapter.port)}/v1`);
    expect(adapter.port).toBeGreaterThan(0);
  });
});
