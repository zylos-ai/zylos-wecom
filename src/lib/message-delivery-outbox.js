import fs from 'fs';
import path from 'path';

export const DEFAULT_MESSAGE_DELIVERY_TTL_MS = 10 * 60 * 1000;

const STATES = ['pending', 'delivered', 'failed'];

function eventTime(event) {
  const value = event.state === 'delivered' ? event.deliveredAt
    : event.state === 'failed' ? event.failedAt
      : event.receivedAt;
  return Date.parse(value);
}

function appendDurably(journalPath, event, fsImpl) {
  fsImpl.mkdirSync(path.dirname(journalPath), { recursive: true });
  const fd = fsImpl.openSync(journalPath, 'a', 0o600);
  try {
    fsImpl.writeSync(fd, `${JSON.stringify(event)}\n`);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

export function createMessageDeliveryOutbox({
  journalPath,
  ttlMs = DEFAULT_MESSAGE_DELIVERY_TTL_MS,
  now = Date.now,
  fsImpl = fs,
  appendEvent = (event) => appendDurably(journalPath, event, fsImpl),
  onDuplicate = () => {},
  onError = () => {},
  onAmbiguousDelivery = () => {}
}) {
  if (!journalPath) throw new TypeError('journalPath is required');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive number');
  }

  const states = new Map();

  function prune(referenceTime = now()) {
    for (const [msgId, state] of states) {
      if (state.state === 'pending') continue;
      const timestamp = eventTime(state);
      if (!Number.isFinite(timestamp) || referenceTime - timestamp > ttlMs) {
        states.delete(msgId);
      }
    }
  }

  function hydrate() {
    if (!fsImpl.existsSync(journalPath)) return;
    let content;
    try {
      content = fsImpl.readFileSync(journalPath, 'utf8');
    } catch (error) {
      onError(`unable to read delivery journal: ${error.message}`);
      return;
    }

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        onError(`unable to parse delivery journal line ${index + 1}: ${error.message}`);
        continue;
      }
      if (!event?.msgId || !STATES.includes(event.state)) {
        onError(`invalid delivery journal event at line ${index + 1}`);
        continue;
      }
      if (event.state === 'pending' && (!event.record || event.record.msgId !== event.msgId)) {
        onError(`pending delivery journal event lacks its record at line ${index + 1}`);
        continue;
      }
      states.set(String(event.msgId), event);
    }
    prune();
  }

  hydrate();

  function markDelivered(msgId) {
    const id = String(msgId);
    const current = states.get(id);
    if (!current || current.state !== 'pending') {
      throw new Error(`cannot mark non-pending message delivered: ${id}`);
    }
    const event = {
      version: 1,
      state: 'delivered',
      msgId: id,
      receivedAt: current.receivedAt,
      deliveredAt: new Date(now()).toISOString(),
      record: current.record
    };
    try {
      appendEvent(event);
    } catch (error) {
      onAmbiguousDelivery(id, error);
      throw error;
    }
    states.set(id, event);
    return event;
  }

  /**
   * Finish a pending message without delivering it again: Core rejected it,
   * or its outcome is unknown. Core has no inbound idempotency key, so a
   * message that may already be stored is never resent.
   */
  function markFailed(msgId, reason) {
    const id = String(msgId);
    const current = states.get(id);
    if (!current || current.state !== 'pending') {
      throw new Error(`cannot mark non-pending message failed: ${id}`);
    }
    const event = {
      version: 1,
      state: 'failed',
      msgId: id,
      reason: String(reason),
      receivedAt: current.receivedAt,
      failedAt: new Date(now()).toISOString(),
      record: current.record
    };
    appendEvent(event);
    states.set(id, event);
    return event;
  }

  return {
    enqueue(record) {
      if (!record?.msgId) throw new TypeError('record.msgId is required');
      const msgId = String(record.msgId);
      prune();
      const existing = states.get(msgId);
      if (existing && existing.state !== 'pending') {
        onDuplicate(msgId);
        return { status: 'duplicate', record: existing.record || record };
      }
      if (existing?.state === 'pending') {
        return { status: 'pending', record: existing.record, retry: true };
      }

      const receivedAt = record.receivedAt || new Date(now()).toISOString();
      const storedRecord = { ...record, msgId, receivedAt };
      const event = { version: 1, state: 'pending', msgId, receivedAt, record: storedRecord };
      appendEvent(event);
      states.set(msgId, event);
      return { status: 'pending', record: storedRecord, retry: false };
    },

    markDelivered,

    markFailed,

    /**
     * Forward a pending record once and record the outcome. `forward` resolves
     * to `{ outcome, notice }` (see sendToC4). When Core has the message
     * (sent / committed) channel history is written and the record becomes
     * delivered; otherwise it becomes failed. Either way it is never resent.
     * A history write failure after Core accepted is only reported: resending
     * would deliver the message twice.
     */
    async deliver(record, { forward, recordHistory, onHistoryFailure = () => {} }) {
      if (!record?.msgId) throw new TypeError('record.msgId is required');
      if (typeof forward !== 'function') throw new TypeError('forward is required');
      if (typeof recordHistory !== 'function') throw new TypeError('recordHistory is required');

      let result;
      try {
        result = await forward(record);
      } catch (error) {
        result = { outcome: 'uncertain', notice: null, error };
      }
      if (result.outcome === 'sent' || result.outcome === 'committed') {
        let historyOk = false;
        try {
          historyOk = recordHistory(record) === true;
        } catch { /* reported below */ }
        if (!historyOk) onHistoryFailure(record.msgId);
        markDelivered(record.msgId);
        return { delivered: true, ...result };
      }
      markFailed(record.msgId, result.outcome);
      return { delivered: false, ...result };
    },

    lookup(msgId) {
      if (!msgId) return null;
      prune();
      return states.get(String(msgId)) || null;
    },

    pendingRecords() {
      return [...states.values()]
        .filter((state) => state.state === 'pending')
        .sort((a, b) => eventTime(a) - eventTime(b))
        .map((state) => state.record);
    },

    prune,

    size() {
      return states.size;
    }
  };
}
