set -ex
yum install -y git python3.11 pip

# Point to pypi index url if provided
if [ "$PYPI_INDEX_URL" != "" ]; then \
    pip config set global.index-url $PYPI_INDEX_URL && \
    pip config set global.trusted-host $PYPI_TRUSTED_HOST;
fi

# Define the repository and directory
REPO_URL="https://github.com/krzim-aws/LISA.git"
REPO_DIR="/home/ec2-user/LISA"

# Clone the LISA repo if it doesn't exist, otherwise fetch and pull
if [ ! -d "$REPO_DIR" ]; then
    git clone $REPO_URL $REPO_DIR
else
    cd $REPO_DIR
    git fetch origin
    git pull origin main
fi

# Navigate to the src directory
cd $REPO_DIR/lib/serve/rest-api

# Create virtual environment and install dependencies
/usr/bin/python3.11 -m venv .venv
source .venv/bin/activate
pip install --no-cache-dir --upgrade -r ./src/requirements.txt

# Copy LiteLLM config directly to container, it will be updated at runtime
# with LISA-hosted models. This filename is expected in the entrypoint.sh file, so do not modify
# the filename unless you modify it in the entrypoint.sh file too.
echo "$LITELLM_CONFIG" > litellm_config.yaml

# Host and port configuration
HOST="0.0.0.0"
PORT="80"

# Update LiteLLM config that was already copied from config.yaml with runtime-deployed models.
# Depends on SSM Parameter for registered models.
echo "Configuring and starting LiteLLM"
# litellm_config.yaml is generated from the REST API Dockerfile from the LISA config.yaml.
# Do not modify the litellm_config.yaml name unless you change it in the Dockerfile and in the `litellm` command below.
python ./src/utils/generate_litellm_config.py -f litellm_config.yaml

# Start LiteLLM in the background, default port 4000, not exposed outside of container.
# If you need to change the port, you can specify the --port option, and then the port needs to be updated in
# src/api/endpoints/v2/litellm_passthrough.py for the LiteLLM URI
litellm -c litellm_config.yaml &

echo "Starting Gunicorn with $THREADS workers..."

# Start Gunicorn with Uvicorn workers.
gunicorn -k uvicorn.workers.UvicornWorker -w "$THREADS" -b "$HOST:$PORT" "src.main:app" --daemon
