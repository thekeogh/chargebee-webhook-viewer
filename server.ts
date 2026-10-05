export {};

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 4343);
const HOST = process.env.HOST || "localhost";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const MONACO_DIR = path.join(PROJECT_ROOT, "node_modules", "monaco-editor", "min");
const FONT_DIR = path.join(PROJECT_ROOT, "node_modules", "@fontsource", "ubuntu-sans-mono", "files");
const CONFIG_DIR = path.join(PROJECT_ROOT, "data");
const FORWARDING_CONFIG_PATH = path.join(CONFIG_DIR, "forwarding.json");
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const NGROK_CONFIG = process.env.NGROK_CONFIG || "/Users/keogh/Dropbox/System/ngrok.yml";
const NGROK_URL = process.env.NGROK_URL || "https://keogh-billing-backend.eu.ngrok.io";
const NGROK_LISTEN_ARGS = ["http", `--config=${NGROK_CONFIG}`, "--host-header=rewrite", `--url=${NGROK_URL}`, `http://${HOST}:${PORT}`, "--log=stdout", "--log-format=json"];
const NGROK_LISTEN_COMMAND = `ngrok ${NGROK_LISTEN_ARGS.join(" ")}`;
const OPEN_BROWSER = process.env.OPEN_BROWSER !== "false";

const clients = new Set<any>();
const listener = {
  process: null,
  status: "stopped",
  pid: null,
  startedAt: null,
  stoppedAt: null,
  lastExit: null,
  logs: [],
};
const forwarding = {
  url: "",
  lastResult: null,
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function safeJsonParse(raw) {
  try {
    return { parsed: JSON.parse(raw), validJson: true };
  } catch (error) {
    return { parsed: raw, validJson: false, parseError: error.message };
  }
}

function loadForwardingConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(FORWARDING_CONFIG_PATH, "utf8"));
    forwarding.url = normalizeForwardingUrl(saved?.url || "");
  } catch {
    forwarding.url = "";
  }
}

function normalizeForwardingUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("Forward webhook URL must use http or https.");
  }
  return parsed.toString();
}

function saveForwardingConfig(url) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(FORWARDING_CONFIG_PATH, `${JSON.stringify({ url }, null, 2)}\n`, "utf8");
}

function forwardingSnapshot() {
  return { url: forwarding.url, lastResult: forwarding.lastResult };
}

function pushForwardingUpdate() {
  broadcast("forwarding", forwardingSnapshot());
}

function forwardedHeaders(headers) {
  const omitted = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...String(headers.connection || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  ]);

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => !omitted.has(key.toLowerCase()))
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value || ""]),
  );
}

function postForwardedWebhook(destination, headers, rawBody) {
  const transport = destination.protocol === "https:" ? https : http;
  return new Promise<any>((resolve, reject) => {
    const request = transport.request(destination, {
      method: "POST",
      headers,
      // This is a local developer relay and may target services with a self-signed TLS certificate.
      rejectUnauthorized: false,
      timeout: 10000,
    }, (response) => {
      response.on("error", reject);
      response.resume();
      response.on("end", () => resolve(response));
    });

    request.on("timeout", () => request.destroy(new Error("Forwarding timed out after 10 seconds.")));
    request.on("error", reject);
    request.end(rawBody);
  });
}

async function forwardWebhook({ sourceUrl, headers, rawBody, eventId }) {
  if (!forwarding.url) return;

  const destination = new URL(forwarding.url);
  // Append the original query verbatim: encoding, duplicate keys and order matter.
  const queryStart = sourceUrl.indexOf("?");
  if (queryStart !== -1 && sourceUrl.slice(queryStart + 1)) {
    destination.search += `${destination.search ? "&" : "?"}${sourceUrl.slice(queryStart + 1)}`;
  }

  const localHosts = new Set([HOST, "localhost", "127.0.0.1", "[::1]"]);
  const forwardedToSelf = (localHosts.has(destination.hostname) &&
    Number(destination.port || (destination.protocol === "https:" ? 443 : 80)) === PORT) ||
    destination.origin === new URL(NGROK_URL).origin;
  if (forwardedToSelf) {
    forwarding.lastResult = { ok: false, at: new Date().toISOString(), eventId, error: "Refusing to forward back to this viewer." };
    pushForwardingUpdate();
    return forwarding.lastResult;
  }

  try {
    const response = await postForwardedWebhook(destination, {
      ...forwardedHeaders(headers),
      "x-chargebee-webhook-viewer-forwarded": "1",
    }, rawBody);
    forwarding.lastResult = {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      at: new Date().toISOString(),
      eventId,
      status: response.statusCode,
      statusText: response.statusMessage,
      url: destination.toString(),
    };
  } catch (error) {
    forwarding.lastResult = {
      ok: false,
      at: new Date().toISOString(),
      eventId,
      url: destination.toString(),
      error: error.message,
    };
  }
  pushForwardingUpdate();
  return forwarding.lastResult;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is larger than 10 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serializableHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : value || "",
    ]),
  );
}

