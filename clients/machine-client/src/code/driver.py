
import ast
import base64
import concurrent.futures
import contextlib
import hashlib
import signal
import subprocess
import urllib.request
import io
import itertools
import json
import os
import queue
import re
import sys
import threading
import time
import traceback

_OUTPUT_LIMIT = int(os.environ["ONI_CELL_OUTPUT_MAX_BYTES"])
_BROWSER_TRANSCRIPT_LIMIT = 65_536
_emit_lock = threading.Lock()
_cell_context = threading.local()
_cell_requests = queue.Queue()
_answer_queues = {}
_answer_queues_lock = threading.Lock()
_call_ids = itertools.count(1)


def _emit(payload):
    with _emit_lock:
        sys.__stdout__.write(json.dumps(payload) + "\n")
        sys.__stdout__.flush()


def _read_stdin():
    while True:
        _line = sys.__stdin__.readline()
        if not _line:
            with _answer_queues_lock:
                _waiting = list(_answer_queues.values())
                _answer_queues.clear()
            for _answers in _waiting:
                _answers.put({"status": "failed", "error": "driver stdin closed"})
            _cell_requests.put(None)
            return
        _frame = json.loads(_line)
        _call_id = _frame.get("callId")
        if _call_id is None:
            _cell_requests.put(_frame)
            continue
        with _answer_queues_lock:
            _answers = _answer_queues.get(_call_id)
        # A late answer for a timed-out/completed call is intentionally inert.
        if _answers is not None:
            _answers.put(_frame)


class ToolError(Exception):
    """Raised in the cell when a host tool refuses or fails, so it is catchable."""


class _Tools:
    """tool.<name>(**kwargs) and tool["dotted.name"](**kwargs) reach the host."""

    def __getattr__(self, name):
        return self[name]

    def __getitem__(self, name):
        def call(**arguments):
            # The calling thread's cell identity travels with the frame. A bare
            # thread that outlives its cell has no identity and is refused —
            # otherwise it would execute under whichever cell runs next.
            _cell = getattr(_cell_context, "cell_id", None)
            if _cell is None:
                raise ToolError(
                    "tool call refused: tools are reachable only from the cell's"
                    " own execution or its parallel() threads, never from a"
                    " thread that outlives its cell"
                )
            _call_id = str(next(_call_ids))
            _answers = queue.Queue(maxsize=1)
            with _answer_queues_lock:
                _answer_queues[_call_id] = _answers
            try:
                _emit({
                    "kind": "tool_call",
                    "callId": _call_id,
                    "cellId": _cell,
                    "name": name,
                    "arguments": arguments,
                })
                _answer = _answers.get()
            finally:
                with _answer_queues_lock:
                    if _answer_queues.get(_call_id) is _answers:
                        del _answer_queues[_call_id]
            if _answer["status"] == "completed":
                return _answer.get("value")
            raise ToolError(_answer["error"])

        return call


def parallel(thunks, max_concurrency=8):
    """Run zero-argument callables concurrently and preserve input order."""
    _thunks = list(thunks)
    if not _thunks:
        return []
    _cell = getattr(_cell_context, "cell_id", None)

    def _in_cell(_thunk):
        def _run():
            _cell_context.cell_id = _cell
            return _thunk()

        return _run

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_concurrency) as _executor:
        _futures = [_executor.submit(_in_cell(_thunk)) for _thunk in _thunks]
        concurrent.futures.wait(_futures)
        return [_future.result() for _future in _futures]


class _Output(io.TextIOBase):
    """A cell stream: buffered for the result frame, streamed so a peek sees it live."""

    def __init__(self, cell_id, stream):
        self._cell_id = cell_id
        self._stream = stream
        self._buffer = io.StringIO()
        self.original_bytes = 0
        self._retained_bytes = 0
        self._cut = False

    def writable(self):
        return True

    def write(self, text):
        if text:
            encoded = text.encode("utf-8")
            self.original_bytes += len(encoded)
            remaining = _OUTPUT_LIMIT - self._retained_bytes
            kept = encoded[:remaining].decode("utf-8", "ignore") if not self._cut else ""
            self._buffer.write(kept)
            kept_bytes = len(kept.encode("utf-8"))
            self._retained_bytes += kept_bytes
            previously_cut = self._cut
            self._cut = self._cut or kept_bytes < len(encoded)
            if kept or not previously_cut:
                _emit({"kind": "output", "cellId": self._cell_id, "stream": self._stream,
                       "text": kept, "originalBytes": len(encoded)})
        return len(text)

    def getvalue(self):
        value = self._buffer.getvalue()
        return value + ("\n[truncated: " + str(self.original_bytes) + " bytes]\n" if self._cut else "")

    def metadata(self):
        return {"originalBytes": self.original_bytes} if self._cut else None


