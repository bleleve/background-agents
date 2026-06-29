"""Fountain URL context detection and enrichment for background agent prompts.

Detects *.fountain.com, *.ftn.app, and *.tryfountain.com URLs in a prompt and
returns a structured context block that tells the agent which service (Hire
monolith, Hire Go, WX, or Fountain One) and environment each URL belongs to.
"""

import re

_WX_ROLE_NAMES: dict[str, str] = {
    "employer": "Employer portal",
    "portal": "Worker portal",
    "services": "Backend services",
}

_SERVICE_LABELS: dict[str, str] = {
    "WX": "WX (Worker Experience, React/TypeScript)",
    "Hire": "Hire (monolith, Ruby on Rails)",
    "Hire Go": "Hire Go (Go app)",
    "Fountain One": "Fountain One (unified login)",
}

# Matches fountain.com, ftn.app, and tryfountain.com URLs, optionally with scheme and path.
_URL_RE = re.compile(
    r"(?:https?://)?"
    r"((?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+(?:fountain\.com|ftn\.app|tryfountain\.com))"
    r"(?:/[^\s\"'<>]*)?",
    re.IGNORECASE,
)


def _classify_wx_env(env: str) -> str:
    if re.match(r"^wxp-\d+$", env):
        return "development"
    if env == "wxp-dev":
        return "development"
    if env == "wxp-staging":
        return "staging"
    return "production"


def _classify_hire_env(namespace: str) -> str:
    if re.match(r"^dev-\d+$", namespace):
        return "development"
    if re.match(r"^(staging|staging-use)-\d+$", namespace):
        return "staging"
    if re.match(r"^faut-\d+$", namespace):
        return "staging"
    if re.match(r"^uat-\d+$", namespace):
        return "uat"
    if namespace == "sandbox":
        return "sandbox"
    if namespace == "demo":
        return "demo"
    return "production"


def _classify_host(
    host: str,
) -> tuple[str, str | None, str, str] | None:
    """Classify a host into (service, role, env_name, env_type) or None if not a known Fountain host."""
    h = host.lower()

    if h.endswith(".ftn.app"):
        subdomains = h[: -len(".ftn.app")].split(".")
        role = _WX_ROLE_NAMES.get(subdomains[0]) if subdomains else None
        env_name = subdomains[-1] if subdomains else "dev"
        return ("WX", role, env_name, "development")

    if h.endswith(".tryfountain.com"):
        prefix = h[: -len(".tryfountain.com")]
        parts = prefix.split(".")
        if len(parts) == 2:
            _namespace, env = parts
            env_type = "staging" if env == "staging" else "production"
            return ("Hire Go", None, env, env_type)
        if len(parts) == 1:
            return ("Hire Go", None, parts[0], "production")
        return None

    if not h.endswith(".fountain.com"):
        return None

    prefix = h[: -len(".fountain.com")]
    parts = prefix.split(".")

    if len(parts) == 2:
        first, second = parts
        if first in _WX_ROLE_NAMES:
            return ("WX", _WX_ROLE_NAMES[first], second, _classify_wx_env(second))
        if first == "sandbox" and second == "go":
            return ("Hire Go", None, "go", "sandbox")
        if first == "sandbox":
            return ("Hire", None, f"sandbox ({second})", "sandbox")
        return None

    if len(parts) == 1:
        namespace = parts[0]
        if namespace == "go":
            return ("Hire Go", None, "go", "production")
        if namespace == "employer":
            return ("Fountain One", None, "unified login", "production")
        return ("Hire", None, namespace, _classify_hire_env(namespace))

    return None


def _format_line(host: str, service: str, role: str | None, env_name: str, env_type: str) -> str:
    display_url = f"https://{host}"
    service_label = _SERVICE_LABELS.get(service, service)
    parts = [f"- {display_url} → {service_label}"]
    if role:
        parts.append(f"— {role}")
    parts.append(f"— {env_name} {env_type} environment")
    return " ".join(parts)


def build_fountain_url_context(content: str) -> str | None:
    """Detect Fountain application URLs in content and return a context block.

    Scans for *.fountain.com and *.ftn.app URLs, classifies each as Hire or WX
    with its environment type, deduplicates by host, and returns an XML-wrapped
    context string. Returns None if no recognizable Fountain URLs are found.
    """
    seen: set[str] = set()
    lines: list[str] = []

    for match in _URL_RE.finditer(content):
        host = match.group(1).lower()
        if host in seen:
            continue
        seen.add(host)

        classified = _classify_host(host)
        if classified is None:
            continue

        service, role, env_name, env_type = classified
        lines.append(_format_line(host, service, role, env_name, env_type))

    if not lines:
        return None

    url_lines = "\n".join(lines)
    return (
        "<fountain_context>\n"
        "Fountain application URL(s) detected in this request:\n\n"
        f"{url_lines}\n\n"
        "Focus your changes on the codebases relevant to these services.\n"
        "</fountain_context>"
    )
