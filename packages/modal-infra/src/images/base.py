"""
Base image definition for Open-Inspect sandboxes.

This image provides a complete development environment with:
- Debian slim base with git, curl, build-essential, Docker (dockerd + start script for gVisor)
- Node.js 22 LTS, pnpm, Bun runtime
- Python 3.12 with uv
- OpenCode CLI pre-installed
- agent-browser CLI with headless Chrome for browser automation
- ffmpeg for browser video encoding
- Sandbox entrypoint and bridge code
"""

from pathlib import Path

import modal

import sandbox_runtime

# Get the path to the sandbox runtime code (provider-agnostic)
SANDBOX_RUNTIME_DIR = Path(sandbox_runtime.__file__).parent
# start-dockerd.sh (Modal Docker-in-Sandboxes); lives next to this file for add_local_file
START_DOCKERD_SH = Path(__file__).parent / "start-dockerd.sh"
# kubeconfig — static ~/.kube/config template copied into the image
KUBECONFIG = Path(__file__).parent / "kubeconfig"

# OpenCode version to install
OPENCODE_VERSION = "1.14.41"
# code-server version to install (pinned for reproducible images)
CODE_SERVER_VERSION = "4.109.5"

# agent-browser version to install (pinned for reproducible images)
AGENT_BROWSER_VERSION = "0.21.2"

# Playwright version to install (pinned for reproducible images)
PLAYWRIGHT_VERSION = "1.61.0"

# ttyd version to install (pinned for reproducible images)
TTYD_VERSION = "1.7.7"
TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"

# rwx CLI — pinned Linux x86_64 binary; see https://github.com/rwx-cloud/rwx/releases
RWX_VERSION = "3.13.1"

# kubectl — pinned Linux x86_64 binary; see https://dl.k8s.io/release/stable.txt
KUBECTL_VERSION = "v1.35.0"

# Docker CE version to install (pinned for reproducible images)
DOCKER_CE_VERSION = "5:27.5.0-1~debian.12~bookworm"

# Cache buster - change this to force Modal image rebuild
# v82: fix hook timeout hang when start.sh spawns background processes
# v83: pre-migrate OpenCode DB at build time so first session boot doesn't
#      block on it and trip the heartbeat watchdog
# v84: offload synchronous tool/skill/plugin install in start_opencode off the
#      event loop so the boot-progress loop keeps pinging during a slow boot
# v85: bridge PROMPT_MAX_DURATION resolvable from env (providers with a shorter
#      sandbox lifetime, e.g. Vercel, can lower it so the bridge self-stops first)
# v86: bridge adopts a control-plane-supplied opencodeSessionId on prompt so a
#      relaunched/restored sandbox resumes the prior OpenCode session
# v87: push completion events include HEAD SHA for preview dispatch deduplication
# v88: opencode node_modules materialized via hardlinks (was a slow per-file copy)
# v89: boot-time autostash is popped after checkout so uncommitted edits survive restore
# v90: bridge reports HEAD from the cloned repo for preview dispatches
# v93: opencode node_modules symlinked (hardlink was copied-up by overlayfs)
# v94: merge upstream — bake OpenCode global config deps at build time to skip
#      the boot-time global-deps seed/reify (#790/#795); keep langfuse plugin in
#      the staged tree and the SCM credential helper.
# v95: merge upstream "Remove repo-image fallback tokens" (#722); SCM credential
#      helper backed by control plane remains the sole credential path.
# v96: add ripgrep to apt packages
CACHE_BUSTER = "v96-add-ripgrep"

