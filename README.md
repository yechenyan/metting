# Meeting Desk

Meeting Desk is a local Node and React workspace for live meeting captions in Mandarin, English and German. Each recording uses one macOS audio source. The speech pipeline works offline after the models have been installed.

## Run

Use macOS 15 or later, the Xcode Command Line Tools, Node 22.19 or newer, npm and uv. On Apple Silicon the sentence recognizer uses whisper.cpp with Metal acceleration.

```sh
npm ci
npm run setup:speech
npm run build
npm start
```

Open the loopback URL printed by the server. For development, use `npm run dev`. The speech setup command compiles and signs the native capture helper, prepares an isolated Python 3.12 environment and installs verified model downloads in the user's cache. The application listens on loopback only.

The first launch creates a date-named project with one recording. Use the plus above the project list to create a project. Expand a project to open a recording, or use the plus beside the project to add another. Each recording has its own transcript. The project form starts with German selected as the source language. New recordings inherit the project's choice of German, Mandarin or English. The top bar combines recording selection, capture controls and elapsed time. Its overflow menu contains recording creation, project settings, local files and Markdown export. Drag either divider to resize the project or chat pane. The browser remembers the widths. A focused divider also accepts the arrow keys, and a double click restores its default width.

Each recording has a three-hour limit by default. Set the duration when creating a project or change it in Project Settings, including during capture. The server counts time spent recording across starts and stops. At the limit it stops capture, saves the transcript and cancels automatic AI editing and translation. Extend the limit to continue that recording, or start another recording in the same project.

Each project sets a default translation target for new recordings. Choose any of the 100 M2M-100 translation targets or turn translation off. Simplified Chinese is the initial default. The recording toolbar can override this choice. The reader remembers whether to show source text, translations or both for each recording. Display changes are local and do not request another translation. Use the comparison button below a speaker to inspect streaming, sentence recognition and AI revisions. A merged passage links to each source utterance and its timestamp. Older recordings retain their translation preference and recognize previously stored Chinese translations.

Choose the source and languages in the top bar. In a narrow window these selectors move into recording settings. System Audio captures computer playback by default. Select a running application to limit playback to that app, or select a physical or virtual input device. A multichannel device displays a second selector with its numbered channels. Aggregate inputs show member names when macOS provides the mapping. To capture an external mix, choose the virtual input and channel carrying that mix. The recording remembers its choice. Stop capture to change it.

After stopping, use the player below the transcript to play or seek through the entire recording. The play button beside a sentence's timestamp replays its original audio and stops at the end of the sentence. A merged passage plays its source sentences in chronological order. Its comparison view also plays each source separately. Resuming appends another take to the same recording. When resuming a transcript created before audio archiving, playback becomes available for the newly captured portion.

System or application audio capture works with headphones and requires Screen & System Audio Recording access in macOS Privacy & Security. Input device capture uses the separate Microphone permission. If access is denied, use the transcript's Open Settings action, enable the app named by macOS and start listening again. If macOS asks to reopen that app, follow its prompt.

Each project contains recordings, and each recording has a default sidebar conversation. Select a caption or part of its text to ask a question in the current conversation. Both quick actions send the quotation and its timestamp. Use New conversation in the sidebar to start another topic and the adjacent selector to reopen one. The browser remembers the selected conversation for each recording. Each conversation can keep answering while another is open.

Choose a project folder at creation or in project settings. Pi runs its own agent loop with its native tools, including Bash, read, write and edit, from the working directory selected when a question was sent. Bash inherits the local service account's permissions. Without a linked folder, the project's working directory is created under the local app data directory. Changing folders applies to the next question and keeps each conversation's history.

## Local models

To prepare an offline meeting, run this command from the checkout while you have an internet connection. It downloads the speech and translation models without starting a recording. A fresh checkout uses Node and uv. An existing installation reuses its managed Python.

```sh
npm run models:download
```

