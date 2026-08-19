import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPLICIT_OFFICE_MESSAGE_INTENT,
  parseWecomCliError,
  runWecomCli,
  WecomCliAuthRequiredError,
  WecomCliPrincipalMismatchError,
  WecomCliRouteViolationError
} from './wecom-cli-bridge.js';

const CHANNEL_BOT_ID = 'bot-current';

function exactBotExec(runBusiness) {
  return (command, args, options) => {
    if (args[0] === 'auth' && args[1] === 'show') {
      return `Status: authorized\nBot ID: ${CHANNEL_BOT_ID}\n`;
    }
    return runBusiness(command, args, options);
  };
}

test.beforeEach(() => {
  process.env.WECOM_BOT_ID = CHANNEL_BOT_ID;
});

test('parseWecomCliError reads a structured error after diagnostics', () => {
  const result = parseWecomCliError(`warning: cache expired
{"error":{"type":"AuthError","code":893201,"message":"need auth"}}`);
  assert.deepEqual(result, {
    type: 'AuthError',
    code: 893201,
    message: 'need auth'
  });
});

test('parseWecomCliError ignores malformed and successful output', () => {
  assert.equal(parseWecomCliError(''), null);
  assert.equal(parseWecomCliError('{broken'), null);
  assert.equal(parseWecomCliError('{"results":[]}'), null);
});

test('parseWecomCliError tolerates diagnostics after compact JSON', () => {
  const result = parseWecomCliError(`{"error":{"type":"AuthError","code":893201}}
warning: token cache unavailable`);
  assert.equal(result.code, 893201);
});

test('runWecomCli passes argv without a shell', () => {
  let invocation;
  const output = runWecomCli(['contact', 'search', '--keyword', 'Alice; rm -rf /'], {
    exec: exactBotExec((command, args, options) => {
      invocation = { command, args, options };
      return '{"results":[]}';
    })
  });

  assert.equal(output, '{"results":[]}');
  assert.equal(invocation.command, 'wecom-cli');
  assert.deepEqual(invocation.args, [
    'contact',
    'search',
    '--keyword',
    'Alice; rm -rf /'
  ]);
  assert.equal(invocation.options.shell, undefined);
});

test('runWecomCli allows office messages only with explicit intent', () => {
  let invocation;
  const output = runWecomCli(
    ['message', 'aibot', 'send', '--json', '{"msg_type":"markdown"}'],
    {
      intent: EXPLICIT_OFFICE_MESSAGE_INTENT,
      exec: exactBotExec((command, args) => {
        invocation = { command, args };
        return '{"errcode":0}';
      })
    }
  );

  assert.equal(output, '{"errcode":0}');
  assert.equal(invocation.command, 'wecom-cli');
  assert.deepEqual(invocation.args.slice(0, 3), ['message', 'aibot', 'send']);
});

test('runWecomCli rejects office-message routing without explicit intent', () => {
  const warnings = [];
  let executed = false;

  assert.throws(
    () => runWecomCli(['message', 'aibot', 'send', '--json', '{}'], {
      exec() {
        executed = true;
        return '';
      },
      onRouteViolation(message) {
        warnings.push(message);
      }
    }),
    (error) => {
      assert.ok(error instanceof WecomCliRouteViolationError);
      assert.equal(error.code, 'WECOM_CLI_ROUTE_VIOLATION');
      assert.match(error.message, /scripts\/send\.js/);
      return true;
    }
  );

  assert.equal(executed, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WECOM_CLI_ROUTE_VIOLATION/);
});

test('runWecomCli rejects a stale or different Bot before a business command', () => {
  let businessExecuted = false;
  assert.throws(
    () => runWecomCli(['disk', 'search'], {
      exec(_command, args) {
        if (args[0] === 'auth') {
          return 'Status: authorized\nBot ID: bot-stale\n';
        }
        businessExecuted = true;
        return '';
      }
    }),
    (error) => {
      assert.ok(error instanceof WecomCliPrincipalMismatchError);
      assert.equal(error.code, 'WECOM_CLI_PRINCIPAL_MISMATCH');
      return true;
    }
  );
  assert.equal(businessExecuted, false);
});

test('runWecomCli strips the Bot Secret from gate and business child environments', () => {
  const seenEnvironments = [];
  runWecomCli(['contact', 'search'], {
    env: { PATH: '/usr/bin', WECOM_BOT_SECRET: 'must-not-leak' },
    exec(_command, args, options) {
      seenEnvironments.push(options.env);
      if (args[0] === 'auth' && args[1] === 'show') {
        return `Status: authorized\nBot ID: ${CHANNEL_BOT_ID}\n`;
      }
      return '{"results":[]}';
    }
  });
  assert.equal(seenEnvironments.length, 2);
  for (const env of seenEnvironments) {
    assert.equal(env.WECOM_BOT_SECRET, undefined);
  }
});

test('runWecomCli converts authorization failures to a typed error', () => {
  const original = Object.assign(new Error('exit 1'), {
    stdout: '{"error":{"type":"AuthError","code":893201}}',
    stderr: ''
  });

  assert.throws(
    () => runWecomCli(['contact', 'search'], {
      exec: exactBotExec(() => { throw original; })
    }),
    (error) => {
      assert.ok(error instanceof WecomCliAuthRequiredError);
      assert.equal(error.errorInfo.code, 893201);
      assert.equal(error.originalError, original);
      return true;
    }
  );
});

test('runWecomCli preserves non-auth failures', () => {
  const original = Object.assign(new Error('exit 1'), {
    stdout: '{"error":{"type":"ApiError","code":500}}',
    stderr: ''
  });
  assert.throws(
    () => runWecomCli(['disk', 'search'], {
      exec: exactBotExec(() => { throw original; })
    }),
    (error) => error === original
  );
});
