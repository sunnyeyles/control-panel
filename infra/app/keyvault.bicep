@description('Key Vault name. Capped at 24 characters by Azure — the caller builds it from the CAF abbreviation plus the resource token, which stays well inside that.')
@maxLength(24)
param name string
param location string = resourceGroup().location
param tags object = {}

@description('Days a deleted secret stays recoverable. The floor Azure permits, chosen because a stale copy of a leaked API key is a liability, not a safety net.')
param softDeleteRetentionInDays int = 7

// Provisions the vault and nothing inside it.
//
// The OPENAI_API_KEY value is set once by hand after `azd provision`:
//
//   az keyvault secret set --vault-name <name> --name openai-api-key --value <key>
//
// That step is deliberately never automated. A secret Bicep can write is a
// secret that has to exist somewhere Bicep can read — a repo, a pipeline
// variable, an azd environment file — and the whole point is that it exists in
// exactly one place, the vault.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC rather than the legacy access-policy model: access is then granted
    // with a role assignment like every other resource here, instead of a
    // second, vault-only permission system.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: null
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

output name string = keyVault.name
output resourceId string = keyVault.id
@description('Includes a trailing slash, e.g. https://kv-abc.vault.azure.net/ — callers append `secrets/<name>/`.')
output vaultUri string = keyVault.properties.vaultUri