| Download | Contents | Installed size |
| --- | --- | ---: |
| `npm run models:download -- speech` | Vosk for German, English and Mandarin, Whisper small Q5_1 for full sentences, pyannote and TitaNet for speaker identification | About 473 MB |
| `npm run models:download -- translation` | Meta M2M-100 418M in CTranslate2 INT8 format, shared by all translation languages | About 496 MB |

`npm run setup:speech` already installs the speech group alongside the capture helper and Python packages. The translation group also downloads on first use. Allow about 1 GB for the installed models, plus space for temporary downloads and the Python runtime. Re-run the same command after a failed download. Completed models are reused, and each new download is checked against its SHA-256 checksum before installation. [Speech model sources and checksums](modules/speech/recognition/download.py) · [Translation model revision and checksums](modules/local-translation/model.json)

The default cache is `Library/Caches/MeetingDesk` under the current macOS user's home directory. Speech assets go in `models/` and translation assets in `translation/`. To keep the cache in this checkout, run `export MEETING_DESK_CACHE=.meeting-cache` from the project root before setup, download and startup. Git ignores this directory. Set the same variable when starting the app from a new shell.

## Subscription and usage

The Pi adapter accepts an OAuth credential for the OpenAI or OpenAI Codex provider. When the installed Pi version recognizes an existing Codex subscription, models appear automatically. The connection panel can open Pi's official terminal sign-in flow.

```sh
npm run pi -- auth login openai
```

Return to the connection panel and refresh after signing in. The service selects a compatible Node executable from PATH, with an optional override via `MEETING_DESK_NODE`. API-key credentials are filtered out. Check the connected account's plan settings to control any provider-side extra credits.

