import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("stock_project", Path(__file__).with_name("configure-stock-project.py"))
project = importlib.util.module_from_spec(spec)
spec.loader.exec_module(project)

PROJECT_ID = "0b8a3ded-4489-4722-afd1-1d82e64ec2d5"
OTHER_ID = "11111111-1111-4111-8111-111111111111"
COMPOSE_PROJECT = "launchpad-e2b-stock-0123456789abcdef"


class StockProjectTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        for name in project.COMPOSE_FILES:
            (self.root / name).write_text(name)
        self.receipt = {"schemaVersion": 1, "sourceCommit": project.SOURCE_COMMIT,
                        "composeProject": COMPOSE_PROJECT,
                        "configurationSha256": {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest()
                                                for name in project.COMPOSE_FILES}}
        self.write_receipt()
        self.containers = [self.container("postgres", "a" * 64, True),
                           self.container("api", "b" * 64, False),
                           self.container("dashboard-api", "c" * 64, False)]
        self.executions = []
        self.report_hours = 720

    def write_receipt(self):
        (self.root / "build.json").write_text(json.dumps(self.receipt))

    def container(self, role, identity, running):
        return {"Id": identity, "Config": {"Labels": {"com.docker.compose.project": COMPOSE_PROJECT,
                                                     "com.docker.compose.service": role}},
                "State": {"Running": running}}

    def docker(self, *args, input=None):
        if args[0:2] == ("docker", "compose"):
            return "\n".join(row["Id"] for row in self.containers)
        if args[0:2] == ("docker", "inspect"):
            return json.dumps(self.containers)
        self.executions.append((args, input))
        return json.dumps({"projectId": PROJECT_ID, "diskMb": 32768,
                           "maxLengthHours": self.report_hours})

    def test_configuration_uses_only_the_receipt_owned_postgres_and_defaults_to_thirty_days(self):
        with patch.object(project, "run", side_effect=self.docker):
            self.assertEqual(project.configure(self.root, PROJECT_ID),
                             {"projectId": PROJECT_ID, "diskMb": 32768,
                              "maxLengthHours": 720})
        self.assertEqual(len(self.executions), 1)
        self.assertEqual(self.executions[0][0][:4], ("docker", "exec", "--interactive", "a" * 64))

    def test_lifetime_bounds_are_configurable_and_verified_in_the_database_report(self):
        for hours in (1, 8760):
            with self.subTest(hours=hours):
                self.report_hours = hours
                with patch.object(project, "run", side_effect=self.docker):
                    self.assertEqual(project.configure(self.root, PROJECT_ID, hours)["maxLengthHours"], hours)
        self.report_hours = 24
        with patch.object(project, "run", side_effect=self.docker):
            with self.assertRaisesRegex(ValueError, "could not be confirmed"):
                project.configure(self.root, PROJECT_ID)

    def test_invalid_lifetime_never_contacts_docker(self):
        for hours in (0, -1, 8761, True, False, 720.0, "720", None):
            with self.subTest(hours=hours), patch.object(project, "run") as command:
                with self.assertRaisesRegex(ValueError, "integer from 1 to 8760"):
                    project.configure(self.root, PROJECT_ID, hours)
                command.assert_not_called()

    def test_invalid_uuid_or_receipt_never_contacts_docker(self):
        for identity in ("all", "' OR true; --", str(__import__("uuid").UUID(int=0))):
            with self.subTest(identity=identity), patch.object(project, "run") as command:
                with self.assertRaises(ValueError):
                    project.configure(self.root, identity)
                command.assert_not_called()
        for key, value in (("schemaVersion", 2), ("sourceCommit", "unknown"), ("composeProject", "other")):
            with self.subTest(key=key):
                before = self.receipt[key]
                self.receipt[key] = value
                self.write_receipt()
                with patch.object(project, "run") as command:
                    with self.assertRaises(ValueError):
                        project.configure(self.root, PROJECT_ID)
                    command.assert_not_called()
                self.receipt[key] = before
                self.write_receipt()

    def test_changed_compose_configuration_never_contacts_docker(self):
        (self.root / "compose.override.yaml").write_text("different deployment")
        with patch.object(project, "run") as command:
            with self.assertRaisesRegex(ValueError, "Compose files"):
                project.configure(self.root, PROJECT_ID)
            command.assert_not_called()

    def test_refuses_foreign_or_active_services_before_any_database_write(self):
        for role in ("api", "dashboard-api"):
            with self.subTest(role=role):
                self.containers = [self.container("postgres", "a" * 64, True),
                                   self.container(role, "b" * 64, True)]
                with patch.object(project, "run", side_effect=self.docker):
                    with self.assertRaisesRegex(ValueError, "before starting"):
                        project.configure(self.root, PROJECT_ID)
                self.assertEqual(self.executions, [])
        self.containers = [self.container("postgres", "a" * 64, True)]
        self.containers[0]["Config"]["Labels"]["com.docker.compose.project"] = "foreign"
        with patch.object(project, "run", side_effect=self.docker):
            with self.assertRaisesRegex(ValueError, "does not belong"):
                project.configure(self.root, PROJECT_ID)
        self.assertEqual(self.executions, [])

    def test_refuses_missing_or_ambiguous_postgres(self):
        for rows in ([], [self.container("postgres", "a" * 64, False)],
                     [self.container("postgres", "a" * 64, True), self.container("postgres", "b" * 64, True)]):
            with self.subTest(rows=rows):
                self.containers = rows
                with patch.object(project, "run", side_effect=self.docker):
                    with self.assertRaises(ValueError):
                        project.configure(self.root, PROJECT_ID)
                self.assertEqual(self.executions, [])


