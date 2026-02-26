#!/bin/bash
# Get the absolute directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/Users/hang/code/tencent/ai/webpage-mcp-server/app/native-server/dist/logs" # Or a directory you choose and make sure you have write permissions

# Get the current timestamp for the log file name to avoid overwriting
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
WRAPPER_LOG="${LOG_DIR}/native_host_wrapper_${TIMESTAMP}.log"

# Node.js The actual path to the script
NODE_SCRIPT="${SCRIPT_DIR}/index.js"

# Make sure the log directory exists
mkdir -p "${LOG_DIR}"

# Record information about the wrapper script being called
echo "Wrapper script called at $(date)" > "${WRAPPER_LOG}"
echo "SCRIPT_DIR: ${SCRIPT_DIR}" >> "${WRAPPER_LOG}"
echo "LOG_DIR: ${LOG_DIR}" >> "${WRAPPER_LOG}"
echo "NODE_SCRIPT: ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "Initial PATH: ${PATH}" >> "${WRAPPER_LOG}"

# Dynamically find Node.js executables
NODE_EXEC=""
# 1. Try using which (it will use the current environment's PATH, but Chrome's PATH may be incomplete)
if command -v node &>/dev/null; then
    NODE_EXEC=$(command -v node)
    echo "Found node using 'command -v node': ${NODE_EXEC}" >> "${WRAPPER_LOG}"
fi

# 2. If which cannot be found, try some common Node.js installation paths on macOS
if [ -z "${NODE_EXEC}" ]; then
    COMMON_NODE_PATHS=(
        "/usr/local/bin/node"            # Homebrew on Intel Macs / direct install
        "/opt/homebrew/bin/node"         # Homebrew on Apple Silicon
        "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -n 1)/bin/node" # NVM (latest installed)
        # You can add more paths that may exist in your environment as needed
    )
    for path_to_node in "${COMMON_NODE_PATHS[@]}"; do
        if [ -x "${path_to_node}" ]; then
            NODE_EXEC="${path_to_node}"
            echo "Found node at common path: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
            break
        fi
    done
fi

# 3. If still not found, log an error and exit
if [ -z "${NODE_EXEC}" ]; then
    echo "ERROR: Node.js executable not found!" >> "${WRAPPER_LOG}"
    echo "Please ensure Node.js is installed and its path is accessible or configured in this script." >> "${WRAPPER_LOG}"
    # For Native Host, it needs to keep running to receive messages, exiting directly may not be optimal
    # But if the node cannot be found, the target script cannot be executed.
    # Here you can consider outputting an error message that conforms to the Native Messaging protocol to the extension (if possible)
    # Or just let it fail and Chrome will report Native Host Exited.
    exit 1 # Must exit, otherwise the following exec will fail
fi

echo "Using Node executable: ${NODE_EXEC}" >> "${WRAPPER_LOG}"
echo "Node version found by script: $(${NODE_EXEC} -v)" >> "${WRAPPER_LOG}"
echo "Executing: ${NODE_EXEC} ${NODE_SCRIPT}" >> "${WRAPPER_LOG}"
echo "PWD: $(pwd)" >> "${WRAPPER_LOG}" # PWD Record it, sometimes it is useful

exec "${NODE_EXEC}" "${NODE_SCRIPT}" 2>> "${LOG_DIR}/native_host_stderr_${TIMESTAMP}.log"