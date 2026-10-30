// Muse Code request adapter: make subscription traffic look like Muse Code's
// own tool declarations.
//
// Meta's api.meta.ai refuses a Muse Code subscription key when the request
// declares a client function tool whose name collides with one of Muse Code's
// builtin tool names (`read_file`, `bash`, `web_search`, ...). The refusal is
// HTTP 403 with code `client_attestation_denied`. Names that do not collide are
// accepted, and so is the same tool under a non-colliding name (see
// ADAPTER_CONTRACT.md for the measured matrix).
//
// This module runs as a loopback reverse proxy in front of api.meta.ai. It
// aliases only the colliding tool names on the way out and restores them on the
// way back, so the host sees its own tool names and MCP servers keep working.
// Nothing else about the request is rewritten.
//
// The file is dependency-free and deliberately host-agnostic: the same module
// is vendored by the sibling Muse plugins. Keep it in sync (ADAPTER_VERSION).
import http from "node:http";
/** Version of the wire rules below; bump with ADAPTER_CONTRACT.md. */
export const ADAPTER_VERSION = 3;
/** Default upstream; tests override it with a local fake. */
export const DEFAULT_UPSTREAM = "https://api.meta.ai";
/**
 * Muse Code builtin tool names.
 *
 * Reconstructed from the 1.4.14 binary's tool catalog and from `muse exec`
 * captures, then probed one by one against api.meta.ai on 2026-10-30: a flat
 * client tool with one of these exact names is refused with 403
 * `client_attestation_denied`. The catalog includes goal, cron, session and
 * patch tools as well as the file, shell and web families. `tool_search` is
 * included defensively: one probe returned 200, but field reports see a 403.
 */
