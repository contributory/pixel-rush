/**
 * Tải nhạc nền "Pixel Rush" về thư mục public/music/ để game dùng file nội bộ
 * thay vì hot-link. Chạy một lần:
 *
 *     node scripts/fetch-music.mjs
 *
 * (Hoặc bằng Deno:  deno run --allow-net --allow-write scripts/fetch-music.mjs)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL_MUSIC =
  "https://s3.us-east-005.backblazeb2.com/bosuutap/music/Pixel%20Rush.mp3?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=0055373d2f421cb0000000004%2F20260816%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260816T113422Z&X-Amz-Expires=604800&X-Amz-Signature=0b7be1365c7f154e23a8eefd444c6bda99d173d740908e293dd0af131aefc4b7&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "music", "pixel-rush.mp3");

console.log("Đang tải Pixel Rush.mp3 ...");
const res = await fetch(URL_MUSIC);
if (!res.ok) throw new Error(`Tải thất bại: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 100_000) throw new Error(`File quá nhỏ (${buf.length} byte) — có thể link đã hết hạn.`);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
console.log(`OK — đã lưu ${(buf.length / 1024 / 1024).toFixed(2)} MB vào public/music/pixel-rush.mp3`);
