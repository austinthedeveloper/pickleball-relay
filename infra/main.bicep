// The relay on Azure Container Apps: consumption plan, scale to zero, one
// replica at most (rooms live in memory). Deployed by the workflow on every
// push to main; setup.sh makes the resource group and the budget once.
param location string = resourceGroup().location
param image string
param name string = 'pb94-relay'

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    // No appLogsConfiguration: logs go nowhere, so there's no Log Analytics bill.
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'          // HTTP/1.1 upgrades, so WebSockets work
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'relay'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '500' } } }
        ]
      }
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
