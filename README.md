# Token Compressor

A Manifest V3 Chrome extension that compresses your prompts client-side before
they're sent to ChatGPT, Claude, or GitHub/Copilot Chat — cutting token usage
without a server round-trip. Implements the 7-stage pipeline: **capture →
classify → tokenize → compress → inject → send → account**, plus an optional
local RAG memory layer over your own conversation history, built on
**LangChain's `Embeddings` / `VectorStore` interfaces** instead of a
hand-rolled TF-IDF index.

Everything runs in your browser. No network calls, no telemetry, no backend
— by default. See "Upgrading Stage 7" below if you want to swap in a real
embedding model, which may add network calls depending on which one.

---

## How it works

```
keydown/click (capture)
        │
        ▼
┌─────────────────┐   preventDefault + snapshot original text
│  Stage 1 Capture │   (src/content/content-script.js)
└─────────────────┘
        │
        ▼
┌─────────────────┐   chat / code / mixed, via char-ratio + keyword heuristics
│ Stage 2 Classify │   (src/content/lib-core.js :: classify)
└─────────────────┘
        │
        ▼
┌─────────────────┐   chat  → log-frequency self-information pruning proxy
│ Stage 3 Compress │   code  → structure-aware line elision (signatures kept)
└─────────────────┘   mixed → both, segment by segment
        │
        ▼
┌─────────────────┐   native setter (inputs) / execCommand (contenteditable)
│ Stage 4 Inject   │   + synthetic events so React/ProseMirror observe the edit
└─────────────────┘
        │
        ▼
┌─────────────────┐   click the site's send button, or dispatch Enter
│ Stage 4b Send    │
└─────────────────┘
        │
        ▼
┌─────────────────┐   token delta persisted via background service worker;
│ Stage 5 Account  │   HUD shows exactly what was sent (see Transparency model)
└─────────────────┘
        │
        ▼
┌─────────────────┐   every stage wrapped in a 500ms watchdog; any error or
│ Stage 6 Fallback │   timeout sends the untouched original instead
└─────────────────┘

┌─────────────────┐   optional: LangChain MemoryVectorStore over your own
│ Stage 7 RAG      │   messages, persisted to IndexedDB, queryable for "was
└─────────────────┘   this discussed before" — off by default
```

## Why LangChain for Stage 7

The original design used a hand-rolled TF-IDF vectorizer and cosine
similarity function. That works, but it's a dead end: swapping in a real
embedding model meant rewriting the vectorizer, the storage format, and the
similarity search all at once.

This version routes Stage 7 through two LangChain abstractions instead:

- **`Embeddings`** (`src/background/embeddings.js`) — anything that turns
  text into vectors. The default, `LocalHashingEmbeddings`, is a
  zero-dependency feature-hashed bag-of-words model that keeps the
  "zero network calls" guarantee. It is a drop-in for any other LangChain
  `Embeddings` implementation.
- **`VectorStore`** (`src/background/historyStore.js`) — LangChain's
  `MemoryVectorStore`, fed whichever `Embeddings` instance is active,
  mirrored into IndexedDB so it survives MV3 service worker restarts.
  As of LangChain v1, `MemoryVectorStore` lives in the maintenance-mode
  `@langchain/classic` package rather than the core `langchain` package,
  which is why `package.json` depends on `@langchain/classic` +
  `@langchain/core` rather than the top-level `langchain` package.

`historyStore.js` never does vector math itself. It calls
`store.addDocuments(...)` and `store.similaritySearchWithScore(...)` —
that's it. Upgrading the embedding model (or the vector store) is a
one-line config change, not a rewrite. See "Upgrading Stage 7" below.

## Project structure