def _cell_output(stdout, stderr):
    output = {"stdout": stdout.getvalue(), "stderr": stderr.getvalue()}
    truncated = {}
    if stdout.metadata() is not None:
        truncated["stdout"] = stdout.metadata()
    if stderr.metadata() is not None:
        truncated["stderr"] = stderr.metadata()
    if truncated:
        output["truncated"] = truncated
    return output


def tool_output(output_id):
    """Read a stored tool output back in full by the identifier a projected result cited (#1305)."""
    return tool["tool_output"](outputId=output_id)["text"]


def completion(prompt, model=None, system=None, schema=None):
    """One stateless sub-model call; with a JSON Schema the answer is decoded JSON."""
    _arguments = {"prompt": prompt}
    if model is not None:
        _arguments["model"] = model
    if system is not None:
        _arguments["system"] = system
    if schema is not None:
        _arguments["schema"] = schema
    _answer = tool.completion(**_arguments)
    return json.loads(_answer) if schema is not None else _answer


class _Machine:
    def __init__(self, machine_id, lease_id=None):
        self.id = machine_id
        self.machine_id = machine_id
        self.lease_id = lease_id

    def read(self, path):
        value = tool['codemode.read'](machineId=self.machine_id, leaseId=self.lease_id, path=path)
        value['data'] = base64.b64decode(value['data'])
        return value

    def write(self, path, data):
        return tool['codemode.write'](machineId=self.machine_id, leaseId=self.lease_id, path=path, data=base64.b64encode(data).decode('ascii'))

    def ls(self, path):
        return tool['codemode.ls'](machineId=self.machine_id, leaseId=self.lease_id, path=path)

    def bash(self, command, cwd):
        value = tool['codemode.bash'](machineId=self.machine_id, leaseId=self.lease_id, cmd=command, cwd=cwd)
        if value['status'] == 'completed':
            value['stdout'] = base64.b64decode(value['stdout'])
            value['stderr'] = base64.b64decode(value['stderr'])
        return value

    def eval(self, code):
        return tool['codemode.eval'](machineId=self.machine_id, leaseId=self.lease_id, code=code)

    def screen(self, display=None, region=None):
        args = {'machineId': self.machine_id, 'leaseId': self.lease_id}
        if display is not None:
            args['display'] = display
        if region is not None:
            args['region'] = region
        value = tool['codemode.screen'](**args)
        if value['status'] == 'ok':
            value['png'] = base64.b64decode(value['png'])
            self._capture_id = value['captureId']
        return value

    def input(self, actions, capture_id=None):
        anchor = capture_id if capture_id is not None else getattr(self, '_capture_id', None)
        if anchor is None:
            raise ToolError('input requires a prior screen() capture or an explicit capture_id')
        return tool['codemode.input'](machineId=self.machine_id, leaseId=self.lease_id, captureId=anchor, actions=actions)

    def pty(self, name):
        return _PtySession(self.machine_id, name, self.lease_id)

    def ptyList(self):
        return tool['codemode.ptyList'](machineId=self.machine_id, leaseId=self.lease_id)

    def job(self, command, cwd):
        cell_id = getattr(_cell_context, 'cell_id', None)
        if cell_id is None:
            raise ToolError('job requires a running cell')
        name = 'job-' + hashlib.sha256(
            (cell_id + ':' + str(next(_call_ids))).encode('utf-8')
        ).hexdigest()[:24]
        terminal = self.pty(name)
        opened = tool['codemode.ptyOpen'](
            machineId=self.machine_id, leaseId=self.lease_id,
            name=name, cwd=cwd, workClass='job',
        )
        if opened['status'] != 'ok':
            raise ToolError('job open refused: ' + opened['reason'])
        launch = (
            '( eval ' + _shell_quote(command) + ' ); _job_code=$?; '
            + "printf '\\n__job_done_%s:%s__\\n' " + _shell_quote(name)
            + ' "$_job_code"\r'
        )
        written = terminal.write(launch)
        if written['status'] != 'ok':
            raise ToolError('job write refused: ' + written['reason'])
        return {'name': name, 'machineId': self.machine_id}

    def job_read(self, name, cursor=None, wait_ms=None):
        view = self.pty(name).read(cursor=cursor, wait_ms=wait_ms)
        if view['status'] != 'ok':
            if view['reason'] in ('pty_not_found', 'pty_not_available'):
                return {'status': 'lost', 'name': name, 'machineId': self.machine_id,
                        'reason': view['reason']}
            raise ToolError('job read refused: ' + view['reason'])
        match = re.search(
            rb'__job_done_' + name.encode('ascii') + rb':([0-9]+)__\r?\n',
            view['data'],
        )
        return {
            **view,
            'name': name,
            'machineId': self.machine_id,
            'exitCode': int(match.group(1)) if match else None,
        }

    def job_wait(self, name, timeout):
        if timeout < 0:
            raise ValueError('job_wait timeout must be nonnegative seconds')
        deadline = time.monotonic() + timeout
        cursor = None
        marker = rb'__job_done_' + name.encode('ascii') + rb':([0-9]+)__\r?\n'
        tail = b''
        tail_limit = len(name) + 32
        while True:
            remaining = deadline - time.monotonic()
            view = self.job_read(
                name, cursor=cursor,
                wait_ms=min(30000, max(0, int(remaining * 1000))),
            )
            if view['status'] == 'lost':
                return view
            cursor = view['cursor']
            chunk = tail + view['data']
            match = re.search(marker, chunk)
            if match:
                return {'status': 'completed', 'name': name, 'machineId': self.machine_id,
                        'exitCode': int(match.group(1)), 'cursor': cursor}
            tail = chunk[-tail_limit:]
            if time.monotonic() >= deadline:
                return {'status': 'timed_out', 'name': name, 'machineId': self.machine_id,
                        'cursor': cursor}


