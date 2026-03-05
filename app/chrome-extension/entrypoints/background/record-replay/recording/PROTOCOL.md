# Recorder Event Protocol

This document describes the runtime contract between:

- content-side recorder (`inject-scripts/recorder.js`)
- background ingest handler (`recording/content-message-handler.ts`)

## Envelope

Recorder messages are sent with:

```ts
{
  type: "rr_recorder_event",
  payload: { kind: "steps" | "variables" | "batch", ... },
  meta: {
    version: 1,
    sessionId: string,
    eventId: string,
    seq: number,
    sentAt?: number,
    source?: { href?: string, isTop?: boolean }
  }
}
```

## ACK

Background responds with:

```ts
{
  ok: boolean,
  ack?: {
    seq: number,
    eventId: string,
    highWatermarkSeq: number,
    decision: "accept" | "duplicate" | "stale"
  }
}
```

### Decision semantics

- `accept`: first valid event for this source/seq range, payload applied.
- `duplicate`: same `eventId` was already processed for this source.
- `stale`: `seq` is lower than or equal to source watermark and `eventId` is new.

## Source identity

Background tracks ordering by `tabId:frameId`.

- ordering and dedupe are source-local
- each source has its own `highWatermarkSeq`

## Session boundary

Background validates `meta.sessionId` against active recording session.

- mismatch -> rejected with `SESSION_MISMATCH`
- ingest cache resets when active session rotates

## Transport retries

Content recorder retries failed sends with bounded backoff and reuses the same
`meta` (`seq` + `eventId`) for idempotency.

If a `steps` flush fails, steps are re-queued to avoid loss.

## Compatibility mode

If `meta` is missing/invalid, background currently uses a legacy fallback path
and still applies payload. This keeps compatibility with stale content scripts
during rolling updates.
