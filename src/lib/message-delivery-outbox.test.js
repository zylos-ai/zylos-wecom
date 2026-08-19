import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMessageDeliveryOutbox,
  DEFAULT_MESSAGE_DELIVERY_TTL_MS
} from './message-delivery-outbox.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-outbox-'));
  return { dir, journalPath: path.join(dir, 'delivery.jsonl') };
}

function record(msgId, receivedAt = '2026-08-18T10:00:00.000Z') {
  return {
    msgId,
    receivedAt,
    content: `message:${msgId}`,
    endpoint: `chat|type:group|msg:${msgId}`,
    historyChatId: 'group-1',
    historyEntry: { msgId, text: msgId, timestamp: receivedAt }
  };
}

test('suppresses only messages that have reached delivered state', () => {
  const { journalPath } = fixture();
  const duplicates = [];
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    now: () => Date.parse('2026-08-18T10:00:01.000Z'),
    onDuplicate: (msgId) => duplicates.push(msgId)
  });

  assert.equal(outbox.enqueue(record('stable-1')).status, 'pending');
  assert.equal(outbox.enqueue(record('stable-1')).status, 'pending');
  outbox.markDelivered('stable-1');
  assert.equal(outbox.enqueue(record('stable-1')).status, 'duplicate');
  assert.deepEqual(duplicates, ['stable-1']);
});

test('restarts with pending records ordered and eligible for redelivery', () => {
  const { journalPath } = fixture();
  const beforeRestart = createMessageDeliveryOutbox({ journalPath });
  beforeRestart.enqueue(record('before-1', '2026-08-18T10:00:00.000Z'));
  beforeRestart.enqueue(record('before-2', '2026-08-18T10:00:01.000Z'));

  const afterRestart = createMessageDeliveryOutbox({ journalPath });
  assert.deepEqual(
    afterRestart.pendingRecords().map((entry) => entry.msgId),
    ['before-1', 'before-2']
  );
  assert.equal(afterRestart.lookup('before-1').state, 'pending');
});

test('recovers crash after persist and before C4 delivery without message loss', async () => {
  const { journalPath } = fixture();
  createMessageDeliveryOutbox({ journalPath }).enqueue(record('crash-before-c4'));

  const restarted = createMessageDeliveryOutbox({ journalPath });
  const forwarded = [];
  const history = [];
  for (const pending of restarted.pendingRecords()) {
    await restarted.deliver(pending, {
      forward: async (entry) => forwarded.push(entry.msgId),
      recordHistory: (entry) => {
        history.push(entry.msgId);
        return true;
      }
    });
  }

  assert.deepEqual(forwarded, ['crash-before-c4']);
  assert.deepEqual(history, ['crash-before-c4']);
  assert.equal(restarted.lookup('crash-before-c4').state, 'delivered');
});

test('keeps ambiguous C4 success pending and visibly retries without pretending downstream dedupe', async () => {
  const { journalPath } = fixture();
  const first = createMessageDeliveryOutbox({ journalPath });
  first.enqueue(record('ack-gap'));

  const warnings = [];
  let rejectDeliveredWrite = true;
  const ambiguous = createMessageDeliveryOutbox({
    journalPath,
    appendEvent(event) {
      if (event.state === 'delivered' && rejectDeliveredWrite) {
        throw new Error('simulated delivered marker failure');
      }
      fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
    },
    onAmbiguousDelivery: (msgId, error) => warnings.push(`${msgId}:${error.message}`)
  });

  const forwarded = [];
  const history = new Set();
  await assert.rejects(
    ambiguous.deliver(ambiguous.pendingRecords()[0], {
      forward: async (entry) => forwarded.push(entry.msgId),
      recordHistory: (entry) => {
        history.add(entry.msgId);
        return true;
      }
    }),
    (error) => error.c4Accepted === true && /simulated delivered marker failure/.test(error.message)
  );
  assert.equal(ambiguous.lookup('ack-gap').state, 'pending');
  assert.equal(warnings.length, 1);

  const restarted = createMessageDeliveryOutbox({ journalPath });
  await restarted.deliver(restarted.pendingRecords()[0], {
    forward: async (entry) => forwarded.push(entry.msgId),
    recordHistory: (entry) => {
      history.add(entry.msgId);
      return true;
    }
  });

  assert.deepEqual(forwarded, ['ack-gap', 'ack-gap'], 'the acknowledgement gap is an observable duplicate forward');
  assert.equal(history.size, 1, 'channel history remains idempotent by stable msgid');
  assert.equal(restarted.lookup('ack-gap').state, 'delivered');
  rejectDeliveredWrite = false;
});

test('expires delivered suppression only after the retry-safe TTL', () => {
  const { journalPath } = fixture();
  const deliveredAt = Date.parse('2026-08-18T10:00:00.000Z');
  const writer = createMessageDeliveryOutbox({ journalPath, now: () => deliveredAt });
  writer.enqueue(record('ttl-msg'));
  writer.markDelivered('ttl-msg');

  const within = createMessageDeliveryOutbox({
    journalPath,
    now: () => deliveredAt + DEFAULT_MESSAGE_DELIVERY_TTL_MS
  });
  assert.equal(within.enqueue(record('ttl-msg')).status, 'duplicate');

  const outside = createMessageDeliveryOutbox({
    journalPath,
    now: () => deliveredAt + DEFAULT_MESSAGE_DELIVERY_TTL_MS + 1
  });
  assert.equal(outside.enqueue(record('ttl-msg')).status, 'pending');
});

test('reports corrupt persistence instead of silently treating it as delivered', () => {
  const { journalPath } = fixture();
  fs.writeFileSync(journalPath, '{not-json}\n');
  const errors = [];
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    onError: (message) => errors.push(message)
  });

  assert.equal(outbox.enqueue(record('new-message')).status, 'pending');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unable to parse delivery journal line 1/);
});

test('does not forward when pending state cannot be persisted', async () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    appendEvent() {
      throw new Error('simulated pending write failure');
    }
  });
  let forwards = 0;

  assert.throws(() => outbox.enqueue(record('write-failure')), /simulated pending write failure/);
  assert.equal(outbox.lookup('write-failure'), null);
  assert.equal(forwards, 0);
});

test('keeps a message pending when C4 explicitly rejects delivery', async () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({ journalPath });
  const pending = outbox.enqueue(record('c4-failure')).record;
  let historyWrites = 0;

  await assert.rejects(
    outbox.deliver(pending, {
      forward: async () => { throw new Error('C4 unavailable'); },
      recordHistory: () => {
        historyWrites += 1;
        return true;
      }
    }),
    (error) => error.c4Accepted === false && /C4 unavailable/.test(error.message)
  );
  assert.equal(outbox.lookup('c4-failure').state, 'pending');
  assert.equal(historyWrites, 0);
});
