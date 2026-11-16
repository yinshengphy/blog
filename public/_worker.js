const KV_KEY = "mario-visits";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/mario-game/visit") {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Allow": "GET, POST, OPTIONS",
          "Cache-Control": "no-store"
        }
      });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    if (!env.MARIO_KV) {
      return jsonResponse({ error: "Counter storage unavailable" }, 503);
    }

    let visits = 0;
    try {
      const raw = await env.MARIO_KV.get(KV_KEY);
      const parsed = Number.parseInt(raw ?? "0", 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        visits = parsed;
      }
    } catch {
      return jsonResponse({ error: "Counter read failed" }, 503);
    }

    if (request.method === "POST") {
      const nextVisits = visits + 1;
      try {
        await env.MARIO_KV.put(KV_KEY, String(nextVisits));
        visits = nextVisits;
      } catch {
        // Keep current read value if KV hits 1 write/s burst or daily free write limit.
      }
    }

    return jsonResponse({ visits });
  }
};