class _PtySession:
    """Named persistent terminal (#1273); reattach is just pty(name) again."""

    def __init__(self, machine_id, name, lease_id=None):
        self.machine_id = machine_id
        self.name = name
        self.lease_id = lease_id

    def open(self, cwd):
        return tool['codemode.ptyOpen'](machineId=self.machine_id, leaseId=self.lease_id, name=self.name, cwd=cwd)

    def write(self, data):
        payload = data.encode('utf-8') if isinstance(data, str) else data
        return tool['codemode.ptyWrite'](machineId=self.machine_id, leaseId=self.lease_id, name=self.name, data=base64.b64encode(payload).decode('ascii'))

    def read(self, cursor=None, wait_ms=None):
        args = {'machineId': self.machine_id, 'leaseId': self.lease_id, 'name': self.name}
        if cursor is not None:
            args['cursor'] = cursor
        if wait_ms is not None:
            args['waitMs'] = wait_ms
        value = tool['codemode.ptyRead'](**args)
        if value['status'] == 'ok':
            value['data'] = base64.b64decode(value['data'])
        return value

    def resize(self, cols, rows):
        return tool['codemode.ptyResize'](machineId=self.machine_id, leaseId=self.lease_id, name=self.name, cols=cols, rows=rows)

    def close(self):
        return tool['codemode.ptyClose'](machineId=self.machine_id, leaseId=self.lease_id, name=self.name)


class _Codemode:
    def listMachines(self):
        return tool['codemode.listMachines']()

def machine(id=None, *, tag=None, prefer="spread", requires=None):
    if (id is None) == (tag is None):
        raise ToolError("machine() requires exactly one of id or tag")
    if id is not None:
        return _Machine(id)
    query = {"tag": tag, "prefer": prefer}
    if requires is not None:
        query["requires"] = requires
    selected = tool['codemode.findMachine'](query=query)
    return _Machine(selected['machineId'], selected['leaseId'])

# --- Browser recipe (#1275): Playwright over CDP; Chromium lives in a pty.session. ---
BROWSER_DEFAULT_CDP_PORT = 9222
_BROWSER_MARK = "[oni-browser]"
_BROWSER_INSTALL_HINT = "python -m playwright install chromium"
_BROWSER_DEVTOOLS_LINE = "DevTools listening on ws://"
_browser_clients = {}
_browser_playwright = {"instance": None}

