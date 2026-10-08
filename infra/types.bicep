@export()
@description('A model deployment on the Foundry resource.')
type modelDeployment = {
  @description('Deployment name. The skillset, vectorizer and knowledge base reference this name.')
  name: string

  @description('Model name, e.g. gpt-5.6-sol.')
  model: string

  @description('Model version, e.g. 2026-07-09.')
  version: string

  @description('Deployment type, e.g. GlobalStandard.')
  sku: string

  @description('Capacity in thousands of tokens per minute.')
  capacity: int
}
