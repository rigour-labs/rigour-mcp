#!/usr/bin/env bash
# Rigour MCP Azure Deployment Script
#
# Deploys rigour-mcp to Azure Container Apps using ACR cloud builds.
# Defaults are pinned so bot + mcp can share one Azure resource group.
#
# Usage:
#   ./scripts/deploy-azure.sh
#   ./scripts/deploy-azure.sh --help
#   ./scripts/deploy-azure.sh --app rigour-mcp --rg rigour-rg --location eastus

set -euo pipefail

APP_NAME="rigour-mcp"
RESOURCE_GROUP="rigour-rg"
LOCATION="eastus"
CONTAINER_ENV="rigour-env"
LOG_WORKSPACE="rigour-logs"
ACR_NAME="${ACR_NAME:-rigourrg}"
IMAGE_REPO="rigour-mcp"
TARGET_PORT="8080"
MIN_REPLICAS="1"
MAX_REPLICAS="2"

print() {
  printf '%s\n' "$1"
}

usage() {
  cat <<USAGE
Usage: ./scripts/deploy-azure.sh [options]

Options:
  --app <name>           Container App name (default: rigour-mcp)
  --rg <name>            Resource Group (default: rigour-rg)
  --location <region>    Azure region (default: eastus)
  --env <name>           Container Apps environment (default: rigour-env)
  --logs <name>          Log Analytics workspace (default: rigour-logs)
  --acr <name>           ACR name (default: rigourrg)
  --image-repo <name>    Image repo name in ACR (default: rigour-mcp)
  --min <n>              Min replicas (default: 1)
  --max <n>              Max replicas (default: 2)
  --help                 Show this help

Optional env vars:
  RIGOUR_MCP_TOKEN       Optional token; set as Container App secret/env
  IMAGE_TAG              Optional fixed image tag; default <sha>-<timestamp>
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_NAME="$2"; shift 2 ;;
    --rg)
      RESOURCE_GROUP="$2"; shift 2 ;;
    --location)
      LOCATION="$2"; shift 2 ;;
    --env)
      CONTAINER_ENV="$2"; shift 2 ;;
    --logs)
      LOG_WORKSPACE="$2"; shift 2 ;;
    --acr)
      ACR_NAME="$2"; shift 2 ;;
    --image-repo)
      IMAGE_REPO="$2"; shift 2 ;;
    --min)
      MIN_REPLICAS="$2"; shift 2 ;;
    --max)
      MAX_REPLICAS="$2"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      print "ERROR: Unknown argument: $1"
      usage
      exit 1 ;;
  esac
done

if ! command -v az >/dev/null 2>&1; then
  print "ERROR: Azure CLI not found"
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  print "ERROR: git not found"
  exit 1
fi

if [[ ! "$ACR_NAME" =~ ^[a-z0-9]{5,50}$ ]]; then
  print "ERROR: ACR_NAME must be 5-50 chars, lowercase letters and numbers only."
  exit 1
fi

if ! az account show >/dev/null 2>&1; then
  print "ERROR: Azure CLI is not logged in. Run: az login"
  exit 1
fi


# Ensure Container Apps commands are available non-interactively.
az extension add --name containerapp --upgrade --allow-preview true --only-show-errors >/dev/null

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M%S)}"

print "[1/8] Ensuring resource group: $RESOURCE_GROUP"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

print "[2/8] Ensuring ACR: $ACR_NAME"
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create \
    --name "$ACR_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Basic \
    --admin-enabled true \
    --output none
fi

print "[3/8] Building and pushing image in ACR"
az acr build \
  --registry "$ACR_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "${IMAGE_REPO}:${IMAGE_TAG}" \
  --file Dockerfile \
  .

ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer -o tsv)"
IMAGE_URI="${ACR_LOGIN_SERVER}/${IMAGE_REPO}:${IMAGE_TAG}"
ACR_USERNAME="$(az acr credential show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query username -o tsv)"
ACR_PASSWORD="$(az acr credential show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query 'passwords[0].value' -o tsv)"