@unittest.skipUnless(os.environ.get("STOCK_PROJECT_TEST_CONTAINER") and os.environ.get("STOCK_PROJECT_TEST_TOKEN"),
                     "requires a separate labelled RAM-backed PostgreSQL fixture")
class StockProjectSqlTests(unittest.TestCase):
    def test_native_sql_is_scoped_idempotent_and_preserves_other_limits_and_revision(self):
        identity, token = os.environ["STOCK_PROJECT_TEST_CONTAINER"], os.environ["STOCK_PROJECT_TEST_TOKEN"]
        self.assertRegex(identity, r"^[a-f0-9]{64}$")
        records = json.loads(subprocess.check_output(["docker", "inspect", identity], text=True))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["Config"]["Labels"].get("io.launchpad.stock-project-limits-fixture"), token)
        self.assertIn("POSTGRES_DB=stock_project_fixture", records[0]["Config"]["Env"])

        def sql(statement, check=True):
            return subprocess.run(["docker", "exec", "--interactive", identity, "psql", "-X", "--quiet",
                                   "--tuples-only", "--no-align", "--no-password", "--set", "ON_ERROR_STOP=1",
                                   "--username", "postgres", "--dbname", "stock_project_fixture"],
                                  input=statement, capture_output=True, text=True, check=check)

        sql("""
CREATE TABLE teams(id uuid PRIMARY KEY);
CREATE TABLE envs(team_id uuid);
CREATE TABLE default_limits(max_length_hours bigint,concurrent_sandboxes bigint,concurrent_template_builds bigint,
 max_vcpu bigint,max_ram_mb bigint,disk_mb bigint,events_ttl_days bigint,default_free_disk_size_mb bigint,
 max_disk_size_mb bigint,api_team_rps_list bigint,api_team_rps_delete bigint,max_secrets bigint);
INSERT INTO default_limits VALUES(24,20,1,8,8192,10240,7,10240,51200,10,100,20);
CREATE TABLE project_limits(LIKE default_limits INCLUDING ALL);
ALTER TABLE project_limits ADD COLUMN team_id uuid PRIMARY KEY REFERENCES teams(id),
 ADD COLUMN max_free_disk_size_mb bigint;
CREATE SCHEMA projection;
CREATE TABLE projection.project_limits(project_id uuid PRIMARY KEY,revision bigint);
INSERT INTO teams VALUES('""" + PROJECT_ID + """'),('""" + OTHER_ID + """');
INSERT INTO project_limits SELECT d.*,'""" + OTHER_ID + """'::uuid,51200 FROM default_limits d;
INSERT INTO projection.project_limits VALUES('""" + PROJECT_ID + """',7);
""")
        foreign_before = sql(f"SELECT row_to_json(p) FROM project_limits p WHERE team_id='{OTHER_ID}';").stdout
        first = json.loads(sql(project.project_limits_sql(PROJECT_ID)).stdout)
        self.assertEqual(first, {"projectId": PROJECT_ID, "diskMb": 32768,
                                 "maxLengthHours": 720})
        sql(f"UPDATE project_limits SET disk_mb=8192,max_length_hours=71,max_secrets=3 WHERE team_id='{PROJECT_ID}';")
        before = json.loads(sql(f"SELECT row_to_json(p) FROM project_limits p WHERE team_id='{PROJECT_ID}';").stdout)
        self.assertEqual(json.loads(sql(project.project_limits_sql(PROJECT_ID, 48)).stdout)["maxLengthHours"], 48)
        before = {**before, "disk_mb": 32768, "max_length_hours": 48}
        self.assertEqual(before, json.loads(sql(f"SELECT row_to_json(p) FROM project_limits p WHERE team_id='{PROJECT_ID}';").stdout))
        self.assertEqual(json.loads(sql(project.project_limits_sql(PROJECT_ID, 48)).stdout)["maxLengthHours"], 48)
        self.assertEqual(before, json.loads(sql(f"SELECT row_to_json(p) FROM project_limits p WHERE team_id='{PROJECT_ID}';").stdout))
        self.assertEqual(foreign_before, sql(f"SELECT row_to_json(p) FROM project_limits p WHERE team_id='{OTHER_ID}';").stdout)
        self.assertEqual(sql("SELECT revision FROM projection.project_limits;").stdout.strip(), "7")

        for mutate, restore in (("DELETE FROM default_limits;", "INSERT INTO default_limits VALUES(24,20,1,8,8192,10240,7,10240,51200,10,100,20);"),
                                ("INSERT INTO default_limits SELECT * FROM default_limits;", "DELETE FROM default_limits WHERE ctid NOT IN(SELECT ctid FROM default_limits LIMIT 1);"),
                                (f"INSERT INTO envs VALUES('{PROJECT_ID}');", "TRUNCATE envs;")):
            sql(mutate)
            self.assertNotEqual(sql(project.project_limits_sql(PROJECT_ID), check=False).returncode, 0)
            self.assertEqual(before, json.loads(sql(f"SELECT row_to_json(p) FROM project_limits p WHERE team_id='{PROJECT_ID}';").stdout))
            sql(restore)
        self.assertNotEqual(sql(project.project_limits_sql("22222222-2222-4222-8222-222222222222"), check=False).returncode, 0)
        sql("ALTER TABLE project_limits DROP COLUMN max_secrets;")
        self.assertNotEqual(sql(project.project_limits_sql(PROJECT_ID), check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
