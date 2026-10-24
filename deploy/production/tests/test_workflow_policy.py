import importlib.util
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("workflow_policy", Path(__file__).parents[1] / "workflow_policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def repository():
    return {file.name: file.read_text() for file in WORKFLOWS.glob("*.yml")}


class WorkflowPolicyTests(unittest.TestCase):
    def test_repository_workflows_follow_the_release_policy(self):
        workflows = repository()
        self.assertEqual(policy.errors(workflows), [])
        self.assertNotIn("staging.yml", workflows)
        self.assertEqual(policy.triggers(workflows["ci.yml"]), {"push", "pull_request"})

    def test_rejects_a_deployment_started_by_a_push(self):
        workflows = repository()
        workflows["production.yml"] = workflows["production.yml"].replace("on:\n", "on:\n  push:\n    branches: [main]\n", 1)
        self.assertTrue(any("starts automatically on push" in e for e in policy.errors(workflows)))
        for trigger in ("on: [push]", "on: push", '"on": push', "'on': [push, workflow_dispatch]"):
            extra = dict(repository(), **{"auto.yml": f"{trigger}\njobs:\n  deploy:\n    uses: ./.github/workflows/release.yml\n"})
            self.assertIn("auto.yml: deploys but starts automatically on push", policy.errors(extra), trigger)

    def test_rejects_scheduled_or_chained_deployments(self):
        for trigger in ("schedule:\n    - cron: '0 1 * * *'", "workflow_run:\n    workflows: [CI]"):
            extra = dict(repository(), **{"auto.yml": f"on:\n  {trigger}\njobs:\n  deploy:\n    uses: ./.github/workflows/release.yml\n"})
            self.assertTrue(any(e.startswith("auto.yml: deploys but starts automatically") for e in policy.errors(extra)))

    def test_automatic_workflows_cannot_use_secrets_or_environments(self):
        for job in ("    env:\n      KEY: ${{ secrets.ANY_KEY }}\n", "    environment: production\n", "    env:\n      DEPLOY_HOST: ${{ vars.DEPLOY_HOST }}\n"):
            extra = dict(repository(), **{"auto.yml": f"on: push\njobs:\n  ship:\n    runs-on: ubuntu-24.04\n{job}    steps:\n      - run: true\n"})
            self.assertIn("auto.yml: deploys but starts automatically on push", policy.errors(extra), job)
        unreadable = dict(repository(), **{"auto.yml": "true:\n  push:\njobs:\n  deploy:\n    uses: ./.github/workflows/release.yml\n"})
        self.assertIn("auto.yml: deploys but its triggers cannot be read", policy.errors(unreadable))

    def test_requires_main_ci_evidence_approval_and_the_exact_commit(self):
        workflows = repository()
        for file, removed, message in [
            ("production.yml", "actions/workflows/ci.yml/runs", "successful CI run"),
            ("production.yml", "needs: ci-evidence", "successful CI run"),
            ("production.yml", "if: github.ref == 'refs/heads/main'", "part of main"),
            ("production.yml", "/compare/$RELEASE_SHA...$GITHUB_SHA", "part of main"),
            ("release.yml", "environment: production", "protected production environment"),
            ("release.yml", "actions/runs/$GITHUB_RUN_ID/approvals", "recorded a production approval"),
            ("release.yml", "ref: ${{ inputs.sha }}", "exact release commit"),
            ("release.yml", "git rev-parse HEAD", "exact release commit"),
        ]:
            changed = dict(workflows, **{file: workflows[file].replace(removed, "removed")})
            self.assertTrue(any(message in e for e in policy.errors(changed)), removed)
        # The SSH settings are checked against the pinned host key before any upload.
        release = workflows["release.yml"]
        check, upload = "run: bash deploy/production/check-ssh.sh", "run: bash deploy/production/remote.sh"
        swapped = release.replace(check, "@check@").replace(upload, check).replace("@check@", upload)
        self.assertGreater(swapped.find("check-ssh.sh"), swapped.find("remote.sh"))
        for changed in (release.replace("bash deploy/production/check-ssh.sh", "true"),
                        release.replace("TRUSTED_HOST_KEY: SHA256:", "TRUSTED_HOST_KEY: "),
                        swapped):
            self.assertIn("release.yml: must check the SSH host key against TRUSTED_HOST_KEY before uploading",
                          policy.errors(dict(workflows, **{"release.yml": changed})))
        # The environment must be named literally, not chosen by the caller.
        release = workflows["release.yml"].replace("    environment: production", "    environment: ${{ inputs.environment }}")
        self.assertIn("release.yml: must deploy through the protected production environment",
                      policy.errors(dict(workflows, **{"release.yml": release})))

    def test_rejects_any_staging_deployment(self):
        workflows = dict(repository(), **{"staging.yml": "on:\n  workflow_dispatch:\njobs:\n  deploy:\n    uses: ./.github/workflows/release.yml\n    with:\n      environment: staging\n"})
        self.assertIn("staging.yml: refers to staging; production is the only environment", policy.errors(workflows))
        release = repository()["release.yml"].replace("    environment: production", "    environment: staging")
        errors = policy.errors(dict(repository(), **{"release.yml": release}))
        self.assertIn("release.yml: refers to staging; production is the only environment", errors)
        self.assertIn("release.yml: must deploy through the protected production environment", errors)

    def test_comments_do_not_count(self):
        workflows = repository()
        workflows["production.yml"] = "# on:\n#   push:\n# staging\n" + workflows["production.yml"]
        self.assertEqual(policy.errors(workflows), [])


if __name__ == "__main__":
    unittest.main()