```
token-compressor/
├── manifest.json                 MV3 manifest
├── build.mjs                     esbuild bundler for the service worker
├── icons/                        16/48/128 px extension icons
├── src/
│   ├── content/
│   │   ├── lib-core.js           Pure logic: tokenizer, classifier, compressors
│   │   ├── content-script.js     DOM glue: capture, inject, send, HUD, watchdog
│   │   └── hud.css               Loaded into the HUD's shadow root at runtime
│   ├── background/
│   │   ├── service-worker.js     Message router (esbuild entry point)
│   │   ├── statsStore.js         chrome.storage.local savings ledger
│   │   ├── historyStore.js       LangChain MemoryVectorStore + IndexedDB (Stage 7)
│   │   └── embeddings.js         Pluggable LangChain Embeddings provider
│   ├── popup/                    Toolbar popup: live stats, quick toggles
│   └── options/                  Full settings page
├── dist/
│   └── service-worker.bundle.js  Generated by `npm run build` — not in a fresh checkout
├── scripts/
│   └── pack.mjs                  Zips the built extension for the Web Store
├── tests/
│   └── compression.test.mjs      Node unit tests for lib-core.js (no deps)
├── package.json
└── README.md
```

`lib-core.js` has **zero** DOM, `chrome.*`, or npm dependencies — it's
loaded both as a classic script in the browser (exposed as `self.TCCore`)
and required directly by the Node test suite, so the exact code that runs
in your browser is the code under test.

`service-worker.js` (and everything it imports — `historyStore.js`,
`embeddings.js`, `statsStore.js`) is written as an ES module and depends on
`langchain`/`@langchain/core`. Since MV3 service workers can't resolve bare
npm specifiers at runtime, it's bundled by esbuild into
`dist/service-worker.bundle.js`, which is what `manifest.json` actually
loads. **Edit the source files under `src/background/`, never the bundle.**

---

## Install (load unpacked)

```bash
npm install
npm run build     # bundles src/background/service-worker.js -> dist/
```

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `token-compressor/` folder.
4. Pin the extension, open ChatGPT / Claude / Copilot Chat, and type a
   longer message — a HUD will appear bottom-right after you send it,
   showing tokens saved.

Supported sites out of the box: `chatgpt.com`, `chat.openai.com`,
`claude.ai`, `github.com` (Copilot Chat), `copilot.microsoft.com`.

If you change anything under `src/background/`, re-run `npm run build`
(or `npm run watch` while developing) and click the refresh icon on
`chrome://extensions` for this extension.

## Run the tests

```bash
npm test
```

Runs 19 unit tests against the compression core using Node's built-in test
runner. `lib-core.js` has no dependencies, so this needs no `npm install`.

## Package for the Chrome Web Store

```bash
npm run zip
```

Builds, then writes `token-compressor-packed.zip` containing exactly the
runtime files (manifest, icons, src/, the built service worker) — no
`node_modules`, no tests, no dev tooling.

---

## Transparency model

This extension changes what you type before it's transmitted. That's the
entire point, but it means you should always be able to see exactly what was
sent. **Settings → Transparency model** gives you three choices:

| Mode | Input box after send | HUD |
|---|---|---|
| **Show what was sent** *(default)* | Shows the compressed text that was actually transmitted | Full diff + one-click "resend original" |
| **Restore my original text** | Shows what you originally typed, even though the compressed version is what the AI received | Still discloses the diff |
| **Disabled** | No compression | — |

The extension never silently discards the disclosure step — the HUD fires on
every compressed send regardless of mode.

---

## Configuration

Open the options page (right-click the toolbar icon → Options, or the
"Settings" button in the popup):

- **Compression aggressiveness** — target fraction of low-information words
  removed from chat prose (10–70%). Code compression is structural, not
  ratio-driven, and always preserves signatures, imports, TODO/FIXME
  comments, and the last ~15% of the file.
- **Minimum tokens before compressing** — short messages pass through
  untouched; compression overhead isn't worth it below this size.
- **Per-site toggles** — disable on any individual site without disabling
  the extension globally.
- **Conversation memory (RAG)** — off by default. When enabled, your
  messages are embedded (via the active LangChain `Embeddings` provider)
  and stored in IndexedDB, on-device only, so you can build a local
  searchable memory of your own chats.
- **Embeddings provider** — which `Embeddings` implementation Stage 7 uses.
  Ships with `local-hashing` (default, zero network/downloads); the
  `transformers` and `openai` options are wired into the settings UI but
  ship disabled until you install their packages (see below).

---

## Known limitations & maintenance notes

