/**
 * Optional helper: re-download Pixel Rush BGM into public/music/.
 * The track is normally committed at public/music/pixel-rush.mp3 so the
 * game does not depend on external signed URLs.
 *
 *     node scripts/fetch-music.mjs <source-url>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL_MUSIC = process.argv[2];
if (!URL_MUSIC) {
  console.error("Usage: node scripts/fetch-music.mjs <https://.../Pixel%20Rush.mp3>");
  console.error("The game already ships public/music/pixel-rush.mp3 — only run this to refresh it.");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "music", "pixel-rush.mp3");

console.log("Downloading BGM ...");
const res = await fetch(URL_MUSIC);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 100_000) throw new Error(`File too small (${buf.length} bytes)`);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
console.log(`OK — saved ${(buf.length / 1024 / 1024).toFixed(2)} MB → public/music/pixel-rush.mp3`);