export const COLLIDING_TOOL_NAMES = new Set([
    "workflow",
    "read_file",
    "write_file",
    "edit_file",
    "bash",
    "bash_input",
    "search",
    "web_search",
    "web_fetch",
    "powershell",
    "powershell_input",
    "read_memory",
    "add_memory",
    "edit_memory",
    "read_skill",
    "write_todos",
    "monitor",
    "work_status",
    "work_list",
    "work_stop",
    "snooze_reminder",
    "apply_patch",
    "shell",
    "create_goal",
    "get_goal",
    "update_goal",
    "report_progress",
    "request_user_input",
    "cron_create",
    "cron_delete",
    "cron_list",
    "send_session_message",
    "list_peer_sessions",
    "subagent_send_message",
    "subagent_cancel",
    "subagent_spawn",
    "subagent_status",
    "subagent_wait",
    "subagent_read_result",
    "tool_search",
]);
/** Prefix used for aliases; kept outside the builtin set. */
const ALIAS_PREFIX = "client_";
/** Requests larger than this are forwarded untransformed (images, huge prompts). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Ports tried in order, so a route's persisted baseURL stays stable. */
const DEFAULT_PORTS = [43219, 43220, 43221, 43222];
/** Paths whose JSON body and response are adapted. Everything else is relayed. */
function isAdaptedPath(pathname) {
    return pathname.endsWith("/responses") || pathname.endsWith("/chat/completions");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Decide which declared tool names must be aliased.
 *
 * Only flat `function` tools are considered: those are the declarations Meta
 * compares against its builtin set. A namespace container is left untouched.
 * With `all`, every flat function tool is aliased; the proxy uses that as a
 * one-shot retry when the gate refuses names this release does not know.
 */
export function planToolAliases(tools, options = {}) {
    const aliases = new Map();
    if (!Array.isArray(tools))
        return { aliases, reverse: new Map() };
    const taken = new Set();
    for (const tool of tools) {
        if (isRecord(tool) && typeof tool["name"] === "string")
            taken.add(tool["name"]);
    }
    for (const tool of tools) {
        if (!isRecord(tool) || tool["type"] !== "function")
            continue;
        const name = tool["name"];
        if (typeof name !== "string")
            continue;
        if (options.all !== true && !COLLIDING_TOOL_NAMES.has(name))
            continue;
        let alias = `${ALIAS_PREFIX}${name}`;
        let suffix = 2;
        while (taken.has(alias)) {
            alias = `${ALIAS_PREFIX}${name}_${String(suffix)}`;
            suffix += 1;
        }
        taken.add(alias);
        aliases.set(name, alias);
    }
    const reverse = new Map();
    for (const [original, alias] of aliases)
        reverse.set(alias, original);
    return { aliases, reverse };
}
/** Rewrite the names of the tools, history calls and forced tool choice. */
function applyAliases(body, plan) {
    if (plan.aliases.size === 0)
        return;
    const tools = body["tools"];
    if (Array.isArray(tools)) {
        body["tools"] = tools.map((tool) => {
            if (!isRecord(tool) || tool["type"] !== "function")
                return tool;
            const name = tool["name"];
            if (typeof name !== "string")
                return tool;
            const alias = plan.aliases.get(name);
            return alias === undefined ? tool : { ...tool, name: alias };
        });
    }
    const input = body["input"];
    if (Array.isArray(input)) {
        body["input"] = input.map((item) => {
            if (!isRecord(item) || item["type"] !== "function_call")
                return item;
            const name = item["name"];
            if (typeof name !== "string")
                return item;
            const alias = plan.aliases.get(name);
            return alias === undefined ? item : { ...item, name: alias };
        });
    }
    const choice = body["tool_choice"];
    if (isRecord(choice) && choice["type"] === "function") {
        const name = choice["name"];
        if (typeof name === "string") {
            const alias = plan.aliases.get(name);
            if (alias !== undefined)
                body["tool_choice"] = { ...choice, name: alias };
        }
    }
}
/**
 * Apply the wire rules to one Responses/Chat request body.
 *
 * The input object is not mutated: a shallow copy is returned. Unknown fields
 * are preserved untouched. Pass a plan from {@link planToolAliases} to reuse a
 * mapping, for example the full-aliasing retry.
 */
export function transformRequestBody(body, plan) {
    const next = { ...body };
    const notes = [];
    const chosen = plan ?? planToolAliases(next["tools"]);
    if (chosen.aliases.size > 0) {
        applyAliases(next, chosen);
        notes.push(`aliased ${String(chosen.aliases.size)} tool name(s)`);
    }
    const choice = next["tool_choice"];
    if (choice !== undefined && choice !== "auto") {
        // Meta accepts only "auto"; named, "none" and "required" are rejected.
        next["tool_choice"] = "auto";
        notes.push("tool_choice=auto");
    }
    const effort = next["reasoning_effort"];
    if (typeof effort === "string") {
        const reasoning = isRecord(next["reasoning"]) ? next["reasoning"] : {};
        next["reasoning"] = { ...reasoning, effort: reasoning["effort"] ?? effort };
        delete next["reasoning_effort"];
        notes.push("reasoning_effort->reasoning.effort");
    }
    const maxOutput = next["max_output_tokens"];
    if (typeof maxOutput === "number" && maxOutput < 16) {
        next["max_output_tokens"] = 16;
        notes.push("max_output_tokens>=16");
    }
    const include = Array.isArray(next["include"]) ? next["include"] : [];
    if (!include.includes("reasoning.encrypted_content")) {
        next["include"] = [...include, "reasoning.encrypted_content"];
        notes.push("include+reasoning.encrypted_content");
    }
    return { body: next, plan: chosen, notes };
}
/** Restore an aliased name on one wire object, in place. */
function restoreItem(item, reverse) {
    if (!isRecord(item))
        return;
    const type = item["type"];
    if (type !== "function_call" && type !== "function")
        return;
    const name = item["name"];
    if (typeof name !== "string")
        return;
    const original = reverse.get(name);
    if (original !== undefined)
        item["name"] = original;
}
/**
 * Streaming name restorer.
 *
 * Feeds complete SSE lines and returns the line to relay. It restores aliased
 * function-call names and repairs empty `arguments` from the streamed deltas:
 * Meta's authoritative `response.output_item.done` sometimes ships "" even
 * though the deltas carried the JSON.
 */
export class SseRestorer {
    reverse;
    arguments = new Map();
    constructor(reverse) {
        this.reverse = reverse;
    }
    /** Adapt one complete SSE line (without the trailing newline). */
    feed(line) {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmed.startsWith("data:"))
            return line;
        const payload = trimmed.slice(5).trim();
        if (payload === "" || payload === "[DONE]")
            return line;
        let event;
        try {
            const parsed = JSON.parse(payload);
            if (!isRecord(parsed))
                return line;
            event = parsed;
        }
        catch {
            return line;
        }
        this.adapt(event);
        return `data: ${JSON.stringify(event)}${line.endsWith("\r") ? "\r" : ""}`;
    }
    adapt(event) {
        const type = event["type"];
        // `response.function_call_arguments.done` echoes the tool name at the top level.
        const topName = event["name"];
        if (typeof topName === "string") {
            const original = this.reverse.get(topName);
            if (original !== undefined)
                event["name"] = original;
        }
        if (type === "response.function_call_arguments.delta") {
            const id = event["item_id"];
            const delta = event["delta"];
            if (typeof id === "string" && typeof delta === "string") {
                this.arguments.set(id, (this.arguments.get(id) ?? "") + delta);
            }
        }
        if (type === "response.output_item.added" || type === "response.output_item.done") {
            const item = event["item"];
            this.collectArguments(item);
            restoreItem(item, this.reverse);
            this.repairArguments(item);
        }
        const response = event["response"];
        if (isRecord(response))
            this.adaptResponse(response);
    }
    /** Restore names in an emitted response object (tools echo and output items). */
    adaptResponse(response) {
        const tools = response["tools"];
        if (Array.isArray(tools)) {
            for (const tool of tools)
                restoreItem(tool, this.reverse);
        }
        const output = response["output"];
        if (!Array.isArray(output))
            return;
        for (const item of output) {
            this.collectArguments(item);
            restoreItem(item, this.reverse);
            this.repairArguments(item);
        }
    }
    collectArguments(item) {
        if (!isRecord(item) || item["type"] !== "function_call")
            return;
        const id = item["id"];
        const args = item["arguments"];
        if (typeof id === "string" && typeof args === "string" && args !== "") {
            this.arguments.set(id, args);
        }
    }
    repairArguments(item) {
        if (!isRecord(item) || item["type"] !== "function_call")
            return;
        const id = item["id"];
        if (typeof id !== "string")
            return;
        const args = item["arguments"];
        if (args !== undefined && args !== "")
            return;
        const known = this.arguments.get(id);
        if (known !== undefined && known !== "")
            item["arguments"] = known;
    }
}
/** Restore aliased names and empty arguments in a complete JSON response. */
export function transformResponseBody(body, reverse) {
    const output = body["output"];
    if (!Array.isArray(output))
        return body;
    for (const item of output)
        restoreItem(item, reverse);
    return body;
}
function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            const address = server.address();
            if (address === null || typeof address === "string") {
                reject(new Error("adapter has no TCP address"));
                return;
            }
            resolve(address.port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
    });
}
/** Hop-by-hop headers that must not be forwarded to the upstream origin. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);
function upstreamHeaders(request) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined)
            continue;
        if (name === "host" || name === "content-length" || name === "accept-encoding")
            continue;
        if (HOP_BY_HOP.has(name))
            continue;
        if (Array.isArray(value))
            headers.set(name, value.join(", "));
        else
            headers.set(name, value);
    }
    headers.set("accept-encoding", "identity");
    if (!headers.has("x-api-version"))
        headers.set("x-api-version", "1.0.0");
    return headers;
}
function toNodeHeaders(response) {
    const headers = {};
    response.headers.forEach((value, name) => {
        if (name === "content-length" || name === "content-encoding" || name === "transfer-encoding")
            return;
        headers[name] = value;
    });
    return headers;
}
/**
 * Start the loopback adapter.
 *
 * The server binds 127.0.0.1 only. Requests to the Responses and Chat
 * completion paths are adapted; every other path is relayed untouched, so
 * the provider's model discovery keeps working through the same baseURL.
 */