- **Site selectors will break.** ChatGPT, Claude, and Copilot all ship
  frontend updates that change DOM structure/class names regularly. The
  adapters in `content-script.js` (`SITE_ADAPTERS`) use `#id` and
  `data-testid` selectors chosen for relative stability, but if the
  extension stops intercepting on a given site, that's the first place to
  check — open devtools, find the new input/send-button selectors, and
  update the adapter.
- **The tokenizer is an approximation**, not byte-exact BPE. It's tuned to
  track cl100k-style token counts closely enough for accounting and
  informativeness scoring, but don't treat the displayed counts as exact
  API billing numbers. See "Upgrading the tokenizer" below to swap in a
  real tokenizer.
- **Compression is lossy by design.** Aggressive settings on short or
  already-dense prompts can remove content you actually wanted the model to
  see. Start around 20–30% and raise it once you trust the output quality
  on your own prompts.
- **The RAG memory layer (Stage 7) indexes and retrieves locally** — it
  does not currently auto-inject retrieved context into a new conversation
  turn, since that requires reverse-engineering each site's hidden
  conversation-state format. It ships as a queryable local memory
  (`TC_QUERY_RELEVANT` message) that you can build UI on top of.
- Automating a third-party site's UI can be against that site's terms of
  service depending on how you use it. This tool only acts on your own
  outgoing messages in your own browser session — review the terms of any
  site you use it with.

---

## Upgrading the tokenizer

Swap `approxTokenize()`/`tokenCount()` in `src/content/lib-core.js` for a
real BPE tokenizer:

```bash
npm install @dqbd/tiktoken   # WASM tiktoken port
```

```js
import { get_encoding } from "@dqbd/tiktoken";
const enc = get_encoding("cl100k_base");
function tokenCount(text) { return enc.encode(text).length; }
```

Since `lib-core.js` is loaded as a classic (non-module) script in the
content-script context, bundle it too once it has an npm dependency (e.g.
add a second esbuild entry point in `build.mjs` for it, or run it through
`esbuild src/content/lib-core.js --bundle --outfile=dist/lib-core.bundle.js`
and update `manifest.json`'s `content_scripts.js` to point at the bundle).

## Upgrading Stage 3 to a real self-information model

The shipped chat compressor uses a log-frequency proxy (common words = low
information = pruned first) specifically so the extension works with zero
downloads. To use a real perplexity-based scorer (what LLMLingua-2 does):

1. Add `onnxruntime-web` and a quantized small language model ONNX export.
2. Load the model once in the background service worker.
3. Replace `wordScore()` in `compressChat()` (`src/content/lib-core.js`)
   with a call into the model for per-token self-information.

## Upgrading Stage 7 to a real embedding model

Everything you need is already wired through `src/background/embeddings.js`
— `historyStore.js` only ever talks to the LangChain `Embeddings`
interface, so this is a config change, not a rewrite:

**Local, still zero network (after first model load):**

```bash
npm install @langchain/community
```

```js
// src/background/embeddings.js
case "transformers": {
  const { HuggingFaceTransformersEmbeddings } = await import(
    "@langchain/community/embeddings/hf_transformers"
  );
  return new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2",
  });
}
```

**Hosted, requires network + an API key:**

```bash
npm install @langchain/openai
```

```js
// src/background/embeddings.js
case "openai": {
  const { OpenAIEmbeddings } = await import("@langchain/openai");
  return new OpenAIEmbeddings({
    apiKey: settings.openaiApiKey,
    modelName: "text-embedding-3-small",
  });
}
```

Then remove the corresponding `disabled` attribute on that `<option>` in
`src/options/options.html`, run `npm run build`, and reload the extension.
`MemoryVectorStore`'s `similaritySearchWithScore` works unchanged over
dense vectors of any dimensionality — nothing in `historyStore.js` needs to
change.

You can also swap `MemoryVectorStore` itself for any other LangChain
`VectorStore` (e.g. a persistent on-disk/IndexedDB-backed HNSW index) the
same way — `indexMessage()`/`queryRelevant()` only call the standard
`addDocuments` / `similaritySearchWithScore` methods.

## License

MIT — see `LICENSE`.
