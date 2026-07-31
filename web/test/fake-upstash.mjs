/**
 * Minimal stand-in for the Upstash Redis REST API — just enough of the
 * protocol for @upstash/realtime: XADD, EXPIRE, PUBLISH, XREVRANGE and the
 * SSE SUBSCRIBE endpoint.
 *
 * Exists so the realtime path can be exercised end to end without an Upstash
 * account. Results are base64-encoded for strings because the client sends
 * `Upstash-Encoding: base64`; arrays and numbers pass through untouched.
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 9999);

/** channel -> Set<ServerResponse> */
const subscribers = new Map();
/** key -> [[id, [field, value, ...]], ...] */
const streams = new Map();

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function publish(channel, payload) {
  const set = subscribers.get(channel);
  if (!set) return 0;
  // The client splits on the first two commas: `<type>,<channel>,<payload>`.
  const frame = `data: message,${channel},${payload}\n\n`;
  for (const res of set) res.write(frame);
  return set.size;
}

function runCommand(args) {
  const cmd = String(args[0]).toUpperCase();
  switch (cmd) {
    case 'XADD': {
      const [, key, id, ...fields] = args;
      const entries = streams.get(key) ?? [];
      entries.push([id, fields]);
      streams.set(key, entries);
      return b64(id);
    }
    case 'EXPIRE':
      return 1;
    case 'PUBLISH': {
      const [, channel, message] = args;
      return publish(channel, typeof message === 'string' ? message : JSON.stringify(message));
    }
    case 'XREVRANGE':
      // Empty history keeps the handler's replay path simple; the live
      // PUBLISH path is what this fake exists to exercise.
      return [];
    case 'PING':
      return b64('PONG');
    default:
      return null;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const segments = url.pathname.split('/').filter(Boolean);

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    // SUBSCRIBE arrives as POST /subscribe/<channel> with an SSE Accept header.
    if (segments[0] === 'subscribe') {
      const channel = decodeURIComponent(segments.slice(1).join('/'));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: subscribe,${channel},1\n\n`);

      if (!subscribers.has(channel)) subscribers.set(channel, new Set());
      subscribers.get(channel).add(res);
      console.log(`[fake-upstash] + subscriber on ${channel} (${subscribers.get(channel).size})`);

      // Must be `res`, not `req`: Node emits 'close' on the request as soon as
      // its body has been consumed, which for a POST is immediately — that
      // would drop every subscriber the moment it connected.
      res.on('close', () => {
        subscribers.get(channel)?.delete(res);
        console.log(`[fake-upstash] - subscriber on ${channel}`);
      });
      return;
    }

    let parsed;
    try {
      parsed = body ? JSON.parse(body) : [];
    } catch {
      res.writeHead(400).end('{"error":"bad json"}');
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    // /pipeline takes an array of command arrays.
    if (segments[0] === 'pipeline') {
      const out = parsed.map((args) => ({ result: runCommand(args) }));
      console.log(`[fake-upstash] pipeline: ${parsed.map((a) => a[0]).join(', ')}`);
      res.end(JSON.stringify(out));
      return;
    }

    // Otherwise the command may be in the path or the body.
    const args = segments.length > 0 ? [...segments.map(decodeURIComponent), ...(Array.isArray(parsed) ? parsed : [])] : parsed;
    console.log(`[fake-upstash] ${args[0]}`);
    res.end(JSON.stringify({ result: runCommand(args) }));
  });
});

server.listen(PORT, () => console.log(`[fake-upstash] listening on ${PORT}`));
