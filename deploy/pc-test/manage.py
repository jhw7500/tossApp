"""Manage the isolated Tarororo PC test deployment (Python standard library only)."""

import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy/pc-test"
ORIGIN = "https://tarororo.private-apps.tossmini.com"
DUMP_NAME = re.compile(r"tarororo-\d{8}T\d{12}Z\.dump")


def validate_definition(definition):
    services = definition["services"]
    api = services["api"]
    environment = api["environment"]
    if any(environment.get(k) != v for k, v in {"APP_ENV": "test", "AUTH_MODE": "toss", "ALLOWED_ORIGINS": ORIGIN}.items()):
        raise ValueError("Test deployment requires real Toss authentication and the exact QR Origin")
    ports = api.get("ports", [])
    if len(ports) != 1 or any(ports[0].get(k) != v for k, v in {"host_ip": "127.0.0.1", "target": 3000, "published": "3200"}.items()):
        raise ValueError("API must only bind to 127.0.0.1:3200")
    if services["db"].get("ports"):
        raise ValueError("Database ports must not be published")
    for role, names in {"api": {"db-password", "subject-secret", "toss-client.crt", "toss-client.key"},
                        "worker": {"db-password", "gemini-api-key"}}.items():
        if {secret["source"] for secret in services[role].get("secrets", [])} != names:
            raise ValueError(f"Unexpected secrets for {role}")
    if "GEMINI_API_KEY" in environment:
        raise ValueError("Gemini key must not be passed to the API")


def check_private(path, directory=False):
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise ValueError(f"Required {'directory' if directory else 'file'} missing: {path}") from None
    expected = 0o700 if directory else 0o600
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_type or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != expected:
        raise ValueError(f"Require owned {'directory' if directory else 'regular file'} mode {expected:o}: {path}")
    for parent in path.parents:
        if parent.is_symlink():
            raise ValueError(f"Symlink parent is not allowed: {parent}")


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    check_private(path, directory=True)


