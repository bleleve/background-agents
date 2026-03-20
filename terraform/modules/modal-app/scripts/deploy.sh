#!/usr/bin/env bash
# Deploy Modal app
# Required environment variables:
#   MODAL_TOKEN_ID - Modal API token ID
#   MODAL_TOKEN_SECRET - Modal API token secret
#   APP_NAME - Name of the app (for logging)
#   DEPLOY_PATH - Path to the Modal app source
#   DEPLOY_MODULE - Module to deploy (e.g., 'deploy' or 'src')

set -euo pipefail

echo "Deploying Modal app: ${APP_NAME}"
echo "Deploy path: ${DEPLOY_PATH}"
echo "Deploy module: ${DEPLOY_MODULE}"

# Verify required environment variables
if [[ -z "${MODAL_TOKEN_ID:-}" ]]; then
    echo "Error: MODAL_TOKEN_ID environment variable is not set"
    exit 1
fi

if [[ -z "${MODAL_TOKEN_SECRET:-}" ]]; then
    echo "Error: MODAL_TOKEN_SECRET environment variable is not set"
    exit 1
fi

# Change to the deployment directory
cd "${DEPLOY_PATH}" || {
    echo "Error: Failed to change directory to ${DEPLOY_PATH}"
    exit 1
}

# Set up the deploy virtual environment.
# sandbox_runtime is a local sibling package (../sandbox-runtime) that must be
# importable at deploy time so Modal can parse the app's module graph.
VENV_DIR=".venv"
SANDBOX_RUNTIME_DIR="../sandbox-runtime"

if [ ! -f "${VENV_DIR}/bin/python" ]; then
    echo "Creating deploy virtual environment..."
    # sandbox_runtime requires Python >= 3.12; prefer python3.12 explicitly
    if command -v python3.12 &>/dev/null; then
        PYTHON=python3.12
    elif python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)' 2>/dev/null; then
        PYTHON=python3
    else
        echo "Error: Python >= 3.12 is required but not found (tried python3.12 and python3)"
        exit 1
    fi
    echo "Using $(${PYTHON} --version)"
    "${PYTHON}" -m venv "${VENV_DIR}"
fi

echo "Installing deploy dependencies..."
# Install sandbox_runtime first (local package, not on PyPI)
"${VENV_DIR}/bin/pip" install --quiet -e "${SANDBOX_RUNTIME_DIR}"
# Install modal-infra and all its declared dependencies (fastapi, httpx, etc.)
"${VENV_DIR}/bin/pip" install --quiet -e "."

MODAL="${VENV_DIR}/bin/modal"

# Deploy using Modal CLI
if [ "${DEPLOY_MODULE}" = "deploy" ]; then
    # Method 1: Use deploy.py wrapper (recommended)
    "${MODAL}" deploy deploy.py || {
        echo "Error: Modal deployment failed for ${APP_NAME}"
        exit 1
    }
elif [ "${DEPLOY_MODULE}" = "src" ]; then
    # Method 2: Deploy the src package directly
    "${MODAL}" deploy -m src || {
        echo "Error: Modal deployment failed for ${APP_NAME}"
        exit 1
    }
else
    # Generic deployment
    "${MODAL}" deploy "${DEPLOY_MODULE}" || {
        echo "Error: Modal deployment failed for ${APP_NAME}"
        exit 1
    }
fi

echo "Modal app ${APP_NAME} deployed successfully"
