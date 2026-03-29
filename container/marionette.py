"""
Minimal Firefox Marionette TCP client.

Marionette is Firefox's built-in remote protocol (enabled with --marionette).
It speaks a simple length-prefixed JSON protocol on port 2828.

We only need: connect, newSession, navigate, getURL, getTitle, executeJS.
"""

import json
import socket
import time


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, host="127.0.0.1", port=2828, timeout=10):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock = None
        self.session_id = None

    def connect(self, retries=10, delay=1.0):
        """Connect to Firefox Marionette, retrying until ready."""
        for attempt in range(retries):
            try:
                self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                self.sock.settimeout(self.timeout)
                self.sock.connect((self.host, self.port))
                # Read server hello
                self._recv()
                return
            except (ConnectionRefusedError, OSError):
                if self.sock:
                    self.sock.close()
                    self.sock = None
                if attempt < retries - 1:
                    time.sleep(delay)
        raise MarionetteError(
            f"Could not connect to Marionette at {self.host}:{self.port} "
            f"after {retries} attempts"
        )

    def probe(self):
        """Probe Marionette with a lightweight command.

        Returns True if healthy, False if zombie (accepts TCP but
        returns empty bytes or times out on handshake).
        """
        probe_sock = None
        try:
            probe_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probe_sock.settimeout(3)
            probe_sock.connect((self.host, self.port))
            # Read the hello handshake — zombie returns b''
            ch = probe_sock.recv(1)
            if not ch:
                return False
            return True
        except (ConnectionRefusedError, OSError, socket.timeout):
            return False
        finally:
            if probe_sock:
                try:
                    probe_sock.close()
                except OSError:
                    pass

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _send(self, msg):
        """Send a length-prefixed JSON message."""
        data = json.dumps(msg)
        packet = f"{len(data)}:{data}"
        self.sock.sendall(packet.encode("utf-8"))

    def _recv(self):
        """Read a length-prefixed JSON response."""
        # Read length prefix until ':'
        length_str = b""
        while True:
            ch = self.sock.recv(1)
            if not ch:
                raise MarionetteError("Connection closed")
            if ch == b":":
                break
            length_str += ch

        length = int(length_str)
        data = b""
        while len(data) < length:
            chunk = self.sock.recv(length - len(data))
            if not chunk:
                raise MarionetteError("Connection closed during read")
            data += chunk

        return json.loads(data.decode("utf-8"))

    def _command(self, name, params=None):
        """Send a Marionette command and return the result."""
        msg = [0, self._next_id(), name, params or {}]
        self._send(msg)
        resp = self._recv()
        # Response format: [1, id, error, result]
        if len(resp) >= 4:
            if resp[2]:  # error present
                err = resp[2]
                raise MarionetteError(
                    f"{err.get('error', 'unknown')}: {err.get('message', '')}"
                )
            return resp[3]
        return resp

    _id_counter = 0

    def _next_id(self):
        Marionette._id_counter += 1
        return Marionette._id_counter

    def new_session(self):
        """Create a new Marionette session."""
        result = self._command("WebDriver:NewSession", {
            "capabilities": {
                "alwaysMatch": {
                    "acceptInsecureCerts": True
                }
            }
        })
        self.session_id = result.get("sessionId") if isinstance(result, dict) else None
        return result

    def navigate(self, url):
        """Navigate to a URL."""
        return self._command("WebDriver:Navigate", {"url": url})

    def get_url(self):
        """Get current page URL."""
        result = self._command("WebDriver:GetCurrentURL")
        return result.get("value", "") if isinstance(result, dict) else str(result)

    def get_title(self):
        """Get current page title."""
        result = self._command("WebDriver:GetTitle")
        return result.get("value", "") if isinstance(result, dict) else str(result)

    def execute_script(self, script, args=None):
        """Execute JavaScript in the page context."""
        result = self._command("WebDriver:ExecuteScript", {
            "script": script,
            "args": args or [],
        })
        return result.get("value") if isinstance(result, dict) else result

    def execute_async_script(self, script, args=None, timeout_ms=30000):
        """Execute async JavaScript (with callback)."""
        # Set script timeout first
        self._command("WebDriver:SetTimeouts", {"script": timeout_ms})
        result = self._command("WebDriver:ExecuteAsyncScript", {
            "script": script,
            "args": args or [],
        })
        return result.get("value") if isinstance(result, dict) else result