_BROWSER_PORT_PROBE = base64.b64encode(
    (
        (
        "import socket\n"
        "_port = %d\n"
        "while _port < %d:\n"
        "    _sock = socket.socket()\n"
        "    try:\n"
        "        _sock.bind((\"127.0.0.1\", _port))\n"
        "        break\n"
        "    except OSError:\n"
        "        _port += 1\n"
        "    finally:\n"
        "        _sock.close()\n"
        "print(_port)\n"
        )
        % (BROWSER_DEFAULT_CDP_PORT, BROWSER_DEFAULT_CDP_PORT + 100)
    ).encode("ascii")
).decode("ascii")


class BrowserLost(ToolError):
    """Typed browser_lost refusal; terminal_output carries the tmux transcript."""

    def __init__(self, message, terminal_output):
        self.reason = "browser_lost"
        self.terminal_output = terminal_output
        super().__init__(
            "browser_lost: " + message + "\n--- tmux session output ---\n" + terminal_output
        )


def _browser_playwright_instance():
    if _browser_playwright["instance"] is None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as error:
            raise ToolError(
                "browser() needs the playwright package in this interpreter: "
                "pip install playwright && " + _BROWSER_INSTALL_HINT
            ) from error
        _browser_playwright["instance"] = sync_playwright().start()
    return _browser_playwright["instance"]


def _shell_quote(value):
    return "'" + value.replace("'", "'\\''") + "'"


