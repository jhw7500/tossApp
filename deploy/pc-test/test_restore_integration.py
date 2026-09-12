"""Opt-in restore regression against the isolated PC test PostgreSQL container."""

import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import manage


@unittest.skipUnless(os.environ.get("TARORORO_RESTORE_INTEGRATION") == "1",
                     "Requires the PC test DB; set TARORORO_RESTORE_INTEGRATION=1")
class RestoreIntegration(unittest.TestCase):
    def setUp(self):
        self.deployment = manage.Deployment()
        self.deployment.check(full=False)
        directory = tempfile.TemporaryDirectory(prefix="tarororo-restore-regression-")
        self.addCleanup(directory.cleanup)
        self.dump = Path(directory.name) / "fixture.dump"
        self.database = "tarororo_restore_fixture_" + uuid4().hex
        self.deployment.compose("exec", "-T", "db", "createdb", "-U", "tarororo",
                                self.database, capture_output=True)
        self.addCleanup(self.deployment.compose, "exec", "-T", "db", "dropdb", "-U", "tarororo",
                        self.database, capture_output=True)
        statements = ["BEGIN;"]
        for path in sorted((manage.ROOT / "server/migrations").glob("*.sql")):
            statements.append(path.read_text())
            checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            statements.append(f"INSERT INTO schema_migrations (name,checksum) VALUES ('{path.name}','{checksum}');")
        statements.append("COMMIT;")
        self.deployment.sql(self.database, "\n".join(statements))

    def verify_dump(self, accepted):
        fd = os.open(self.dump, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            self.deployment.compose("exec", "-T", "db", "pg_dump", "-U", "tarororo", "-d",
                                    self.database, "-Fc", stdout=output)
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            if accepted:
                self.deployment.restore_check(self.dump)
                self.assertIn("Restore verified", output.getvalue())
            else:
                with self.assertRaisesRegex(ValueError, "catalog"):
                    self.deployment.restore_check(self.dump)
                self.assertNotIn("Restore verified", output.getvalue())

    def test_restore_requires_usable_catalog(self):
        self.verify_dump(accepted=False)
        question = str(uuid4())
        self.deployment.sql(self.database,
            "INSERT INTO relationship_types (code,label,sort_order) VALUES ('friendship','Fixture relationship',1);"
            "INSERT INTO questions (id,relationship_code,prompt,sort_order) VALUES "
            f"('{question}','friendship','Fixture question',1);")
        for position in range(1, 4):
            self.deployment.sql(self.database,
                "INSERT INTO card_positions (id,question_id,position,label) VALUES "
                f"('{uuid4()}','{question}',{position},'Fixture position');")
        interpretations = []
        for index in range(3):
            card, interpretation = str(uuid4()), str(uuid4())
            interpretations.append(interpretation)
            self.deployment.sql(self.database,
                f"INSERT INTO tarot_cards (id,code,name,arcana) VALUES "
                f"('{card}','fixture-{index}','Restore regression fixture','major');"
                f"INSERT INTO interpretations (id,tarot_card_id) VALUES ('{interpretation}','{card}');")
        # Literal whitespace fixtures, independent of the production SQL predicate.
        cases = [("", False), (" \t\r\n\v\f", False),
                 ("\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009"
                  "\u200a\u2028\u2029\u202f\u205f\u3000\ufeff", False),
                 (" \u00a0시험 해석\ufeff\n", True)]
        for version, (content, accepted) in enumerate(cases, start=1):
            with self.subTest(content=repr(content), accepted=accepted):
                statements = ["BEGIN;"]
                for interpretation in interpretations:
                    statements.append("INSERT INTO interpretation_versions "
                        "(id,interpretation_id,version,content,source_kind,source_attribution) VALUES "
                        f"('{uuid4()}','{interpretation}',{version},"
                        f"convert_from(decode('{content.encode().hex()}','hex'),'UTF8'),"
                        "'synthetic_test','restore regression fixture');"
                        f"UPDATE interpretations SET active_version={version} WHERE id='{interpretation}';")
                statements.append("COMMIT;")
                self.deployment.sql(self.database, "\n".join(statements))
                self.verify_dump(accepted)
        for missing, query in [
                ("valid relationship code", "INSERT INTO relationship_types (code,label,sort_order) "
                 "VALUES ('','Unsupported fixture',2); UPDATE questions SET relationship_code=''"),
                ("active question", "UPDATE questions SET relationship_code='friendship', is_active=false"),
                ("third position", "UPDATE questions SET is_active=true; DELETE FROM card_positions WHERE position=3"),
                ("question", "DELETE FROM questions"),
                ("relationship", "DELETE FROM relationship_types")]:
            with self.subTest(missing=missing):
                self.deployment.sql(self.database, query)
                self.verify_dump(accepted=False)


if __name__ == "__main__":
    unittest.main()
