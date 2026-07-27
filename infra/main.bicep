targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the the environment which is used to generate a short unique hash used in all resources.')
param environmentName string

@minLength(1)
@description('Primary location for all resources & Flex Consumption Function App')
@allowed([
  'australiaeast'
  'australiasoutheast'
  'brazilsouth'
  'canadacentral'
  'centralindia'
  'centralus'
  'eastasia'
  'eastus'
  'eastus2'
  'eastus2euap'
  'francecentral'
  'germanywestcentral'
  'italynorth'
  'japaneast'
  'koreacentral'
  'northcentralus'
  'northeurope'
  'norwayeast'
  'southafricanorth'
  'southcentralus'
  'southeastasia'
  'southindia'
  'spaincentral'
  'swedencentral'
  'uaenorth'
  'uksouth'
  'ukwest'
  'westcentralus'
  'westeurope'
  'westus'
  'westus2'
  'westus3'
])
@metadata({
  azd: {
    type: 'location'
  }
})
param location string

@description('Provision a VNet and a private endpoint to storage. Off by default: a private endpoint alone costs more per month than this deployment\'s entire budget, and one daily timer needs no network isolation.')
param vnetEnabled bool = false

@description('Email address for budget alerts. Deliberately has no default, so azd asks for it on first provision and the cost guardrail cannot be missed by forgetting a step. Set it explicitly to an empty string to skip the budget — the documented escape hatch if the subscription offer does not support Cost Management budgets.')
param budgetAlertEmail string

@description('Monthly spend ceiling for alerting, in USD. Notifies only; it never stops spend.')
param budgetAmount int = 5

@description('First day of the budget\'s first month. Defaulted rather than passed in — `utcNow()` is only legal in a parameter default.')
param budgetStartDate string = utcNow('yyyy-MM-01')

param workerServiceName string = ''
param applicationInsightsName string = ''
param appServicePlanName string = ''
param keyVaultName string = ''
param logAnalyticsName string = ''
param resourceGroupName string = ''
param storageAccountName string = ''
param vNetName string = ''
@description('Id of the user identity to be used for testing and debugging. This is not required in production. Leave empty if not needed.')
param principalId string = deployer().objectId

@description('What kind of principal principalId is. Locally the deployer is a signed-in user; in CI it is the pipeline\'s service principal, and a role assignment that mislabels it can be rejected.')
@allowed([
  'User'
  'ServicePrincipal'
])
param principalType string = 'User'

var abbrs = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }
var functionAppName = !empty(workerServiceName)
  ? workerServiceName
  : '${abbrs.webSitesFunctions}worker-${resourceToken}'
var deploymentStorageContainerName = 'app-package-${take(functionAppName, 32)}-${take(toLower(uniqueString(functionAppName, resourceToken)), 7)}'

// The secret's name is a contract with the one manual post-provision step and
// with nothing else — the value is never provisioned from here.
var openAiSecretName = 'openai-api-key'

// Organize resources in a resource group
resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: !empty(resourceGroupName) ? resourceGroupName : '${abbrs.resourcesResourceGroups}${environmentName}'
  location: location
  tags: tags
}

// Create an App Service Plan to group applications under the same payment plan and SKU
module appServicePlan 'br/public:avm/res/web/serverfarm:0.1.1' = {
  name: 'appserviceplan'
  scope: rg
  params: {
    name: !empty(appServicePlanName) ? appServicePlanName : '${abbrs.webServerFarms}${resourceToken}'
    sku: {
      name: 'FC1'
      tier: 'FlexConsumption'
    }
    reserved: true
    location: location
    tags: tags
  }
}

// Empty vault only. The OPENAI_API_KEY value is set once by hand after
// provisioning and never passes through Bicep, azd, or a pipeline.
module keyVault './app/keyvault.bicep' = {
  name: 'keyvault'
  scope: rg
  params: {
    name: !empty(keyVaultName) ? keyVaultName : '${abbrs.keyVaultVaults}${resourceToken}'
    location: location
    tags: tags
  }
}

module worker './app/worker.bicep' = {
  name: 'worker'
  scope: rg
  params: {
    name: functionAppName
    location: location
    tags: tags
    applicationInsightsName: monitoring.outputs.name
    appServicePlanId: appServicePlan.outputs.resourceId
    runtimeName: 'node'
    runtimeVersion: '22'
    storageAccountName: storage.outputs.name
    enableBlob: storageEndpointConfig.enableBlob
    enableQueue: storageEndpointConfig.enableQueue
    enableTable: storageEndpointConfig.enableTable
    deploymentStorageContainerName: deploymentStorageContainerName
    appSettings: {
      // Resolved at runtime by the app's own managed identity. No version in
      // the URI, so rotating the secret needs no redeploy.
      OPENAI_API_KEY: '@Microsoft.KeyVault(SecretUri=${keyVault.outputs.vaultUri}secrets/${openAiSecretName}/)'
    }
    virtualNetworkSubnetId: vnetEnabled ? serviceVirtualNetwork.outputs.appSubnetID : ''
  }
}

