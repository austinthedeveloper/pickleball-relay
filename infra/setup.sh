#!/usr/bin/env bash
# One-time Azure setup for the relay, run from a Mac signed in with `az login`
# and `gh auth login`. Safe to run again: each step reuses what exists.
#   1. turn on Container Apps for the subscription (free);
#   2. the resource group, in East US;
#   3. an app registration GitHub signs in as (OIDC: no password or secret
#      stored anywhere), allowed to change this resource group only;
#   4. a $5 monthly budget with email alerts (to the signed-in Azure address);
#   5. the IDs the deploy workflow needs, as GitHub repo variables.
set -euo pipefail

REPO=austinthedeveloper/pickleball-relay
RG=pickleball-relay
LOCATION=eastus
APP_NAME=pickleball-relay-deploy
here="$(cd "$(dirname "$0")" && pwd)"

SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
EMAIL=$(az account show --query user.name -o tsv)
echo "subscription $SUB, tenant $TENANT, alerts to $EMAIL"

echo "== 1. Container Apps on the subscription"
az provider register --namespace Microsoft.App --wait

echo "== 2. resource group $RG in $LOCATION"
az group create --name "$RG" --location "$LOCATION" --tags project=pickleball-relay -o none

echo "== 3. GitHub's sign-in: app registration $APP_NAME"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
fi
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)
if [ -z "$SP_ID" ]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
fi
# GitHub's tokens name the owner and repo with their IDs as well
# (repo:owner@id/name@id:...), so a renamed or re-created repo can't sign in.
SUBJECT=$(gh api "repos/$REPO" --jq '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):ref:refs/heads/main"')
HAVE=$(az ad app federated-credential list --id "$APP_ID" --query "[?name=='github-main'].subject" -o tsv)
if [ -n "$HAVE" ] && [ "$HAVE" != "$SUBJECT" ]; then
  az ad app federated-credential delete --id "$APP_ID" --federated-credential-id github-main
  HAVE=""
fi
if [ -z "$HAVE" ]; then
  az ad app federated-credential create --id "$APP_ID" -o none --parameters "{
    \"name\": \"github-main\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$SUBJECT\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"
fi
SCOPE="/subscriptions/$SUB/resourceGroups/$RG"
if [ -z "$(az role assignment list --assignee "$SP_ID" --scope "$SCOPE" --role Contributor --query "[0].id" -o tsv)" ]; then
  # A new service principal can take a few seconds to be visible to role assignments.
  for i in 1 2 3 4 5 6; do
    az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
      --role Contributor --scope "$SCOPE" -o none && break
    sleep 10
  done
fi

echo "== 4. the budget: \$5 a month, alerts to $EMAIL"
az deployment group create --resource-group "$RG" --name budget --template-file "$here/budget.bicep" \
  --parameters email="$EMAIL" startDate="$(date +%Y-%m-01)" -o none

echo "== 5. the workflow's IDs, as repo variables on $REPO"
gh variable set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
gh variable set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUB"

echo "done: push to main (or run the deploy workflow) to deploy"