# Base image with all development tools
base_image = (
    modal.Image.debian_slim(python_version="3.12")
    # System packages
    .apt_install(
        "awscli",
        "git",
        "curl",
        "build-essential",
        "ca-certificates",
        "gnupg",
        "openssh-client",
        "apt-transport-https",
        "jq",
        "ripgrep",
        "locales",
        "locales-all",
        "unzip",  # Required for Bun installation
        "iproute2",  # `ip` for /start-dockerd.sh (default route, addresses)
        "wget",  # Runc install and general tooling
        "iptables",  # iptables-legacy for dockerd in gVisor (used by add_local start script)
        "ffmpeg",
        # Shared libraries required by headless Chromium
        "libnss3",
        "libnspr4",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdrm2",
        "libxkbcommon0",
        "libxcomposite1",
        "libxdamage1",
        "libxfixes3",
        "libxrandr2",
        "libgbm1",
        "libasound2",
        "libpango-1.0-0",
        "libcairo2",
        # Native module build dependencies (e.g. @confluentinc/kafka-javascript)
        "libsasl2-dev",
        "libssl-dev",
        "libzstd-dev",
        "librdkafka-dev",
    )
    # OpenTofu
    .run_commands(
        "install -m 0755 -d /etc/apt/keyrings",
        "curl -fsSL https://get.opentofu.org/opentofu.gpg | tee /etc/apt/keyrings/opentofu.gpg >/dev/null",
        "curl -fsSL https://packages.opentofu.org/opentofu/tofu/gpgkey | gpg --no-tty --batch --dearmor -o /etc/apt/keyrings/opentofu-repo.gpg >/dev/null",
        "chmod a+r /etc/apt/keyrings/opentofu.gpg /etc/apt/keyrings/opentofu-repo.gpg",
        (
            "echo 'deb [signed-by=/etc/apt/keyrings/opentofu.gpg,/etc/apt/keyrings/opentofu-repo.gpg] "
            "https://packages.opentofu.org/opentofu/tofu/any/ any main' > /etc/apt/sources.list.d/opentofu.list"
        ),
        (
            "echo 'deb-src [signed-by=/etc/apt/keyrings/opentofu.gpg,/etc/apt/keyrings/opentofu-repo.gpg] "
            "https://packages.opentofu.org/opentofu/tofu/any/ any main' >> /etc/apt/sources.list.d/opentofu.list"
        ),
        "chmod a+r /etc/apt/sources.list.d/opentofu.list",
        "apt-get update && apt-get install -y tofu && rm -rf /var/lib/apt/lists/*",
        "tofu --version",
    )
    # rwx (for agent-direct GitHub interaction via rwx API)
    .run_commands(
        f"curl -fsSL https://github.com/rwx-cloud/rwx/releases/download/v{RWX_VERSION}/rwx-linux-x86_64 -o /usr/local/bin/rwx",
        "chmod +x /usr/local/bin/rwx",
        "rwx --version",
    )
    # Install GitHub CLI (for agent-direct GitHub interaction via gh API)
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg"
        " | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg]"
        " https://cli.github.com/packages stable main'"
        " > /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
    )
    # Node.js via nvm: each run_commands string is a fresh shell, so nvm (a function) is not
    # available across lines — install, set default, and publish binaries to PATH in one bash.
    .run_commands(
        'export BASH_ENV="/root/.bash_env" && touch "${BASH_ENV}"',
        'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | PROFILE="${BASH_ENV}" bash',
        r"""bash -ec 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install 24.15.0 && nvm alias default 24.15.0 && for x in node npm npx; do ln -sf "$(command -v "$x")" "/usr/local/bin/$x"; done && npm config set prefix /usr/local && node --version && npm --version'""",
    )
    # Install pnpm and Bun
    .run_commands(
        "npm install -g pnpm@latest",
        "pnpm --version",
        # Install Bun
        "curl -fsSL https://bun.sh/install | bash",
        # Add Bun to PATH for subsequent commands
        'echo "export BUN_INSTALL="$HOME/.bun"" >> /etc/profile.d/bun.sh',
        'echo "export PATH="$BUN_INSTALL/bin:$PATH"" >> /etc/profile.d/bun.sh',
    )
    # Install Python tools
    .pip_install(
        "uv",
        "httpx",
        "websockets",
        "pydantic>=2.0",  # Required for sandbox types
        "PyJWT[crypto]",  # For GitHub App token generation (includes cryptography)
    )
    # Install asdf
    # .run_commands(
    #     "https://github.com/asdf-vm/asdf/releases/download/v0.18.1/asdf-v0.18.1-linux-amd64.tar.gz"
    #     " | tar -xz -C /usr/local",
    #     "echo '. /usr/local/asdf/asdf.sh' >> ~/.bashrc",
    #     "echo '. /usr/local/asdf/completions/asdf.bash' >> ~/.bashrc",
    #     "source ~/.bashrc",
    #     "asdf --version",
    # )
    # Install Signoz MCP server
    .run_commands(
        "curl -L https://github.com/SigNoz/signoz-mcp-server/releases/download/v0.4.0/signoz-mcp-server_linux_amd64.tar.gz -o /tmp/signoz-mcp-server.tar.gz",
        "tar -xzf /tmp/signoz-mcp-server.tar.gz -C /usr/local/bin --strip-components=2 signoz-mcp-server_linux_amd64/bin/signoz-mcp-server",
        "rm /tmp/signoz-mcp-server.tar.gz",
        "chmod +x /usr/local/bin/signoz-mcp-server",
        "md5sum /usr/local/bin/signoz-mcp-server",
    )
    .run_commands(
        "install -m 0755 -d /etc/apt/keyrings",
        "curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc",
        "chmod a+r /etc/apt/keyrings/docker.asc",
        "echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable' > /etc/apt/sources.list.d/docker.list",
        "apt-get -qq update >/dev/null",
        f"DEBIAN_FRONTEND=noninteractive apt-get -y -qq install apt-utils docker-ce={DOCKER_CE_VERSION} docker-ce-cli={DOCKER_CE_VERSION} containerd.io docker-compose-plugin docker-buildx-plugin >/dev/null",
    )
    .run_commands(
        "rm $(which runc)",
        "wget https://github.com/opencontainers/runc/releases/download/v1.3.0/runc.amd64",
        "chmod +x runc.amd64",
        "mv runc.amd64 /usr/local/bin/runc",
    )
    # gVisor doesn't support nftables yet (https://github.com/google/gvisor/issues/10510).
    # Use iptables-legacy for reliable Docker-in-Sandboxes networking.
    .run_commands(
        "update-alternatives --set iptables /usr/sbin/iptables-legacy",
        "update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy",
    )
    .add_local_file(str(START_DOCKERD_SH), "/start-dockerd.sh", copy=True)
    .run_commands("chmod +x /start-dockerd.sh")
    .add_local_file(str(KUBECONFIG), "/etc/kubeconfig", copy=True)
    # # Install Spacelift CLI
    # .run_commands(
    #     "asdf plugin add spacectl",
    #     "asdf install spacectl latest",
    #     "asdf global spacectl latest",
    #     "spacectl --version",
    # )
    .run_commands("uvx mcp-proxy-for-aws@1.5.0 --help")
    # Install kubectl (pinned binary from dl.k8s.io)
    .run_commands(
        f'curl -fsSL "https://dl.k8s.io/release/{KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl',
        "chmod +x /usr/local/bin/kubectl",
        "kubectl version --client",
    )
    # Install skill-validator
    # .run_commands("apt-get install -y golang-go")
    # .run_commands("go install github.com/agent-ecosystem/skill-validator/cmd/skill-validator@1fe10b0b3ebacbb85f64e3664f712c497b71c1a9")
    # Install OpenCode CLI and plugin for custom tools
    # CACHE_BUSTER is embedded in a no-op echo so Modal invalidates this layer on bump.
    .run_commands(
        f"echo 'cache: {CACHE_BUSTER}' > /dev/null",
        f"npm install -g opencode-ai@{OPENCODE_VERSION}",
        "opencode --version || echo 'OpenCode installed'",
        # Install @opencode-ai/plugin globally for custom tools
        # This ensures tools can import the plugin without needing to run bun add
        f"npm install -g @opencode-ai/plugin@{OPENCODE_VERSION} zod",
        "npm install -g oxlint@latest",
        "oxlint --version",
        "npm install -g typescript-language-server@5.3.0",
        # web-tree-sitter (WASM) + grammars for ast-anchor / validate-suggestion tools.
        # Pinned for ABI stability; grammars ship prebuilt .wasm files (no native compile).
        "npm install -g web-tree-sitter@^0.25.10 tree-sitter-typescript tree-sitter-ruby",
        # Langfuse OpenCode plugin (loaded when LANGFUSE_* env vars are provided)
        "npm install -g opencode-plugin-langfuse@latest",
    )
    # Pre-build OpenCode plugin deps into a staging directory.
    # At boot, _install_tools() copies these into .opencode/ so that
    # OpenCode's Npm.install() finds package-lock.json in sync and skips
    # the slow arborist reify() call (2-22s) that would otherwise block
    # the first prompt and exceed the bridge's HTTP timeout.
    #
    # opencode-plugin-langfuse is included here so its transitive deps are
    # in the lockfile — without this, OpenCode reifies langfuse at session
    # creation time, hitting npm registry and causing intermittent ReadTimeout.
    #
    # Also bake the same tree into OpenCode's GLOBAL config dir. OpenCode installs
    # @opencode-ai/plugin into every config directory it discovers — including the
    # global one (HOME=/root, so ~/.config/opencode), which it creates empty on
    # startup — so without this the runtime _seed_global_opencode_deps() pays a
    # multi-second node_modules copy on every boot. Baking it makes that seed a
    # no-op (it skips when node_modules already exists). See #767 / #790 / #795.
    .run_commands(
        "mkdir -p /app/opencode-deps",
        # Pin staged plugin to OPENCODE_VERSION so the pre-staged tree copied
        # into .opencode/ at boot matches the globally installed plugin (#567).
        # opencode-plugin-langfuse stays pinned to latest so our langfuse
        # tracing keeps working with whatever the global install resolves.
        f'echo \'{{"name":"opencode-tools","type":"module",'
        f'"dependencies":{{"@opencode-ai/plugin":"{OPENCODE_VERSION}",'
        f'"opencode-plugin-langfuse":"latest"}}}}\''
        " > /app/opencode-deps/package.json",
        "cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund",
        # Bake the in-sync tree into the global config dir so the runtime seed is a no-op.
        "mkdir -p /root/.config/opencode",
        "cp -a /app/opencode-deps/. /root/.config/opencode/",
    )
    # Install code-server for browser-based VS Code editing (direct .deb from GitHub releases)
    .run_commands(
        f"curl -fsSL -o /tmp/code-server.deb"
        f" https://github.com/coder/code-server/releases/download/v{CODE_SERVER_VERSION}"
        f"/code-server_{CODE_SERVER_VERSION}_amd64.deb",
        "dpkg -i /tmp/code-server.deb",
        "rm /tmp/code-server.deb",
        "code-server --version",
    )
    # Install ttyd web terminal (direct binary from GitHub releases)
    .run_commands(
        f"curl -fsSL -o /usr/local/bin/ttyd"
        f" https://github.com/tsl0922/ttyd/releases/download/{TTYD_VERSION}"
        f"/ttyd.x86_64",
        f'echo "{TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -',
        "chmod +x /usr/local/bin/ttyd",
        "ttyd --version",
    )
    # Install agent-browser CLI and download Chromium
    .run_commands(
        f"npm install -g agent-browser@{AGENT_BROWSER_VERSION}",
        "agent-browser install",
        "agent-browser --version",
    )
    # Install Playwright and its Chromium browser + deps.
    .run_commands(
        f"npm install -g playwright@{PLAYWRIGHT_VERSION}",
        "playwright install chromium --with-deps",
    )
    # Create working directories
    .run_commands(
        "mkdir -p /workspace",
        "mkdir -p /app/plugins",
        "mkdir -p /tmp/opencode",
        "echo 'Image rebuilt at: v21-force-rebuild' > /app/image-version.txt",
    )
    # Install the git credential helper shim.
    #
    # Each `git` invocation in the sandbox runs this shim, which delegates to
    # the sandbox-runtime helper module. The helper talks to the control plane
    # to mint fresh per-request credentials, so git operations no longer rely
    # on a 1h-TTL token captured at sandbox creation time. Configured at the
    # system level so it applies before entrypoint.py has a chance to run
    # (e.g. when restoring a snapshot whose first action is a `git fetch`).
    .run_commands(
        "printf '%s\\n'"
        " '#!/bin/sh'"
        " 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
        " > /usr/local/bin/oi-git-credentials",
        "chmod 0755 /usr/local/bin/oi-git-credentials",
        "git config --system credential.helper /usr/local/bin/oi-git-credentials",
        # Pass the repo path to the helper so it can scope credentials to the
        # session repo, not just the host.
        "git config --system credential.useHttpPath true",
    )
    # Set environment variables (including cache buster to force rebuild)
    .env(
        {
            "HOME": "/root",
            "NODE_ENV": "development",
            "PNPM_HOME": "/root/.local/share/pnpm",
            "PATH": "/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin",
            "PYTHONPATH": "/app",
            "SANDBOX_VERSION": CACHE_BUSTER,
            # NODE_PATH for globally installed modules (used by custom tools)
            "NODE_PATH": "/usr/lib/node_modules",
        }
    )
    # Add sandbox runtime code to the image (provider-agnostic bridge, entrypoint, tools, plugins)
    .add_local_dir(
        str(SANDBOX_RUNTIME_DIR),
        remote_path="/app/sandbox_runtime",
    )
)

# Image variant optimized for Node.js/TypeScript projects
node_image = base_image.run_commands(
    # Pre-cache common Node.js development dependencies
    "npm cache clean --force",
)

# Image variant optimized for Python projects
python_image = base_image.run_commands(
    # Pre-create virtual environment
    "uv venv /workspace/.venv",
)