def write_secret(path, value):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        check_private(path)
        return
    with os.fdopen(fd, "w") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(value.strip() + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    check_private(path)


def validate_certificate(cert, key):
    check_private(cert)
    check_private(key)
    def openssl(*args):
        result = subprocess.run(["openssl", *args], capture_output=True, timeout=10)
        if result.returncode:
            raise ValueError("Certificate/key unreadable, invalid, or expires within 24 hours")
        return result.stdout
    openssl("x509", "-in", str(cert), "-checkend", "86400", "-noout")
    start = openssl("x509", "-in", str(cert), "-startdate", "-noout").decode().strip().split("=", 1)[1]
    if ssl.cert_time_to_seconds(start) > time.time():
        raise ValueError("Certificate is not yet valid")
    cert_public = openssl("x509", "-in", str(cert), "-pubkey", "-noout")
    key_public = openssl("pkey", "-in", str(key), "-passin", "pass:", "-pubout")
    if cert_public != key_public:
        raise ValueError("Certificate and private key do not match")


def atomic_backup(directory, producer):
    fd, temporary = tempfile.mkstemp(prefix=".backup-", dir=directory)
    temporary = Path(temporary)
    final = directory / ("tarororo-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".dump")
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            producer(stream)
            stream.flush()
            os.fsync(stream.fileno())
        if temporary.stat().st_size == 0:
            raise ValueError("Empty backup; last successful backups are retained")
        temporary.rename(final)
        dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
        backups = sorted(p for p in directory.iterdir()
                         if DUMP_NAME.fullmatch(p.name) and not p.is_symlink()
                         and p.is_file() and p.stat().st_uid == os.getuid())
        for old in backups[:-7]:
            old.unlink()
        return final
    finally:
        temporary.unlink(missing_ok=True)


class Deployment:
    def __init__(self):
        self.config = Path(os.environ.get("TARORORO_TEST_CONFIG", Path.home() / ".config/tarororo-test")).absolute()
        self.state = Path(os.environ.get("TARORORO_TEST_STATE", Path.home() / ".local/share/tarororo-test")).absolute()
        for path in (self.config, self.state):
            repository = ROOT.parents[1] if ROOT.parent.name == ".worktrees" else ROOT
            if path.is_relative_to(repository) or path == Path.home():
                raise ValueError("Deployment config/state must be dedicated directories outside the repository")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
        self.env.update(TARORORO_CONFIG_DIR=str(self.config), TARORORO_UID=str(os.getuid()), TARORORO_GID=str(os.getgid()))

    def compose(self, *args, **kwargs):
        return subprocess.run(["docker", "compose", "--project-name", "tarororo-test",
                               "--env-file", "/dev/null", "--file", str(DEPLOY / "compose.yaml"), *args],
                              env=self.env, check=True, **kwargs)

    def prepare(self):
        private_directory(self.config)
        private_directory(self.state)
        private_directory(self.state / "backups")
        write_secret(self.config / "db-password", secrets.token_hex(32))
        write_secret(self.config / "subject-secret", secrets.token_hex(32))
        if os.environ.get("GEMINI_API_KEY", "").strip():
            write_secret(self.config / "gemini-api-key", os.environ["GEMINI_API_KEY"])
        print(f"Private configuration prepared: {self.config}")

    def check(self, full=True):
        check_private(self.config, directory=True)
        for name in (["db-password", "subject-secret", "gemini-api-key"] if full else ["db-password"]):
            path = self.config / name
            check_private(path)
            if len(path.read_text().strip()) < (32 if name != "gemini-api-key" else 10):
                raise ValueError(f"Secret is missing or too short: {name}")
        definition = json.loads(self.compose("config", "--format", "json", capture_output=True).stdout)
        validate_definition(definition)
        if full:
            validate_certificate(self.config / "toss-client.crt", self.config / "toss-client.key")
        print("Configuration checked" + (" (certificate format/key pair only; live Toss verification still required)" if full else " (database only)"))

    def init_db(self):
        self.check(full=False)
        self.compose("up", "-d", "--wait", "--wait-timeout", "60", "db")
        self.compose("run", "--rm", "--no-deps", "migrate")

    def start(self):
        self.check()
        self.init_db()
        self.compose("up", "-d", "--wait", "--wait-timeout", "60", "api", "worker")
        print("Local API ready: http://127.0.0.1:3200/health/ready; worker processing must be verified separately")

    def start_worker(self):
        self.check(full=False)
        check_private(self.config / "gemini-api-key")
        if not (self.config / "gemini-api-key").read_text().strip():
            raise ValueError("Gemini key is empty")
        self.compose("up", "-d", "--wait", "--wait-timeout", "60", "worker")
        print("Worker started; public API remains separately gated by the Toss certificate")

    def backup(self):
        self.check(full=False)
        check_private(self.state, directory=True)
        directory = self.state / "backups"
        check_private(directory, directory=True)
        lock = self.state / "backup.lock"
        write_secret(lock, "backup lock")
        with lock.open("r+") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = atomic_backup(directory, lambda output: self.compose(
                "exec", "-T", "db", "pg_dump", "-U", "tarororo", "-d", "tarororo_test", "-Fc", stdout=output))
        print(path)
        return path

    def sql(self, database, query):
        return self.compose("exec", "-T", "db", "psql", "-X", "-U", "tarororo", "-d", database,
                            "-v", "ON_ERROR_STOP=1", "-At", "-c", query, capture_output=True).stdout.decode().strip()

    def restore_check(self, path=None):
        self.check(full=False)
        candidates = sorted((self.state / "backups").glob("tarororo-*.dump"))
        if path is None and not candidates:
            raise ValueError("No backup is available")
        path = Path(path) if path else candidates[-1]
        check_private(path)
        database = "tarororo_restore_" + uuid4().hex
        self.compose("exec", "-T", "db", "createdb", "-U", "tarororo", database)
        try:
            with path.open("rb") as stream:
                self.compose("exec", "-T", "db", "pg_restore", "-U", "tarororo", "-d", database,
                             "--exit-on-error", "--single-transaction", stdin=stream, stdout=subprocess.DEVNULL)
            counts = self.sql(database, "SELECT json_build_object('migrations',(SELECT count(*) FROM schema_migrations),"
                              "'cards',(SELECT count(*) FROM tarot_cards),'persons',(SELECT count(*) FROM persons),"
                              "'readings',(SELECT count(*) FROM readings),"
                              "'interpretation_versions',(SELECT count(*) FROM interpretation_versions));")
            if json.loads(counts)["migrations"] < 3:
                raise ValueError("Restored schema is incomplete")
            print("Restore verified (pg_restore revalidated constraints): " + counts)
        finally:
            self.compose("exec", "-T", "db", "dropdb", "-U", "tarororo", database)

    def install_backup_timer(self):
        self.check(full=False)
        # systemd quoting is not shell quoting; escape specifiers and reject newlines.
        def quote(value):
            value = str(value)
            if "\n" in value or "\r" in value:
                raise ValueError("Newline in systemd path")
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'
        unit_dir = Path.home() / ".config/systemd/user"
        unit_dir.mkdir(parents=True, exist_ok=True)
        service = "[Unit]\nDescription=Tarororo test database backup\n\n[Service]\nType=oneshot\nUMask=0077\n"
        service += "Environment=" + quote("TARORORO_TEST_CONFIG=" + str(self.config)) + "\n"
        service += "Environment=" + quote("TARORORO_TEST_STATE=" + str(self.state)) + "\n"
        service += "ExecStart=/usr/bin/python3 " + quote(DEPLOY / "manage.py") + " backup\n"
        timer = "[Unit]\nDescription=Daily Tarororo test backup\n\n[Timer]\nOnCalendar=*-*-* 04:00:00\nPersistent=true\nRandomizedDelaySec=300\n\n[Install]\nWantedBy=timers.target\n"
        for name, content in {"tarororo-test-backup.service": service, "tarororo-test-backup.timer": timer}.items():
            path = unit_dir / name
            if path.is_symlink():
                raise ValueError(f"Refuse symlink unit: {path}")
            path.write_text(content)
            path.chmod(0o600)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "tarororo-test-backup.timer"], check=True)
        subprocess.run(["loginctl", "show-user", str(os.getuid()), "-p", "Linger"], check=True)

    def publish(self):
        self.check()
        container_id = self.compose("ps", "-q", "api", capture_output=True).stdout.decode().strip()
        if not container_id:
            raise ValueError("Start the test API before publishing")
        container = json.loads(subprocess.run(["docker", "inspect", container_id], check=True, capture_output=True).stdout)[0]
        environment = dict(item.split("=", 1) for item in container["Config"]["Env"] if "=" in item)
        if environment.get("AUTH_MODE") != "toss" or environment.get("APP_ENV") != "test":
            raise ValueError("Running container authentication does not match the approved deployment")
        bindings = container["NetworkSettings"]["Ports"].get("3000/tcp")
        if bindings != [{"HostIp": "127.0.0.1", "HostPort": "3200"}]:
            raise ValueError("Running container does not own the expected local port")
        with urlopen("http://127.0.0.1:3200/health/ready", timeout=5) as response:
            if json.load(response) != {"status": "ready"}:
                raise ValueError("API is not ready")
        current = json.loads(subprocess.run(["tailscale", "serve", "status", "--json"], check=True, capture_output=True).stdout)
        if current:
            raise ValueError("Existing Serve/Funnel configuration detected; inspect it before changing the public endpoint")
        subprocess.run(["tailscale", "funnel", "--bg", "--https=443", "http://127.0.0.1:3200"], check=True, timeout=45)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "build", "init-db", "seed", "check", "start", "start-worker", "status",
                                           "backup", "restore-check", "install-backup-timer", "publish"])
    parser.add_argument("backup_path", nargs="?")
    args = parser.parse_args()
    deployment = Deployment()
    if args.command == "build":
        deployment.check(full=False)
        deployment.compose("build", "api")
    elif args.command == "seed":
        deployment.check(full=False)
        deployment.compose("run", "--rm", "--no-deps", "seed")
    elif args.command == "status":
        deployment.compose("ps", "--all")
        subprocess.run(["systemctl", "--user", "list-timers", "tarororo-test-backup.timer", "--no-pager"], check=True)
        subprocess.run(["tailscale", "funnel", "status"], check=True)
    elif args.command == "restore-check":
        deployment.restore_check(args.backup_path)
    else:
        getattr(deployment, args.command.replace("-", "_"))()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Deployment stopped: {error}", file=sys.stderr)
        sys.exit(1)
