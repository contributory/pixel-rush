# Cloud Functions — Pixel Rush relay

Relay WebSocket (Python/Sanic) cho chế độ co-op của Pixel Rush.

## Blob Storage

Trạng thái phòng được lưu vào **EdgeOne Pages Blob**. SDK Blob chỉ hỗ trợ
JavaScript, nên relay Python **không** gọi Node qua subprocess nữa (cách đó
không hoạt động trên môi trường deploy). Thay vào đó:

1. **Edge Function** tại `edge-functions/api/blob.js` — function JavaScript
   duy nhất tương tác với Blob qua `@edgeone/pages-blob`, expose HTTP API:
   - `GET /api/blob?op=get&key=...&type=json`
   - `GET /api/blob?op=list&prefix=rooms/`
   - `POST /api/blob` body `{ "op": "setJSON", "key", "value" }`
   - `DELETE /api/blob?op=delete&key=...`

2. **`blob_store.py`** — client HTTP async (httpx) gọi Edge Function trên,
   thay cho `subprocess.run(["node", "blob_bridge.mjs"])`.

### Deploy

- Deploy Edge Function `edge-functions/api/blob.js` cùng project EdgeOne Makers
  (thư mục `/edge-functions` theo tài liệu EdgeOne).
- Set biến môi trường `BLOB_API_URL` cho relay Python, trỏ tới base URL của
  project đã deploy, ví dụ `https://<project>.pages.dev`.
- Tuỳ chọn: `BLOB_STORE_NAME` (mặc định `pixel-rush-rooms`).

### API contract

Mọi response đều dùng envelope:

```json
{ "ok": true, "result": ... }
{ "ok": false, "error": "..." }
```