class BrowserClient:
    """Thin handle over playwright.chromium.connect_over_cdp (#1275): browser,
    context(s) and pages are the raw Playwright objects; the only added
    behavior is liveness translation into the typed BrowserLost refusal."""

    def __init__(self, machine_id, profile_dir, headless):
        self.machine_id = machine_id
        self.profile_dir = profile_dir
        self.headless = headless
        self.session = (
            "oni-browser-" + hashlib.sha256(profile_dir.encode("utf-8")).hexdigest()[:12]
        )
        self.port = None
        self.endpoint = None
        self._cursor = None
        self._transcript = ""
        self._browser_pid = None
        self._browser = None
        self._cdp = None

    def _pty(self):
        return _Machine(self.machine_id).pty(self.session)

    def _drain(self, wait_ms=None):
        """Pull terminal output onto the retained transcript; None = session gone."""
        try:
            view = self._pty().read(cursor=self._cursor, wait_ms=wait_ms)
        except ToolError:
            return None
        if view.get("status") != "ok":
            return None
        self._cursor = view["cursor"]
        text = view["data"].decode("utf-8", "replace")
        self._append_transcript(text)
        return text

    def _append_transcript(self, text):
        found = re.findall(re.escape(_BROWSER_MARK) + r" chromium-pid (\d+)", self._transcript + text)
        if found:
            self._browser_pid = int(found[-1])
        combined = (self._transcript + text).encode("utf-8")
        self._transcript = combined[-_BROWSER_TRANSCRIPT_LIMIT:].decode("utf-8", "ignore")

    def _await_output(self, markers, quiet_rounds=120, wait_ms=1000, max_reads=10000):
        """Block on pty_read long-polls until a marker line is observed: readiness
        is decided by exact output, never by elapsed time. Non-empty reads return
        immediately (terminal echo arrives as many tiny events), so the failure
        bound counts QUIET long-poll rounds plus a generous total-read cap."""
        quiet = 0
        carry = ""
        marker_width = max(map(len, markers), default=0)
        for _ in range(max_reads):
            for marker in markers:
                if marker in self._transcript:
                    return marker
            chunk = self._drain(wait_ms)
            if chunk is None:
                return None
            for marker in markers:
                if marker in carry + chunk:
                    return marker
            carry = (carry + chunk)[-marker_width:]
            quiet = quiet + 1 if chunk == "" else 0
            if quiet >= quiet_rounds:
                return None
        return None

    def _fail_launch(self, message):
        """Launch never reached readiness (4b): the owned tmux session is torn
        down so no dead session lingers, and the transcript rides the refusal."""
        self._drain()
        self._stop_chromium()
        try:
            self._pty().close()
        except ToolError:
            pass
        raise BrowserLost(message, self._transcript)

    def _set_endpoint(self, port):
        self.port = port
        self.endpoint = "http://127.0.0.1:" + str(port)

    def _launch(self, executable_path):
        opened = self._pty().open(self.profile_dir)
        if opened.get("status") != "ok":
            raise ToolError(
                str(opened.get("reason")) + ": profile_dir " + self.profile_dir
                + " was refused by machine " + self.machine_id + " before Chromium started"
            )
        self._cursor = opened["cursor"]
        self._transcript = ""
        self._browser_pid = None
        if executable_path is not None:
            resolve = "OMO_EXE=" + _shell_quote(executable_path)
        else:
            resolve = (
                'OMO_EXE="$(python3 -c "from playwright.sync_api import sync_playwright;'
                '_p=sync_playwright().start();print(_p.chromium.executable_path);_p.stop()"'
                ' 2>/dev/null)"'
            )
        self._pty().write(
            resolve
            + '; [ -n "$OMO_EXE" ] || OMO_EXE=unresolved'
            + "; if [ -x \"$OMO_EXE\" ]; then printf '%s %s %s\\n' '" + _BROWSER_MARK
            + "' exe-ok \"$OMO_EXE\"; else printf '%s %s %s\\n' '" + _BROWSER_MARK
            + "' exe-missing \"$OMO_EXE\"; fi\r"
        )
        marker = self._await_output(
            [_BROWSER_MARK + " exe-ok", _BROWSER_MARK + " exe-missing"]
        )
        if marker != _BROWSER_MARK + " exe-ok":
            found = re.search(re.escape(_BROWSER_MARK) + r" exe-missing (\S+)", self._transcript)
            path = found.group(1) if found else (executable_path or "unresolved")
            self._fail_launch(
                "chromium executable missing at " + path
                + "; install it with: " + _BROWSER_INSTALL_HINT
            )
        mode_flags = "--headless " if self.headless else ""
        self._pty().write(
            "OMO_PORT=\"$(python3 -c \"import base64;exec(base64.b64decode('"
            + _BROWSER_PORT_PROBE + "').decode())\")\""
            + "; printf '%s %s %s\\n' '" + _BROWSER_MARK + "' cdp-port \"$OMO_PORT\""
            + '; "$OMO_EXE" --remote-debugging-port="$OMO_PORT" --user-data-dir='
            + _shell_quote(self.profile_dir)
            + " " + mode_flags + "--no-first-run --no-default-browser-check about:blank &"
            + ' OMO_PID=$!'
            + "; printf '%s %s %s\\n' '" + _BROWSER_MARK + "' chromium-pid \"$OMO_PID\""
            + '; wait "$OMO_PID"'
            + "; OMO_STATUS=$?"
            + "; printf '%s %s %s\\n' '" + _BROWSER_MARK + "' chromium-exited \"$OMO_STATUS\""
            # A clean exit or a signal-range status (external stop, including our
            # own cleanup) ends the session; a real error status keeps it so the
            # failure output stays readable.
            + '; { [ "$OMO_STATUS" = 0 ] || [ "$OMO_STATUS" -ge 128 ]; } && exit\r'
        )
        marker = self._await_output([_BROWSER_DEVTOOLS_LINE, _BROWSER_MARK + " chromium-exited"])
        if marker != _BROWSER_DEVTOOLS_LINE:
            self._fail_launch("chromium exited before the DevTools readiness line")
        ports = re.findall(re.escape(_BROWSER_MARK) + r" cdp-port (\d+)", self._transcript)
        if not ports:
            self._fail_launch("the selected cdp port line is missing from the session output")
        self._set_endpoint(int(ports[-1]))
        self._connect()

    def _attach(self, executable_path):
        # pty_list also reports sessions whose tmux side is gone as "lost"
        # (a crashed launch exits the shell before close() can run); only a
        # live session is reconnectable, a lost one is launched afresh.
        listed = _Machine(self.machine_id).ptyList()
        names = (
            [entry["name"] for entry in listed.get("sessions", []) if entry.get("status") == "live"]
            if listed.get("status") == "ok"
            else []
        )
        if self.session not in names:
            self._launch(executable_path)
            return
        # The session already runs this profile's Chromium: reconnect to the port
        # retained in its output instead of starting a competing process.
        self._cursor = None
        self._transcript = ""
        self._drain()
        ports = re.findall(re.escape(_BROWSER_MARK) + r" cdp-port (\d+)", self._transcript)
        if not ports:
            self._fail_launch("an existing browser session retains no cdp port line")
        self._set_endpoint(int(ports[-1]))
        self._connect()

    def _connect(self):
        chromium = _browser_playwright_instance().chromium
        try:
            self._browser = chromium.connect_over_cdp(self.endpoint)
            # One retained browser-level CDP session doubles as the liveness
            # probe: sync playwright only pumps its loop inside a call, so a
            # local is_connected flag goes stale and loss needs a round trip.
            self._cdp = self._browser.new_browser_cdp_session()
        except ToolError:
            raise
        except Exception as error:
            self._browser = None
            self._cdp = None
            self._drain()
            raise BrowserLost(
                "connect_over_cdp to " + str(self.endpoint) + " failed: " + str(error),
                self._transcript,
            )

    def _ping(self):
        """Bounded liveness probe against the CDP http endpoint: sync playwright
        pumps its loop only inside a call and a protocol send on a dead browser
        blocks forever, so liveness must be decided outside the transport."""
        if self._browser is None:
            return False
        try:
            with urllib.request.urlopen(self.endpoint + "/json/version", timeout=5):
                return True
        except Exception:
            return False


    def is_connected(self):
        return self._ping()

    def _lost(self, message):
        """Loss detection (#1275 clause 6): drop the client, attach the transcript."""
        self._shutdown(kill=False)
        _browser_clients.pop((self.machine_id, self.profile_dir), None)
        self._drain()
        return BrowserLost(message, self._transcript)

    def _alive(self):
        if not self._ping():
            raise self._lost("chromium exited or its CDP connection is gone")
        return self._browser

    def _reconnect(self):
        """A stale connection is discarded and re-attached over the retained
        endpoint; a dead Chromium surfaces as browser_lost, never a silent
        replacement launch against the same profile."""
        self._shutdown(kill=False)
        try:
            self._connect()
        except BrowserLost:
            _browser_clients.pop((self.machine_id, self.profile_dir), None)
            raise

    @property
    def browser(self):
        return self._alive()

    @property
    def contexts(self):
        return self._alive().contexts

    @property
    def context(self):
        contexts = self._alive().contexts
        if not contexts:
            raise self._lost("the connected chromium exposes no browser context")
        return contexts[0]

    @property
    def pages(self):
        return self.context.pages

    def _chromium_pid(self):
        """The launch line retains the browser pid in the session output; cells
        run on the same machine as the session (the localhost CDP assumption)."""
        found = re.findall(re.escape(_BROWSER_MARK) + r" chromium-pid (\d+)", self._transcript)
        return int(found[-1]) if found else self._browser_pid

    def _stop_chromium(self):
        """Builds that honor CDP Browser.close exit on it; this is the fallback
        that stops the browser process directly so nothing lingers. #1312: the
        failed step is reported, never swallowed."""
        pid = self._chromium_pid()
        if pid is None:
            return []
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError as exc:
            return [{"step": "kill_chromium", "error": repr(exc)}]
        return []

    def _shutdown(self, kill):
        """#1312: every cleanup step that fails is collected and returned as
        {ok, failed: [{step, error}]} — a typed outcome, never a silent pass."""
        failed = []
        browser = self._browser
        cdp = self._cdp
        self._browser = None
        self._cdp = None
        if kill and browser is not None:
            try:
                # Graceful end first; the launch line then exits the shell and
                # with it the owned tmux session.
                (cdp or browser.new_browser_cdp_session()).send("Browser.close")
            except Exception as exc:
                failed.append({"step": "browser_close_cdp", "error": repr(exc)})
        if browser is not None:
            try:
                browser.close()
            except Exception as exc:
                failed.append({"step": "browser_close", "error": repr(exc)})
        if kill:
            failed.extend(self._stop_chromium())
        return {"ok": not failed, "failed": failed}

    def close(self):
        """End Chromium and the owned tmux session; the profile dir is kept.
        #1312: returns the typed cleanup outcome so a cell sees what failed."""
        _browser_clients.pop((self.machine_id, self.profile_dir), None)
        outcome = self._shutdown(kill=True)
        self._drain()
        try:
            self._pty().close()
        except ToolError as exc:
            outcome["failed"].append({"step": "pty_close", "error": repr(exc)})
            outcome["ok"] = False
        return outcome


