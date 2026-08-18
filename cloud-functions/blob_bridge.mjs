import { getStore } from "@edgeone/pages-blob";

const request = JSON.parse(await readStdin());
const store = getStore(request.store);
let result = null;

switch (request.operation) {
  case "get":
    result = await store.get(request.key, { type: request.type ?? "text", consistency: "strong" });
    break;
  case "setJSON":
    await store.setJSON(request.key, request.value);
    break;
  case "list":
    result = await store.list({ prefix: request.prefix ?? "", consistency: "strong" });
    break;
  case "delete":
    await store.delete(request.key);
    break;
  default:
    throw new Error(`Unsupported blob operation: ${request.operation}`);
}

process.stdout.write(JSON.stringify({ ok: true, result }));

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