print "[4/8] Ensuring Log Analytics workspace: $LOG_WORKSPACE"
az monitor log-analytics workspace create \
  --resource-group "$RESOURCE_GROUP" \
  --workspace-name "$LOG_WORKSPACE" \
  --location "$LOCATION" \
  --output none

LOG_WORKSPACE_ID="$(az monitor log-analytics workspace show --resource-group "$RESOURCE_GROUP" --workspace-name "$LOG_WORKSPACE" --query customerId -o tsv)"
LOG_WORKSPACE_KEY="$(az monitor log-analytics workspace get-shared-keys --resource-group "$RESOURCE_GROUP" --workspace-name "$LOG_WORKSPACE" --query primarySharedKey -o tsv)"

print "[5/8] Ensuring Container Apps environment: $CONTAINER_ENV"
if ! az containerapp env show --name "$CONTAINER_ENV" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp env create \
    --name "$CONTAINER_ENV" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --logs-workspace-id "$LOG_WORKSPACE_ID" \
    --logs-workspace-key "$LOG_WORKSPACE_KEY" \
    --output none
fi

print "[6/8] Creating or updating Container App: $APP_NAME"
if az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  if [[ -n "${RIGOUR_MCP_TOKEN:-}" ]]; then
    az containerapp secret set \
      --name "$APP_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --secrets mcp-token="$RIGOUR_MCP_TOKEN" \
      --output none

    az containerapp update \
      --name "$APP_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --image "$IMAGE_URI" \
      --set-env-vars NODE_ENV=production PORT="$TARGET_PORT" RIGOUR_MCP_MODE=control_plane RIGOUR_MCP_TOKEN=secretref:mcp-token \
      --min-replicas "$MIN_REPLICAS" \
      --max-replicas "$MAX_REPLICAS" \
      --output none
  else
    az containerapp update \
      --name "$APP_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --image "$IMAGE_URI" \
      --set-env-vars NODE_ENV=production PORT="$TARGET_PORT" RIGOUR_MCP_MODE=control_plane \
      --min-replicas "$MIN_REPLICAS" \
      --max-replicas "$MAX_REPLICAS" \
      --output none
  fi
else
  if [[ -n "${RIGOUR_MCP_TOKEN:-}" ]]; then
    az containerapp create \
      --name "$APP_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --environment "$CONTAINER_ENV" \
      --image "$IMAGE_URI" \
      --ingress external \
      --target-port "$TARGET_PORT" \
      --registry-server "$ACR_LOGIN_SERVER" \
      --registry-username "$ACR_USERNAME" \
      --registry-password "$ACR_PASSWORD" \
      --secrets mcp-token="$RIGOUR_MCP_TOKEN" \
      --env-vars NODE_ENV=production PORT="$TARGET_PORT" RIGOUR_MCP_MODE=control_plane RIGOUR_MCP_TOKEN=secretref:mcp-token \
      --min-replicas "$MIN_REPLICAS" \
      --max-replicas "$MAX_REPLICAS" \
      --output none
  else
    az containerapp create \
      --name "$APP_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --environment "$CONTAINER_ENV" \
      --image "$IMAGE_URI" \
      --ingress external \
      --target-port "$TARGET_PORT" \
      --registry-server "$ACR_LOGIN_SERVER" \
      --registry-username "$ACR_USERNAME" \
      --registry-password "$ACR_PASSWORD" \
      --env-vars NODE_ENV=production PORT="$TARGET_PORT" RIGOUR_MCP_MODE=control_plane \
      --min-replicas "$MIN_REPLICAS" \
      --max-replicas "$MAX_REPLICAS" \
      --output none
  fi
fi

print "[7/8] Fetching endpoint"
FQDN="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"

print "[8/8] Deployment complete"
print "App: $APP_NAME"
print "Image: $IMAGE_URI"
print "MCP URL: https://${FQDN}/api/mcp"
print "Health URL: https://${FQDN}/api/health"