function writeSse(res, eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(payload);
}

function broadcast(eventName, data) {
  for (const res of clients) {
    writeSse(res, eventName, data);
  }
}

function listenerSnapshot() {
  return {
    status: listener.status,
    pid: listener.pid,
    startedAt: listener.startedAt,
    stoppedAt: listener.stoppedAt,
    lastExit: listener.lastExit,
    command: NGROK_LISTEN_COMMAND,
    publicUrl: NGROK_URL,
    logs: listener.logs,
  };
}

function pushListenerUpdate() {
  broadcast("listener", listenerSnapshot());
}

function addListenerLog(stream, chunk) {
  const text = chunk.toString("utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    let message = line;
    try { message = JSON.parse(line).msg || line; } catch {}
    if (listener.status === "starting" && message === "started tunnel") listener.status = "running";
    listener.logs.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      stream,
      line,
    });
  }
  listener.logs = listener.logs.slice(-120);
  pushListenerUpdate();
}

function startNgrokListener() {
  if (listener.process) return listenerSnapshot();

  listener.status = "starting";
  listener.pid = null;
  listener.startedAt = new Date().toISOString();
  listener.stoppedAt = null;
  listener.lastExit = null;
  listener.logs = [];
  pushListenerUpdate();

  const child = spawn("ngrok", NGROK_LISTEN_ARGS, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  listener.process = child;
  listener.pid = child.pid || null;

  const pending = { stdout: "", stderr: "" };
  function consumeOutput(stream, chunk) {
    pending[stream] += chunk.toString("utf8");
    const lines = pending[stream].split(/\r?\n/);
    pending[stream] = lines.pop() || "";
    if (lines.length) addListenerLog(stream, Buffer.from(lines.join("\n")));
  }
  child.stdout.on("data", (chunk) => consumeOutput("stdout", chunk));
  child.stderr.on("data", (chunk) => consumeOutput("stderr", chunk));

  child.on("spawn", () => {
    listener.pid = child.pid;
    addListenerLog("system", Buffer.from(`Started ngrok tunnel with PID ${child.pid}`));
  });

  child.on("error", (error) => {
    listener.status = "error";
    listener.process = null;
    listener.pid = null;
    listener.stoppedAt = new Date().toISOString();
    listener.lastExit = { error: error.message };
    addListenerLog("system", Buffer.from(error.message));
  });

  child.on("exit", (code, signal) => {
    for (const stream of ["stdout", "stderr"]) {
      if (pending[stream]) addListenerLog(stream, Buffer.from(pending[stream]));
    }
    listener.status = listener.status === "stopping" || code === 0 || signal === "SIGINT" ? "stopped" : "error";
    listener.process = null;
    listener.pid = null;
    listener.stoppedAt = new Date().toISOString();
    listener.lastExit = { code, signal };
    addListenerLog("system", Buffer.from(`ngrok tunnel exited: code=${code ?? "null"} signal=${signal ?? "null"}`));
  });

  return listenerSnapshot();
}

function stopNgrokListener() {
  if (!listener.process) {
    listener.status = "stopped";
    listener.pid = null;
    listener.stoppedAt = listener.stoppedAt || new Date().toISOString();
    pushListenerUpdate();
    return listenerSnapshot();
  }

  listener.status = "stopping";
  addListenerLog("system", Buffer.from("Stopping ngrok tunnel"));
  const child = listener.process;
  child.kill("SIGINT");
  setTimeout(() => {
    if (listener.process === child) child.kill("SIGKILL");
  }, 2500).unref();
  return listenerSnapshot();
}

function openBrowser(url) {
  if (!OPEN_BROWSER) return;

  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
    linux: ["xdg-open", [url]],
  };
  const command = commands[process.platform];
  if (!command) return;

  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
  const isMonacoAsset = requestUrl.pathname.startsWith("/monaco/");
  const isFontAsset = requestUrl.pathname.startsWith("/fonts/");
  const rawPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const baseDir = isMonacoAsset ? MONACO_DIR : isFontAsset ? FONT_DIR : PUBLIC_DIR;
  const pathPrefix = isMonacoAsset ? "/monaco/" : isFontAsset ? "/fonts/" : "/";
  const relativePath = isMonacoAsset || isFontAsset ? rawPath.slice(pathPrefix.length) : rawPath;
  const normalized = path.normalize(decodeURIComponent(relativePath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, normalized);

  if (!filePath.startsWith(baseDir)) {
    send(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || HOST}`);

  if (requestUrl.pathname === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    clients.add(res);
    writeSse(res, "listener", listenerSnapshot());
    writeSse(res, "forwarding", forwardingSnapshot());
    req.on("close", () => clients.delete(res));
    return;
  }

  if (requestUrl.pathname === "/health" && req.method === "GET") {
    send(res, 200, { ok: true, clients: clients.size, listener: listenerSnapshot() });
    return;
  }

  if (requestUrl.pathname === "/listener/status" && req.method === "GET") {
    send(res, 200, listenerSnapshot());
    return;
  }

  if (requestUrl.pathname === "/forwarding/config" && req.method === "GET") {
    send(res, 200, forwardingSnapshot());
    return;
  }

  if (requestUrl.pathname === "/forwarding/config" && req.method === "POST") {
    try {
      const rawBody = await collectBody(req);
      const json = safeJsonParse(rawBody);
      if (!json.validJson || !json.parsed || typeof json.parsed !== "object") {
        send(res, 400, { error: "Request body must be JSON." });
        return;
      }
      const url = normalizeForwardingUrl(json.parsed.url);
      saveForwardingConfig(url);
      forwarding.url = url;
      pushForwardingUpdate();
      send(res, 200, forwardingSnapshot());
    } catch (error) {
      send(res, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/listener/start" && req.method === "POST") {
    send(res, 200, startNgrokListener());
    return;
  }

  if (requestUrl.pathname === "/listener/stop" && req.method === "POST") {
    send(res, 200, stopNgrokListener());
    return;
  }

  if (requestUrl.pathname === "/forwarding/resend" && req.method === "POST") {
    try {
      const rawRequest = await collectBody(req);
      const { parsed: replay, validJson } = safeJsonParse(rawRequest);
      if (!validJson || !replay || typeof replay.rawBody !== "string" ||
          typeof replay.sourceUrl !== "string" || !replay.sourceUrl.startsWith("/") ||
          !replay.headers || typeof replay.headers !== "object" || Array.isArray(replay.headers)) {
        send(res, 400, { error: "A stored webhook body, path and headers are required." });
        return;
      }
      if (!forwarding.url) {
        send(res, 400, { error: "Set a forwarding URL first." });
        return;
      }
      const result = await forwardWebhook(replay);
      send(res, 200, result);
    } catch (error) {
      send(res, 400, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/webhook" || req.method === "POST") {
    if (req.method !== "POST") {
      send(res, 405, { error: "Use POST for webhook delivery." }, { allow: "POST" });
      return;
    }

    try {
      if (req.headers["x-chargebee-webhook-viewer-forwarded"]) {
        send(res, 409, { error: "Webhook relay loop detected." });
        return;
      }
      const rawBody = await collectBody(req);
      const json = safeJsonParse(rawBody);
      const event = {
        id: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        method: req.method,
        path: req.url,
        remoteAddress: req.socket.remoteAddress,
        headers: serializableHeaders(req.headers),
        chargebee: {
          eventId: json.validJson && json.parsed && typeof json.parsed === "object" ? json.parsed.id || null : null,
          type: json.validJson && json.parsed && typeof json.parsed === "object" ? json.parsed.event_type || null : null,
          occurredAt: json.validJson && json.parsed && typeof json.parsed === "object" ? json.parsed.occurred_at ?? null : null,
          apiVersion: json.validJson && json.parsed && typeof json.parsed === "object" ? json.parsed.api_version || null : null,
          source: json.validJson && json.parsed && typeof json.parsed === "object" ? json.parsed.source || null : null,
        },
        body: json.parsed,
        rawBody,
        validJson: json.validJson,
        parseError: json.parseError || null,
      };

      broadcast("webhook", event);
      send(res, 200, { received: true, id: event.id });
      setImmediate(() => {
        forwardWebhook({
          sourceUrl: req.url,
          headers: req.headers,
          rawBody,
          eventId: event.id,
        });
      });
    } catch (error) {
      send(res, 413, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  send(res, 404, { error: "Not found" });
});

loadForwardingConfig();

server.listen(PORT, HOST, () => {
  const appUrl = `http://${HOST}:${PORT}`;
  console.log(`Chargebee webhook viewer: ${appUrl}`);
  console.log(`Tunnel command: ${NGROK_LISTEN_COMMAND}`);
  openBrowser(appUrl);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const child = listener.process;
  const listenerClosed = child ? new Promise<void>((resolve) => child.once("close", resolve)) : Promise.resolve();
  stopNgrokListener();
  for (const client of clients) client.end();
  const deadline = setTimeout(() => {
    if (child && listener.process === child) child.kill("SIGKILL");
    process.exit(0);
  }, 3000);
  Promise.all([listenerClosed, new Promise<void>((resolve) => server.close(resolve))]).then(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