def browser(machine_id, *, headless=True, profile_dir=None, executable_path=None):
    """#1275 recipe: Chromium in a cell-owned tmux session, driven over CDP."""
    profile = (
        profile_dir
        if profile_dir is not None
        else os.path.join(os.getcwd(), ".oni", "browser-profile")
    )
    key = (machine_id, profile)
    client = _browser_clients.get(key)
    if client is not None:
        if client.headless != bool(headless):
            raise ToolError(
                "a live browser client for this profile is "
                + ("headless" if client.headless else "headed")
                + "; close() it before switching display modes"
            )
        if not client._ping():
            client._reconnect()
        return client
    client = BrowserClient(machine_id, profile, bool(headless))
    client._attach(executable_path)
    _browser_clients[key] = client
    return client


def _browser_close_all():
    """Interpreter close: stop each client's browser process directly (bounded,
    cannot block) so the owned tmux sessions end within the driver's exit
    grace; graceful CDP close belongs to client.close(). Persistent profiles
    are never deleted."""
    failed = []
    for _client in list(_browser_clients.values()):
        failed.extend(_client._stop_chromium())
        _tmux = ["tmux"]
        if os.environ["ONI_TMUX_SOCKET"]:
            _tmux.extend(["-L", os.environ["ONI_TMUX_SOCKET"]])
        try:
            subprocess.run(
                [*_tmux, "kill-session", "-t", "=" + _client.session],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                timeout=0.5,
            )
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            failed.append({"step": "tmux_kill_session", "error": repr(exc)})
        _client._browser = None
        _client._cdp = None
    _browser_clients.clear()
    instance = _browser_playwright["instance"]
    _browser_playwright["instance"] = None
    if instance is not None:
        try:
            instance.stop()
        except Exception as exc:
            failed.append({"step": "playwright_stop", "error": repr(exc)})
    return failed

