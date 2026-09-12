import copy
from pathlib import Path
import subprocess
import tempfile
import unittest

import manage


class DeploymentBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def operation(self, name):
        operation = getattr(manage, name, None)
        self.assertTrue(callable(operation), f"{name} must be implemented")
        return operation

    def test_secrets_are_private_and_preparation_preserves_identity(self):
        write = self.operation("write_secret")
        path = self.root / "subject-secret"
        write(path, "first-identity")
        write(path, "replacement-must-not-win")
        self.assertEqual(path.read_text().strip(), "first-identity")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_secret_symlink_does_not_overwrite_target(self):
        write = self.operation("write_secret")
        target = self.root / "target"
        target.write_text("untouched")
        path = self.root / "subject-secret"
        path.symlink_to(target)
        with self.assertRaises(ValueError):
            write(path, "replacement")
        self.assertEqual(target.read_text(), "untouched")

    def test_insecure_secret_and_directory_permissions_are_rejected(self):
        check = self.operation("check_private")
        path = self.root / "key"
        path.write_text("secret")
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            check(path)
        path.chmod(0o600)
        check(path)
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            check(self.root, directory=True)

    def test_failed_backup_preserves_last_good_copy(self):
        backup = self.operation("atomic_backup")
        old = self.root / "tarororo-20260911T000000000000Z.dump"
        old.write_bytes(b"good backup")
        def failing(output):
            output.write(b"partial")
            raise RuntimeError("pg_dump failed")
        with self.assertRaises(RuntimeError):
            backup(self.root, failing)
        self.assertEqual(old.read_bytes(), b"good backup")
        self.assertEqual(list(self.root.iterdir()), [old])

    def test_successful_backup_is_private_and_retains_seven(self):
        backup = self.operation("atomic_backup")
        for i in range(9):
            (self.root / f"tarororo-202608{i + 1:02}T000000000000Z.dump").write_bytes(b"old")
        path = backup(self.root, lambda output: output.write(b"valid custom dump"))
        self.assertEqual(path.read_bytes(), b"valid custom dump")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.root.glob("*.dump"))), 7)

    def test_backup_rotation_never_follows_symlinks(self):
        backup = self.operation("atomic_backup")
        outside = self.root / "outside"
        outside.write_bytes(b"do not delete")
        link = self.root / "tarororo-20000101T000000000000Z.dump"
        link.symlink_to(outside)
        backup(self.root, lambda output: output.write(b"new dump"))
        self.assertEqual(outside.read_bytes(), b"do not delete")
        self.assertTrue(link.is_symlink())

    def test_empty_dump_is_not_promoted(self):
        backup = self.operation("atomic_backup")
        with self.assertRaises(ValueError):
            backup(self.root, lambda output: None)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_certificate_pair_and_missing_key(self):
        validate = self.operation("validate_certificate")
        cert, key = self.root / "client.crt", self.root / "client.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "3",
                        "-subj", "/CN=local-test-fixture"], check=True, capture_output=True)
        cert.chmod(0o600)
        key.chmod(0o600)
        validate(cert, key)
        wrong = self.root / "wrong.key"
        subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-out", str(wrong),
                        "-pkeyopt", "rsa_keygen_bits:2048"], check=True, capture_output=True)
        wrong.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "match"):
            validate(cert, wrong)
        with self.assertRaises(ValueError):
            validate(cert, self.root / "missing.key")

    def test_public_deployment_refuses_mock_wildcards_and_public_database(self):
        validate = self.operation("validate_definition")
        valid = {"services": {
            "api": {"environment": {"APP_ENV": "test", "AUTH_MODE": "toss", "ALLOWED_ORIGINS": manage.ORIGIN},
                    "ports": [{"host_ip": "127.0.0.1", "target": 3000, "published": "3200"}],
                    "secrets": [{"source": name} for name in ["db-password", "subject-secret", "toss-client.crt", "toss-client.key"]]},
            "db": {},
            "worker": {"secrets": [{"source": name} for name in ["db-password", "gemini-api-key"]]},
        }}
        validate(valid)
        for field, value in [("AUTH_MODE", "mock"), ("APP_ENV", "local"), ("ALLOWED_ORIGINS", "*")]:
            changed = copy.deepcopy(valid)
            changed["services"]["api"]["environment"][field] = value
            with self.assertRaises(ValueError):
                validate(changed)

        for change in ["db_port", "api_bind", "api_key", "worker_secret"]:
            changed = copy.deepcopy(valid)
            if change == "db_port":
                changed["services"]["db"]["ports"] = [{"published": "5432"}]
            elif change == "api_bind":
                changed["services"]["api"]["ports"][0]["host_ip"] = "0.0.0.0"
            elif change == "api_key":
                changed["services"]["api"]["secrets"].append({"source": "gemini-api-key"})
            else:
                changed["services"]["worker"]["secrets"].append({"source": "subject-secret"})
            with self.assertRaises(ValueError):
                validate(changed)

    def test_expired_certificate_is_rejected(self):
        validate = self.operation("validate_certificate")
        cert, key = self.root / "client.crt", self.root / "client.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "3",
                        "-subj", "/CN=expired-fixture"], check=True, capture_output=True)
        expired = self.root / "expired.crt"
        subprocess.run(["openssl", "x509", "-in", str(cert), "-signkey", str(key),
                        "-days", "0", "-out", str(expired)], check=True, capture_output=True)
        key.chmod(0o600)
        expired.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "expires"):
            validate(expired, key)


if __name__ == "__main__":
    unittest.main()