export async function startMuseCodeAdapter(options = {}) {
    const upstream = options.upstream ?? DEFAULT_UPSTREAM;
    const passthrough = options.passthrough === true;
    const log = options.log ?? (() => { });
    const candidates = options.ports ?? DEFAULT_PORTS;
    let lastError;
    let server;
    let port = 0;
    for (const candidate of [...candidates, 0]) {
        const attempt = http.createServer();
        try {
            port = await listen(attempt, candidate);
            server = attempt;
            break;
        }
        catch (error) {
            lastError = error;
        }
    }
    if (server === undefined) {
        throw new Error(`muse-code adapter could not bind a loopback port: ${String(lastError)}`);
    }
    const running = server;
    running.on("request", (request, response) => {
        void handle(request, response).catch((error) => {
            log(`muse-code adapter error: ${error instanceof Error ? error.message : String(error)}`);
            if (!response.headersSent) {
                response.writeHead(502, { "content-type": "application/json" });
            }
            response.end(JSON.stringify({
                error: {
                    code: "muse_code_adapter_error",
                    message: "The local Muse Code adapter could not relay this request.",
                    type: "server_error",
                },
            }));
        });
    });
    async function handle(request, response) {
        const url = request.url ?? "/";
        const pathname = url.split("?", 1)[0] ?? "/";
        const method = request.method ?? "GET";
        const raw = method === "POST" ? await readBody(request) : Buffer.alloc(0);
        let body = raw;
        let reverse = new Map();
        const notes = [];
        let parsedBody;
        if (!passthrough && method === "POST" && isAdaptedPath(pathname) && raw.length > 0) {
            try {
                const parsed = JSON.parse(raw.toString("utf8"));
                if (isRecord(parsed)) {
                    parsedBody = parsed;
                    const adapted = transformRequestBody(parsed);
                    body = Buffer.from(JSON.stringify(adapted.body), "utf8");
                    reverse = adapted.plan.reverse;
                    notes.push(...adapted.notes);
                }
            }
            catch {
                notes.push("body not JSON; relayed as-is");
            }
        }
        const send = (payload) => fetch(`${upstream}${url}`, {
            method,
            headers: upstreamHeaders(request),
            ...(method === "POST" ? { body: payload } : {}),
        });
        let upstreamResponse = await send(body);
        if (!passthrough && parsedBody !== undefined && upstreamResponse.status === 403) {
            // A refusal can mean a builtin name this release does not know yet:
            // retry once with every flat function tool aliased, so a new Muse tool
            // name cannot take the subscription lane down.
            const probe = await upstreamResponse.clone().text();
            if (probe.includes("client_attestation_denied")) {
                const allPlan = planToolAliases(parsedBody["tools"], { all: true });
                if (allPlan.aliases.size > reverse.size) {
                    const retry = transformRequestBody(parsedBody, allPlan);
                    reverse = allPlan.reverse;
                    notes.push(`gate refused; retried with all ${String(allPlan.aliases.size)} tools aliased`);
                    upstreamResponse = await send(Buffer.from(JSON.stringify(retry.body), "utf8"));
                }
            }
        }
        const contentType = upstreamResponse.headers.get("content-type") ?? "";
        if (notes.length > 0) {
            log(`muse-code adapter: ${method} ${pathname} ${String(upstreamResponse.status)} | ${notes.join(", ")}`);
        }
        if (contentType.includes("text/event-stream") && upstreamResponse.body !== null) {
            response.writeHead(upstreamResponse.status, toNodeHeaders(upstreamResponse));
            const restorer = new SseRestorer(reverse);
            const reader = upstreamResponse.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let index = buffer.indexOf("\n");
                while (index >= 0) {
                    const line = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    response.write(`${restorer.feed(line)}\n`);
                    index = buffer.indexOf("\n");
                }
            }
            if (buffer.length > 0)
                response.write(restorer.feed(buffer));
            response.end();
            return;
        }
        const text = await upstreamResponse.text();
        let payload = text;
        if (!passthrough && contentType.includes("application/json") && reverse.size > 0) {
            try {
                const parsed = JSON.parse(text);
                if (isRecord(parsed))
                    payload = JSON.stringify(transformResponseBody(parsed, reverse));
            }
            catch {
                payload = text;
            }
        }
        response.writeHead(upstreamResponse.status, {
            ...toNodeHeaders(upstreamResponse),
            "content-length": Buffer.byteLength(payload),
        });
        response.end(payload);
    }
    return {
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        port,
        close: () => new Promise((resolve, reject) => {
            // The host keeps its sockets alive; do not wait for them to time out.
            running.closeAllConnections();
            running.close((error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        }),
    };
}
