# VaultPilot OS

VaultPilot OS is a local-first autonomous Gemini assistant for Obsidian desktop and mobile. It runs inside the user's vault, calls Google directly with the user's own Gemini API key, stores vector data in IndexedDB, and exposes controlled vault, web-search, writing, editing, memory, and archive workflows.

There is no VaultPilot subscription, hosted proxy, or middle-man service.

## Highlights

- Dual native views: compact desktop right-sidebar chat and a full workspace Command Center
- Responsive Command Center with Today, Chat, Search, and Memory workspaces
- Vault-derived priority tasks, active project progress, recent notes, and daily briefing cards
- Mobile-safe Gemini networking through Obsidian's native request bridge, using buffered JSON responses on iOS and Android instead of SSE
- Touch-sized controls, safe-area padding, virtual-keyboard-aware composing, camera/photo selection, and optional dictation
- Desktop/mobile image picker with previews, paste support, and Gemini multimodal analysis
- Native Gemini function-calling agent loop with configurable step limit
- Per-category read, network, write, and sync policies with previews, an activity log, and guarded undo
- Hard-coded `.obsidian` forbidden zone beneath every model-accessible file tool
- Vault search, note read/create/edit, and free DuckDuckGo HTML web search tools
- IndexedDB vector storage with incremental, batched startup and file-event indexing
- Cached hybrid semantic, lexical, and first-degree graph/backlink relevance with ranking explanations
- Structured, user-manageable `memory/` entries with proactive background extraction and pre-query retrieval
- Optional productivity adapters for Tasks, Homepage, Bases, Daily Notes, Adaptive Practice, Remotely Save, Canvas, and Smart semantic views
- Accessible quick actions, screen-reader status, high contrast, reduced motion, interface scaling, and optional read-aloud
- Adjustable recent-conversation context buffer, defaulting to five sessions
- Strict `Topic@YYYY-MM-DD_HH-mm.md` conversation archives
- User-defined Command Palette prompts with current-note and selection placeholders
- Input/output token counts and editable approximate model pricing

## Install

### From the install-ready package

1. Extract the `vaultpilot-os` folder into the vault's `.obsidian/plugins/` directory.
2. In Obsidian, open **Settings → Community plugins** and enable **VaultPilot OS**.
3. Open **Settings → VaultPilot OS**, paste a Gemini API key, and select **Test connection**.
4. Open VaultPilot OS from the robot ribbon icon or the Command Palette.

The install-ready folder contains `manifest.json`, `main.js`, and `styles.css`.

VaultPilot 1.5.0 requires Obsidian 1.11.4 or newer so Gemini credentials can use Obsidian SecretStorage and the current Bases API.

### Desktop views

- Select the VaultPilot dashboard icon in Obsidian's left ribbon to open the full Command Center as a workspace tab.
- Run **VaultPilot OS: Open compact chat** from the Command Palette to open or reveal the lightweight right-sidebar chat.
- Both views share the same active conversation, memory, attachments, usage totals, tool approvals, and settings.

### Obsidian mobile

The same package supports iOS and Android; there is no separate reduced feature set.

1. Put the `vaultpilot-os` folder in the vault's `.obsidian/plugins/` directory, or let your vault-sync method copy the already installed desktop plugin folder to the mobile device.
2. In Obsidian mobile, open **Settings > Community plugins** and enable **VaultPilot OS**.
3. Open **Settings > VaultPilot OS**, add the Gemini key on that device if it was not synced, and use **Test connection**.
4. Select the VaultPilot dashboard ribbon action for the advanced Command Center, or run **VaultPilot OS: Open compact chat** for the lightweight chat layout.

Because Obsidian mobile has no persistent right sidebar, compact chat and the Command Center both open as full-screen workspace tabs while retaining their distinct layouts. On-screen Enter inserts a newline; tap **Send** to submit. A connected hardware keyboard can submit with Ctrl+Enter or Cmd+Enter. The image button opens the native iOS/Android photo or camera chooser. Session cost remains in the chat header because Obsidian mobile has no bottom status bar. Mobile indexing can be disabled independently to save battery while retaining the existing local index. Mobile chat uses Gemini's non-streaming JSON endpoint to avoid empty responses caused by buffered SSE handling in mobile WebViews.

### Build from source

Requirements: a current Node.js LTS release and npm.

```shell
npm install
npm run build
npm test
```

For development, run `npm run dev` and copy or link `manifest.json`, `main.js`, and `styles.css` into a test vault's plugin folder.

## API key and privacy model

VaultPilot treats keys as opaque strings and sends both legacy standard keys and new `AQ.` authorization keys unchanged in the `x-goog-api-key` request header. Users select or create the credential through Obsidian SecretStorage; VaultPilot stores only the secret identifier in its plugin data. Existing plaintext VaultPilot settings are migrated automatically and cleared on the first 1.1.0 startup. The key is never printed by VaultPilot.

Vault notes selected for chat context, memory processing, or embedding generation, plus images explicitly attached to chat, are sent directly from Obsidian to Google's Gemini API. Embedding vectors, source chunks, and active-chat image bytes are stored locally in the browser profile's IndexedDB rather than as JSON files in the vault. DuckDuckGo queries and returned public pages pass directly between Obsidian and DuckDuckGo.

Google recommends server-side secret storage for conventional browser applications. VaultPilot deliberately has no server because its operating model is a user-installed local Obsidian plugin using a user-owned key. All Gemini traffic uses Obsidian's native `requestUrl` bridge on desktop and mobile. Users should still restrict the key to Gemini, monitor quotas, and rotate it if a device is compromised.