// Backing storage for Azure functions backend API.
//
// A platform requirement of the Functions host itself — deployment package and
// timer checkpointing — not application persistence. The worker's own code
// never reads or writes it.
module storage 'br/public:avm/res/storage/storage-account:0.8.3' = {
  name: 'storage'
  scope: rg
  params: {
    name: !empty(storageAccountName) ? storageAccountName : '${abbrs.storageStorageAccounts}${resourceToken}'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // Disable local authentication methods as per policy
    dnsEndpointType: 'Standard'
    publicNetworkAccess: vnetEnabled ? 'Disabled' : 'Enabled'
    networkAcls: vnetEnabled ? {
      defaultAction: 'Deny'
      bypass: 'None'
    } : {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
    blobServices: {
      containers: [{name: deploymentStorageContainerName}]
    }
    minimumTlsVersion: 'TLS1_2'  // Enforcing TLS 1.2 for better security
    location: location
    tags: tags
  }
}

// Define the configuration object locally to pass to the modules
var storageEndpointConfig = {
  enableBlob: true  // Required for AzureWebJobsStorage, .zip deployment, Event Hubs trigger and Timer trigger checkpointing
  enableQueue: true  // Required for Durable Functions and MCP trigger
  enableTable: false  // Required for Durable Functions and OpenAI triggers and bindings
  enableFiles: false   // Not required, used in legacy scenarios
  allowUserIdentityPrincipal: true   // Allow interactive user identity to access for testing and debugging
}

// Consolidated Role Assignments.
//
// These necessarily run after the function app exists, because a
// system-assigned identity has no principal ID until its host resource does.
// Azure grants are eventually consistent, so a first deployment can briefly
// show the app unable to reach storage before propagation completes.
module rbac 'app/rbac.bicep' = {
  name: 'rbacAssignments'
  scope: rg
  params: {
    storageAccountName: storage.outputs.name
    appInsightsName: monitoring.outputs.name
    keyVaultName: keyVault.outputs.name
    managedIdentityPrincipalId: worker.outputs.SERVICE_WORKER_IDENTITY_PRINCIPAL_ID
    userIdentityPrincipalId: principalId
    userIdentityPrincipalType: principalType
    enableBlob: storageEndpointConfig.enableBlob
    enableQueue: storageEndpointConfig.enableQueue
    enableTable: storageEndpointConfig.enableTable
    allowUserIdentityPrincipal: storageEndpointConfig.allowUserIdentityPrincipal
  }
}

// Virtual Network & private endpoint to blob storage
module serviceVirtualNetwork 'app/vnet.bicep' =  if (vnetEnabled) {
  name: 'serviceVirtualNetwork'
  scope: rg
  params: {
    location: location
    tags: tags
    vNetName: !empty(vNetName) ? vNetName : '${abbrs.networkVirtualNetworks}${resourceToken}'
  }
}

module storagePrivateEndpoint 'app/storage-PrivateEndpoint.bicep' = if (vnetEnabled) {
  name: 'servicePrivateEndpoint'
  scope: rg
  params: {
    location: location
    tags: tags
    virtualNetworkName: !empty(vNetName) ? vNetName : '${abbrs.networkVirtualNetworks}${resourceToken}'
    subnetName: vnetEnabled ? serviceVirtualNetwork.outputs.peSubnetName : '' // Keep conditional check for safety, though module won't run if !vnetEnabled
    resourceName: storage.outputs.name
    enableBlob: storageEndpointConfig.enableBlob
    enableQueue: storageEndpointConfig.enableQueue
    enableTable: storageEndpointConfig.enableTable
  }
}

// Monitor application with Azure Monitor - Log Analytics and Application Insights
module logAnalytics 'br/public:avm/res/operational-insights/workspace:0.11.1' = {
  name: '${uniqueString(deployment().name, location)}-loganalytics'
  scope: rg
  params: {
    name: !empty(logAnalyticsName) ? logAnalyticsName : '${abbrs.operationalInsightsWorkspaces}${resourceToken}'
    location: location
    tags: tags
    dataRetention: 30
  }
}

module monitoring 'br/public:avm/res/insights/component:0.6.0' = {
  name: '${uniqueString(deployment().name, location)}-appinsights'
  scope: rg
  params: {
    name: !empty(applicationInsightsName) ? applicationInsightsName : '${abbrs.insightsComponents}${resourceToken}'
    location: location
    tags: tags
    workspaceResourceId: logAnalytics.outputs.resourceId
    disableLocalAuth: true
  }
}

// Subscription-scoped rather than resource-group-scoped, so it also catches
// stray resources created outside this deployment — a portal experiment, a
// mistyped `az` command — which an RG-scoped budget would miss.
//
// A budget notifies; it never stops spend. The hard $0 ceiling today is the
// Free Trial's spending limit, and that disappears on conversion to
// pay-as-you-go. This exists so the guardrail is already there on that day.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (!empty(budgetAlertEmail)) {
  name: 'budget-${environmentName}'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      actual_GreaterThan_50_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [budgetAlertEmail]
      }
      actual_GreaterThan_90_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [budgetAlertEmail]
      }
      actual_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [budgetAlertEmail]
      }
      forecasted_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [budgetAlertEmail]
      }
    }
  }
}

// App outputs.
//
// The component's *name*, not its connection string — the starter labelled this
// output CONNECTION_STRING while assigning the name. The app never needs the
// output anyway: worker.bicep reads the real connection string directly and
// sets it as an app setting, and keeping it out of here also keeps the
// instrumentation key out of azd's environment files.
output APPLICATIONINSIGHTS_NAME string = monitoring.outputs.name
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_KEY_VAULT_NAME string = keyVault.outputs.name
output AZURE_OPENAI_SECRET_NAME string = openAiSecretName
output SERVICE_WORKER_NAME string = worker.outputs.SERVICE_WORKER_NAME
output AZURE_FUNCTION_NAME string = worker.outputs.SERVICE_WORKER_NAME
