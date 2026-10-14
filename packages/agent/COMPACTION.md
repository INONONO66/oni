# Compaction boundary

A `Message.WithParts` is the atomic history entry. Tool calls and their result states share that entry, so a cut cannot split a call/result pair. The LLM adapter projects unfinished tool parts as interrupted results. Without a summary anchor, a kept window must begin with a user message.

The summarizer receives the unchanged original leading prefix when its estimate, the prior anchor, and the output reserve fit the context window (#1476 item 3). Otherwise it receives the bounded input: no user messages or anchor renders, completed tool outputs elided, and the oldest messages dropped to half the window. User messages are preserved verbatim within the configured character budget regardless of what the summarizer saw. A prior anchor's raw body is always passed as merge state. In the unchanged prefix its render also appears as content; removing either one would break prefix identity or the incremental merge. Empty merge input carries the previous anchor forward without invoking the summarizer.

A warm candidate may replace a synchronous merge only while its prefix IDs, content fingerprint, kept boundary, and prior anchor identity match. Failed or stale candidates fall back to the normal cut. Elision postpones that cut only when its estimated reclaim covers the measured overage; the next provider measurement remains authoritative.
