#!/usr/bin/env python3
"""Drive the official CLI manual auth flow through a PTY without argv secrets."""

import json
import os
import pty
import select
import signal
import sys
import time


TERM_GRACE_SECONDS = 1.0


def fail(code):
    print(json.dumps({"ok": False, "error": code}), flush=True)
    return 1


def terminate_and_reap(pid, grace_seconds=TERM_GRACE_SECONDS):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return None

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        try:
            waited_pid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return None
        if waited_pid == pid:
            return status
        time.sleep(0.05)

    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        return status
    except ChildProcessError:
        return None


def main():
    try:
        payload = json.loads(sys.stdin.readline())
        bot_id = payload["bot_id"]
        secret = payload["secret"]
        cli_path = payload.get("cli_path") or "wecom-cli"
        timeout_seconds = int(payload.get("timeout_seconds") or 30)
    except Exception:
        return fail("invalid_input")

    if not isinstance(bot_id, str) or not isinstance(secret, str):
        return fail("invalid_input")
    if not bot_id or not secret or "\n" in bot_id or "\n" in secret:
        return fail("invalid_input")

    pid, master_fd = pty.fork()
    if pid == 0:
        child_env = os.environ.copy()
        child_env.pop("WECOM_BOT_ID", None)
        child_env.pop("WECOM_BOT_SECRET", None)
        os.execvpe(cli_path, [cli_path, "auth", "init", "--manual"], child_env)

    def terminate_child(_signum, _frame):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGINT, terminate_child)
    signal.signal(signal.SIGTERM, terminate_child)

    deadline = time.monotonic() + timeout_seconds
    buffer = b""
    sent_bot_id = False
    sent_secret = False
    status = None

    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master_fd], [], [], 0.25)
            if ready:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    buffer = (buffer + chunk)[-32768:]
                    text = buffer.decode("utf-8", errors="ignore")
                    if not sent_bot_id and "Bot ID" in text:
                        os.write(master_fd, (bot_id + "\n").encode())
                        sent_bot_id = True
                        buffer = b""
                    elif sent_bot_id and not sent_secret and "Secret" in text:
                        os.write(master_fd, (secret + "\n").encode())
                        sent_secret = True
                        buffer = b""

            waited_pid, waited_status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                status = waited_status
                break

        if status is None:
            terminate_and_reap(pid)
            return fail("auth_timeout")

        exit_code = os.waitstatus_to_exitcode(status)
        if exit_code != 0:
            return fail("auth_failed")
        if not sent_bot_id or not sent_secret:
            return fail("prompt_mismatch")
        print(json.dumps({"ok": True, "status": "authorized"}), flush=True)
        return 0
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