tool = _Tools()
_scope = {
    "__name__": "__main__",
    "tool": tool,
    "ToolError": ToolError,
    "parallel": parallel,
    "completion": completion,
    "tool_output": tool_output,
    "machine": machine,
    "codemode": _Codemode(),
    "browser": browser,
    "BrowserLost": BrowserLost,
}
threading.Thread(target=_read_stdin, name="driver-stdin", daemon=True).start()

# One executor loop keeps cells serial while tool calls made by pool threads
# can independently wait for their callId-routed answers.
while True:
    _request = _cell_requests.get()
    if _request is None:
        break
    _cell_context.cell_id = _request["cellId"]
    _stdout = _Output(_request["cellId"], "stdout")
    _stderr = _Output(_request["cellId"], "stderr")
    _filename = f"<cell {_request['cellId']}>"
    try:
        with contextlib.redirect_stdout(_stdout), contextlib.redirect_stderr(_stderr):
            _tree = ast.parse(_request["code"], filename=_filename, mode="exec")
            _value = None
            _has_value = False
            if _tree.body and isinstance(_tree.body[-1], ast.Expr):
                _body = ast.Module(body=_tree.body[:-1], type_ignores=_tree.type_ignores)
                if _body.body:
                    exec(compile(_body, _filename, "exec"), _scope)
                _value = eval(compile(ast.Expression(_tree.body[-1].value), _filename, "eval"), _scope)
                # A trailing expression evaluating to None reports no value, matching
                # the REPL convention that None is not worth echoing.
                _has_value = _value is not None
            else:
                exec(compile(_tree, _filename, "exec"), _scope)
        _result = {
            "status": "completed",
            "cellId": _request["cellId"],
            "output": _cell_output(_stdout, _stderr),
        }
        if _has_value:
            _result["value"] = repr(_value)
    except BaseException as _exc:
        # Drop this driver's own exec/eval frame so the reported traceback starts
        # at the caller's code rather than at the harness that ran it.
        _tb = _exc.__traceback__.tb_next if _exc.__traceback__ else None
        _result = {
            "status": "raised",
            "cellId": _request["cellId"],
            "output": _cell_output(_stdout, _stderr),
            "error": "".join(traceback.format_exception(type(_exc), _exc, _tb)),
        }
    _cell_context.cell_id = None
    _emit({"kind": "result", "result": _result})
_emit({"kind": "lifecycle", "event": "browser-cleanup-complete", "failed": _browser_close_all()})
