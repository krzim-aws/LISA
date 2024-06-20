/**
  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

// LISA-serve Stack.

import { Stack, StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { Model } from './model';
import { FastApiContainer } from '../api-base/fastApiContainer';
import { createCdkId, getModelIdentifier } from '../core/utils';
import { Vpc } from '../networking/vpc';
import { BaseProps, ModelType, RegisteredModel } from '../schema';

interface CustomLisaStackProps extends BaseProps {
  vpc: Vpc;
}
type LisaStackProps = CustomLisaStackProps & StackProps;

/**
 * LisaServe Application stack.
 */
export class LisaServeApplicationStack extends Stack {
  /** FastAPI construct */
  public readonly restApi: FastApiContainer;
  public readonly modelsPs: StringParameter;
  public readonly endpointUrl: StringParameter;

  /**
   * @param {Construct} scope - The parent or owner of the construct.
   * @param {string} id - The unique identifier for the construct within its scope.
   * @param {LisaStackProps} props - Properties for the Stack.
   */
  constructor(scope: Construct, id: string, props: LisaStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;

    // Create DynamoDB Table for enabling API token usage
    const tokenTable = new Table(this, 'TokenTable', {
      tableName: `${config.deploymentName}-LISAApiTokenTable`,
      partitionKey: {
        name: 'token',
        type: AttributeType.STRING,
      },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: config.removalPolicy,
    });

    // Register all models
    const registeredModels: RegisteredModel[] = [];

    // Create ECS models
    for (const modelConfig of config.models) {
      if (modelConfig.deploy) {
        // Create ECS Model Construct
        const ecsModel = new Model(this, createCdkId([getModelIdentifier(modelConfig), 'EcsModel']), {
          config: config,
          modelConfig: modelConfig,
          securityGroup: vpc.securityGroups.ecsModelAlbSg,
          vpc: vpc.vpc,
        });

        // Create metadata to register model in parameter store
        const registeredModel: RegisteredModel = {
          provider: `${modelConfig.serverType}.${modelConfig.modelType}.${modelConfig.inferenceEngine}`,
          // modelId is used for LiteLLM config to differentiate the same model deployed with two different containers
          modelId: modelConfig.modelId ? modelConfig.modelId : modelConfig.modelName,
          modelName: modelConfig.modelName,
          modelType: modelConfig.modelType,
          endpointUrl: ecsModel.endpointUrl,
        };

        // For textgen models, add metadata whether streaming is supported
        if (modelConfig.modelType == ModelType.TEXTGEN) {
          registeredModel.streaming = modelConfig.streaming!;
        }
        registeredModels.push(registeredModel);
      }
    }

    // Create Parameter Store entry with registeredModels
    this.modelsPs = new StringParameter(this, createCdkId(['RegisteredModels', 'StringParameter']), {
      parameterName: `${config.deploymentPrefix}/registeredModels`,
      stringValue: JSON.stringify(registeredModels),
      description: 'Serialized JSON of registered models data',
    });

    // Create REST API
    const restApi = new FastApiContainer(this, 'RestApi', {
      apiName: 'REST',
      config: config,
      securityGroup: vpc.securityGroups.restApiAlbSg,
      taskConfig: config.restApiConfig,
      tokenTable: tokenTable,
      modelsPsName: this.modelsPs.parameterName,
      vpc: vpc.vpc,
    });
    restApi.node.addDependency(this.modelsPs);

    // Create Parameter Store entry with RestAPI URI
    this.endpointUrl = new StringParameter(this, createCdkId(['LisaServeRestApiUri', 'StringParameter']), {
      parameterName: `${config.deploymentPrefix}/lisaServeRestApiUri`,
      stringValue: restApi.endpoint,
      description: 'URI for LISA Serve API',
    });

    // Grant read permissions to the task role for the model parameter store
    this.modelsPs.grantRead(restApi.taskRole);

    // Update
    this.restApi = restApi;
  }
}
