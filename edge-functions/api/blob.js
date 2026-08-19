/**
 * EdgeOne Edge Function — Blob API
 * ---------------------------------
 * HTTP bridge to EdgeOne Pages Blob, thay thế `blob_bridge.mjs` (subprocess
 * Node từ Python không hoạt động trên môi trường deploy).
 *
 * Edge Functions chỉ hỗ trợ JavaScript, nên function này là nơi duy nhất
 * gọi Blob SDK. Deploy trong thư mục /edge-functions, sau đó trỏ relay Python
 * tới nó qua biến môi trường BLOB_API_URL.
 *
 * Routing (từ /edge-functions/api/blob.js):
 *   GET    /api/blob?op=get&key=<key>&type=<json|text>
 *   GET    /api/blob?op=list&prefix=<prefix>
 *   POST   /api/blob      body { "op": "setJSON"|"set", "key", "value" }
 *   DELETE /api/blob?op=delete&key=<key>
 *
 * Mọi response dùng envelope { ok: true, result } / { ok: false, error }.
 */
import { getStore } from "@edgeone/pages-blob";

const DEFAULT_STORE = "pixel-rush-rooms";
const CONSISTENCY = "strong";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const store = getStore(url.searchParams.get("store") ?? DEFAULT_STORE);

  if (request.method === "OPTIONS") return json({ ok: true });

  try {
    // ── Read: GET /api/blob?op=get&key=...&type=... ──────────────
    if (request.method === "GET" && (url.searchParams.get("op") ?? "get") === "get") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "Missing ?key=" }, 400);
      const type = url.searchParams.get("type") ?? "text";
      const result = await store.get(key, { type, consistency: CONSISTENCY });
      return json({ ok: true, result });
    }

    // ── List: GET /api/blob?op=list&prefix=... ───────────────────
    if (request.method === "GET" && url.searchParams.get("op") === "list") {
      const result = await store.list({
        prefix: url.searchParams.get("prefix") ?? "",
        consistency: CONSISTENCY,
      });
      return json({ ok: true, result });
    }

    // ── Write: POST /api/blob { op: "setJSON"|"set", key, value } ─
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
      }
      const { op, key, value } = body;
      if (!key) return json({ ok: false, error: "Missing key in body" }, 400);
      if (op === "setJSON") {
        await store.setJSON(key, value);
      } else if (op === "set") {
        if (typeof value !== "string")
          return json({ ok: false, error: "op=set requires a string value" }, 400);
        await store.set(key, value);
      } else {
        return json({ ok: false, error: `Unsupported op: ${op}` }, 400);
      }
      return json({ ok: true });
    }

    // ── Delete: DELETE /api/blob?op=delete&key=... ────────────────
    if (request.method === "DELETE") {
      const key = url.searchParams.get("key");
      if (!key) return json({ ok: false, error: "Missing ?key=" }, 400);
      await store.delete(key);
      return json({ ok: true });
    }

    return json({ ok: false, error: `Unsupported request: ${request.method}` }, 405);
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
}