Local draft translation runs during speech in a separate warm CPU process. The first preview needs five recognized words. Each subsequent preview needs five more words in the same utterance since its last translation request. Mandarin uses Chinese word segmentation. The worker translates the latest text of the utterance, coalesces faster recognition updates and shares time with complete sentences. At a sentence boundary, the complete text is eligible immediately, including short replies. The last translated text stays visible on its utterance until a new translation is ready. A label identifies a draft based on earlier wording or on the original span before a speaker split. It loads the [Meta M2M-100 418M model](https://huggingface.co/facebook/m2m100_418M) using the [gn64 CTranslate2 INT8 conversion](https://huggingface.co/gn64/M2M100_418M_CTranslate2). The first use downloads approximately 496 MB of pinned, checksum-verified files to the app cache. Every language pair shares these weights. Subsequent translation runs offline. Session settings show preparation status and allow retrying a failed download. The reader marks provisional translations until Pi returns the contextual wording. Comparing a sentence shows both versions. Source recognition currently supports German, English and Mandarin.

Two independent Pi subprocesses handle recording edits, starting a fresh in-memory session per batch. A free worker immediately takes up to three consecutive pending sentences with a window of up to twelve final utterances. A worker owns its editable sentence IDs until it finishes. A later batch may request a focused follow-up for a correction or merge across a batch boundary. Workers validate source versions, speakers, target language and boundaries before committing results. Each reading turn retains its source IDs. The transcript version selector switches between the edited reading order and the original audio timeline. The service checks revision numbers, speaker attribution and complete coverage before storing a proposed reading order. Older completed meetings can be processed using the organize action in session settings. The same action retries editing after a quota error.

The reader footer tracks transcription revision tokens. The sidebar counts the active conversation's tokens, including model calls made during tool use. Each question adds the difference between Pi's usage counters at the beginning and end of its turn. The reader and sidebar can run concurrently on the configured subscription.

Each sidebar conversation resumes its own native Pi session. Each question carries up to 9,000 characters of recording context, including timestamps, speakers, original recognizer text, the selected quotation and serialization overhead. The quotation takes priority. When someone selects an edited or translated subtitle, its source utterances supply the original words. The first question includes the newest whole utterances that fit, in chronological order. Follow-ups send newly recognized speech and corrections since the last successful answer in that conversation. This checkpoint survives restarts. When an older recording has only a chat journal, its first native turn also includes recent questions and answers.

Each answer shows a compact activity log. Expand a tool call to see its arguments, a bounded output preview and any native codemode subcalls. Thinking steps show their status and elapsed time. A provider's explicitly public reasoning summary appears when available. Text and changed steps are batched on the chat event stream, and reconnecting restores the current reply. For older answers, opening the activity log recovers matching steps from the local Pi session.

## Modules

| Directory | Responsibility |
| --- | --- |
| `apps/server` | Loopback HTTP service, WebSocket connections and composition |
| `apps/web` | React application shell, shared UI, styles and localized resources |
| `modules/projects` | Project list, defaults, folder selection and local registry |
| `modules/meetings` | Session lifecycle, live controls and speech-worker ownership |
| `modules/speech` | ScreenCaptureKit playback capture, Core Audio input selection, Vosk streaming, whisper.cpp final decoding and acoustic speaker segmentation |
| `modules/local-translation` | On-demand model installation, M2M-100 inference and provisional subtitles |
| `modules/audio` | Local recording archive, time-range indexing, seekable audio delivery and playback controls |
| `modules/transcripts` | Versioned utterances, speaker names, event journal, reconnect replay, virtualized reader and Markdown export |
| `modules/ai-editing` | Bounded parallel revision batches, context selection and revision validation |
| `modules/chat` | Per-recording questions, bounded context, conversation journal, reply streaming and chat UI |
| `modules/agent-runtime` | Harness interface, Pi subscription discovery, RPC and token accounting |

The native helper sends the selected signal directly to one streaming decoder as short, timestamped 16 kHz PCM packets. The UI connection preloads the local models. The server selects the source when capture starts, so choosing another input reuses the warm models. The same audio goes to sentence recognition and acoustic speaker segmentation in a separate process. Acoustic segmentation uses pyannote via sherpa-onnx and TitaNet embeddings matched against this recording's voices. Sequential speakers can receive separate timed segments. Detected overlaps are marked for review. Names can be assigned to a speaker throughout the recording.

The React reader subscribes by segment ID and virtualizes older rows. Audio meters, token updates and duration use separate subscriptions. Frequent partial hypotheses are coalesced for disk while finalized text and revisions enter the journal immediately.

## Files

The registry is stored in the operating user's Application Support directory under `MeetingDesk`. Each new recording is stored under `MeetingDesk/<project-id>/meetings/<meeting-id>` in the folder linked at creation, or in the app's data directory when no folder is linked. Existing recordings keep their storage location when the project folder changes, including during capture or a streaming reply. Each session has the following files.

- `transcript.jsonl` holds append-only caption events, versioned edits, speaker names, state and token usage. Reopening a meeting replays complete records and recovers interrupted drafts.
- `transcript.md` follows the reading order and includes timestamped source quotations for merged turns. It is generated on stop and export, and refreshed when outstanding AI edits finish.
- `audio/*.wav` holds the selected source, including silence, as 16 kHz mono 16-bit PCM. The capture worker writes the files in the background. Playback streams the saved takes in order and skips the time between stops and starts. Open the recording's local files from the menu to access the WAV files.
- `voices.json` holds acoustic speaker profiles for resuming that meeting.
- `chat.jsonl` stores the default conversation's questions, quotations, answers, per-turn token counts and recording checkpoints. `pi-session.jsonl` holds its native Pi session, including tool results. Additional conversations have their own files under `chats/<conversation-id>/`. The small `chats.json` index lists the recording's conversations. A service restart marks interrupted replies in the display history and resumes the native conversation on the next question.

Use `MEETING_DESK_DATA`, `MEETING_DESK_CACHE` or `MEETING_DESK_PORT` to override local locations or the listening port. `MEETING_DESK_CAPTURE` can select a compatible native helper for device integration or recorded-audio validation.

## Checks

```sh
npm test
npm run build
```

Tests cover project and session isolation, interrupted journal recovery, write retries, editable context boundaries and provider token aggregation. Speech and UI performance should be measured on the target device, from the onset of audible speech to the first painted caption.
