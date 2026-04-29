#!/bin/bash
# Start dockerd in Modal "Docker in Sandboxes" (gVisor) — see enable_docker experimental option.
# Requires iptables-legacy, modern runc, and iproute2; baked into the base image.
set -xe -o pipefail

# gVisor doesn't support nftables yet (https://github.com/google/gvisor/issues/10510).
# Explicitly ensure that we use iptables-legacy -- the non-nftables version of iptables.
update-alternatives --set iptables /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy


DOCKER_SOCK="/run/user/1000/docker.sock"
DOCKER_DATA="/var/lib/docker-sandbox"
DOCKER_LOG="/tmp/dockerd.log"

echo "[setup-docker] Writing /etc/docker/daemon.json"
mkdir -p /etc/docker
# Only set storage-driver here. The flags --iptables=false, --ip6tables=false, and
# --bridge=none are passed directly by start-dockerd; duplicating them in daemon.json
# causes dockerd to refuse to start ("directive specified both as flag and in config").
cat > /etc/docker/daemon.json << 'EOF'
{
  "storage-driver": "vfs"
}
EOF

echo "[setup-docker] Writing /usr/local/bin/start-dockerd"
cat > /usr/local/bin/start-dockerd << PYEOF
#!/usr/bin/env python3
"""
Launch dockerd inside a user+mount namespace so that mount(2) syscalls succeed
under gVisor, which blocks CLONE_NEWNS alone but allows CLONE_NEWUSER|CLONE_NEWNS.

The parent process writes uid_map and gid_map (mapping host uid 0 -> ns uid 0)
then signals the child to exec dockerd. The parent exits immediately, leaving
dockerd running detached.
"""
import os, ctypes, sys, time

DOCKER_SOCK = "${DOCKER_SOCK}"
DOCKER_DATA = "${DOCKER_DATA}"
DOCKER_LOG  = "${DOCKER_LOG}"

CLONE_NEWUSER = 0x10000000
CLONE_NEWNS   = 0x00020000

libc = ctypes.CDLL("libc.so.6", use_errno=True)

os.makedirs(os.path.dirname(DOCKER_SOCK), exist_ok=True)
os.makedirs(DOCKER_DATA, exist_ok=True)

r, w = os.pipe()
pid = os.fork()

if pid == 0:
    # ---- child: enter user+mount namespace then exec dockerd ----
    os.close(w)
    ret = libc.unshare(CLONE_NEWUSER | CLONE_NEWNS)
    if ret != 0:
        err = ctypes.get_errno()
        sys.stderr.write(f"start-dockerd: unshare failed: {os.strerror(err)}\n")
        os._exit(1)
    # Wait for parent to write uid/gid maps before execing dockerd,
    # because dockerd checks its effective uid immediately on startup.
    os.read(r, 1)
    os.close(r)
    # Redirect dockerd stdout/stderr to log file
    lfd = os.open(DOCKER_LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(lfd, 1)
    os.dup2(lfd, 2)
    os.close(lfd)
    os.execv("/usr/bin/dockerd", [
        "dockerd",
        "--iptables=false",
        "--ip6tables=false",
        "--bridge=none",
        f"--host=unix://{DOCKER_SOCK}",
        f"--data-root={DOCKER_DATA}",
    ])

else:
    # ---- parent: write uid/gid maps, signal child, then exit ----
    os.close(r)
    time.sleep(0.15)  # let child enter the namespace
    try:
        with open(f"/proc/{pid}/uid_map", "w") as f:
            f.write("0 0 65536\n")
        with open(f"/proc/{pid}/gid_map", "w") as f:
            f.write("0 0 65536\n")
    except OSError as e:
        sys.stderr.write(f"start-dockerd: could not write id maps: {e}\n")
        os.write(w, b"\x00")
        os.close(w)
        sys.exit(1)
    os.write(w, b"\x00")
    os.close(w)
    # Detach: don't wait for the child; it runs as a daemon.
    sys.exit(0)
PYEOF
chmod +x /usr/local/bin/start-dockerd

echo "[setup-docker] Writing /usr/local/bin/docker (wrapper)"
# This wrapper lives earlier in PATH (/usr/local/bin) than the real docker (/usr/bin/docker).
# On first invocation it starts the daemon and waits for the socket; subsequent calls
# skip the startup check because the socket already exists.
cat > /usr/local/bin/docker << 'EOF'
#!/usr/bin/env bash
# docker wrapper -- auto-starts dockerd in user+mount namespace on first use.

DOCKER_SOCK="/run/user/1000/docker.sock"
REAL_DOCKER="/usr/bin/docker"

_start_daemon() {
    /usr/local/bin/start-dockerd 2>/dev/null
    local waited=0
    while [ ! -S "$DOCKER_SOCK" ]; do
        sleep 0.5
        waited=$((waited + 1))
        if [ "$waited" -ge 40 ]; then  # 20 second timeout
            echo "docker: timed out waiting for dockerd to start" >&2
            echo "docker: check logs at /tmp/dockerd.log" >&2
            exit 1
        fi
    done
}

if [ ! -S "$DOCKER_SOCK" ]; then
    _start_daemon
fi

exec "$REAL_DOCKER" --host "unix://$DOCKER_SOCK" "$@"
EOF
chmod +x /usr/local/bin/docker