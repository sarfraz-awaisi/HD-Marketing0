"""Release policy for the GitHub workflows, checked by check.py in CI and in
every release: deployment is production-only and always started by a person,
from main, after CI passed for that exact commit, and approved in the
protected production environment. There is no staging."""
import re

# A workflow that can reach the server, a secret or an environment deploys.
DEPLOY_MARKERS = ("release.yml", "remote.sh", "DEPLOY_", "secrets.", "environment:")
MANUAL = {"workflow_dispatch", "workflow_call"}
ON = r"""^["']?on["']?:"""


def code(text):
    """Workflow text without comment lines."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def triggers(text):
    """Event names under the top-level `on:` key (block or inline form)."""
    text = code(text) + "\n"
    inline = re.search(ON + r"[ \t]*(\S.*)$", text, re.M)
    if inline:
        return set(re.findall(r"[a-z_]+", inline.group(1)))
    block = re.search(ON + r"[ \t]*\n((?:[ \t]+.*\n|[ \t]*\n)*)", text, re.M)
    first = block and re.search(r"^([ \t]+)[a-z_]+:", block.group(1), re.M)
    if not first:
        return set()
    # Only the direct children of `on:`, not their nested settings.
    return set(re.findall(rf"^{re.escape(first.group(1))}([a-z_]+):", block.group(1), re.M))


def errors(workflows):
    """workflows maps file name to text; returns the policy violations."""
    found = []
    for name, text in sorted(workflows.items()):
        body = code(text)
        if re.search(r"staging", body, re.I):
            found.append(f"{name}: refers to staging; production is the only environment")
        if any(marker in body for marker in DEPLOY_MARKERS):
            started_by = triggers(text)
            if not started_by:
                found.append(f"{name}: deploys but its triggers cannot be read")
            elif started_by - MANUAL:
                found.append(f"{name}: deploys but starts automatically on {', '.join(sorted(started_by - MANUAL))}")
    production = code(workflows.get("production.yml", ""))
    if triggers(production) != {"workflow_dispatch"}:
        found.append("production.yml: must start only by manual workflow_dispatch")
    if not (re.search(r"if: github\.ref == 'refs/heads/main'", production)
            and "/compare/$RELEASE_SHA...$GITHUB_SHA" in production):
        found.append("production.yml: must release only a commit that is part of main")
    if not ("actions/workflows/ci.yml/runs" in production and "status=success" in production
            and re.search(r"needs: ci-evidence", production)):
        found.append("production.yml: must require a successful CI run of the release commit")
    release = code(workflows.get("release.yml", ""))
    if triggers(release) != {"workflow_call"}:
        found.append("release.yml: must only be called by production.yml")
    if not re.search(r"^[ \t]+environment: production[ \t]*$", release, re.M):
        found.append("release.yml: must deploy through the protected production environment")
    if "actions/runs/$GITHUB_RUN_ID/approvals" not in release:
        found.append("release.yml: must stop unless GitHub recorded a production approval")
    if not ("ref: ${{ inputs.sha }}" in release and '[[ "$(git rev-parse HEAD)" == "$RELEASE_SHA" ]]' in release):
        found.append("release.yml: must check out and confirm the exact release commit")
    check, upload = release.find("deploy/production/check-ssh.sh"), release.find("deploy/production/remote.sh")
    if check < 0 or upload < 0 or check > upload or not re.search(r"TRUSTED_HOST_KEY: SHA256:[A-Za-z0-9+/]{43}\b", release):
        found.append("release.yml: must check the SSH host key against TRUSTED_HOST_KEY before uploading")
    return found