## Disclosures

- **Account requirement:** A user-owned Google Gemini API key is required. VaultPilot has no account system, subscription, payment, advertising, or affiliate program.
- **Network use:** Prompts, explicitly attached images, selected note context, memory-extraction inputs, and embedding chunks are sent directly to Google Gemini when their corresponding features run. Web-search queries are sent directly to DuckDuckGo. No VaultPilot-operated server exists.
- **Vault access:** The plugin can read and change Markdown notes through user-requested or automatically approved tools. Model-accessible paths are limited to the current vault, and `.obsidian` is permanently forbidden to those tools.
- **Telemetry:** VaultPilot contains no analytics, crash reporting, tracking pixels, or client-side telemetry.
- **Source:** The complete plugin source is available under the MIT License.

## Security boundary

The model cannot use VaultPilot tools to read, search, create, or edit `.obsidian` or any descendant. The guard:

- converts Windows separators before validation;
- rejects traversal segments, absolute paths, drive paths, URLs, and null bytes;
- performs a case-insensitive root-segment check for `.obsidian`;
- restricts model file operations to Markdown notes; and
- remains active in automatic mode and cannot be changed by prompts or settings.

The plugin itself necessarily uses Obsidian's normal settings store, which Obsidian places in the plugin's own data area. That internal lifecycle operation is not exposed to the model or tool registry.

## Image attachments

The chat composer accepts PNG, JPEG, WebP, HEIC, and HEIF images. Defaults allow four images per message, 6 MB per image, and 12 MB of raw image data per Gemini request; all three limits are configurable. The 12 MB default leaves room for base64 expansion, text, system instructions, and conversation context beneath Gemini's inline request limit.

Active-chat images are stored in a vault-scoped IndexedDB database and are not written into plugin `data.json`. Recent images can be reused as multimodal conversation context within the configured request budget. Removing archived sessions deletes their IndexedDB copies after writing the images to `conversations/_attachments/<session-id>/` and embedding them in the Markdown archive.

## Search behavior

Startup indexing compares Obsidian file modification time and size against IndexedDB metadata and embeds only changed Markdown notes. Live file events are debounced. Each query combines:

1. cosine similarity from Gemini Embedding 2;
2. lexical term and exact-phrase relevance; and
3. a structural boost for outgoing links and backlinks one edge away from the strongest semantic results.

Embedding chunks are batched, compact vectors and recent queries are cached, scoring yields to the interface, and graph adjacency is reused. Search does not reread every Markdown note on every query. Weights, dimensions, batch size, cache size, chunking, and mobile indexing are adjustable. If semantic query embedding is unavailable, search falls back to indexed lexical retrieval.

## Memory behavior

Memory is kept separately from conversation archives in:

- `memory/user_profile.md`
- `memory/core_facts.md`
- `memory/project_contexts.md`
- `memory/preferences.md`

A lightweight configurable Gemini model examines the newest interaction. Background mode keeps the main response responsive; blocking mode remains available. Only durable facts above the confidence threshold are upserted with source, confidence, creation date, and update date. Credential-like values and explicitly sensitive categories are rejected. Relevant individual entries—not whole memory files—are retrieved into a hidden context block. Settings include a memory manager for inspecting and forgetting entries.

## Productivity integrations

Every companion integration is optional, detected at runtime, and safe when the companion plugin is missing. VaultPilot never imports another plugin's bundle or reads its `.obsidian` data files.

- **Tasks:** search open/completed/overdue tasks, create and update tasks, and toggle completion through Tasks `apiV1` with a Markdown fallback.
- **Homepage:** refresh a daily command-center note and open the configured homepage.
- **Bases:** register an accessible **VaultPilot Priority** view.
- **Daily Notes:** open today and append generated briefings.
- **Adaptive Practice:** launch only allowlisted dashboard, daily, resume, current-note, and plan commands.
- **Remotely Save:** disabled by default; dry-run and sync actions always require confirmation and never read credentials.
- **Canvas:** create new project or study maps without overwriting an existing canvas.
- **Smart Connections / Smart Lookup:** experimental navigation only until those plugins expose a stable public retrieval API. VaultPilot does not access their private indexes.

## Custom Command Palette prompts

Custom command templates support:

- `{{currentNote}}` — full active-note Markdown
- `{{currentNotePath}}` — active vault-relative path
- `{{selection}}` — current editor selection

New commands register immediately. Because Obsidian has no public command-unregister API, renamed or removed entries fully refresh after the plugin reloads.

## Operational notes

- The built-in web search relies on DuckDuckGo's public HTML result layout. It is free but can be rate-limited or changed by DuckDuckGo.
- Cost is approximate. Default prices match Gemini 3.5 Flash standard text pricing at the time of this release; edit the input/output price fields when the selected model or Google pricing changes.
- Rebuilding the search index deletes only this vault's VaultPilot IndexedDB objects. It does not delete vault files.
- A file write tool never overwrites an existing note. Existing notes require the explicit editor tool, which supports exact replacement, append, prepend, and complete rewrite.

## Project structure

```text
src/
  main.ts                 Plugin lifecycle, commands, and service composition
  security/pathGuard.ts   Permanent AI filesystem boundary
  services/               Gemini, agent, tools, memory, index, search, archive
  storage/                IndexedDB vectors, images, and short-term chat sessions
  ui/                     Chat ItemView and settings dashboard
  utils/                  Chunking, scoring, naming, vault helpers
tests/                    Security, retrieval, naming, and auth-key tests
```

## License

MIT
