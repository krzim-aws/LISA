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

import { CfnOutput } from 'aws-cdk-lib';
import { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { SecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { AmiHardwareType } from 'aws-cdk-lib/aws-ecs';
import { IRole } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { dump as yamlDump } from 'js-yaml';

import { ServerCluster } from './cluster';
import { BaseProps, Ec2Metadata, EcsSourceType, FastApiContainerConfig } from '../schema';

// This is the amount of memory to buffer (or subtract off) from the total instance memory, if we don't include this,
// the container can have a hard time finding available RAM resources to start and the tasks will fail deployment
const CONTAINER_MEMORY_BUFFER = 1024 * 2;

/**
 * Properties for FastApiContainer Construct.
 *
 * @property {IVpc} vpc - The virtual private cloud (VPC).
 * @property {SecurityGroup} securityGroups - The security groups of the application.
 * @property {string} apiName - The name of the API.
 * @property {FastApiContainerConfig} taskConfig - The configuration for the task.
 * @property {string} modelsPsName - The name of the models Parameter Store value.
 * @property {ITable} tokenTable - The DynamoDB table for API tokens.
 */
interface FastApiContainerProps extends BaseProps {
  apiName: string;
  securityGroup: SecurityGroup;
  taskConfig: FastApiContainerConfig;
  tokenTable: ITable;
  modelsPsName: string;
  vpc: IVpc;
}

/**
 * FastApiContainer Construct.
 */
export class FastApiContainer extends Construct {
  /** FastAPI IAM task role */
  public readonly taskRole: IRole;

  /** FastAPI URL **/
  public readonly endpoint: string;

  /**
   * @param {Construct} scope - The parent or owner of the construct.
   * @param {string} id - The unique identifier for the construct within its scope.
   * @param {RestApiProps} props - The properties of the construct.
   */
  constructor(scope: Construct, id: string, props: FastApiContainerProps) {
    super(scope, id);

    const { config, apiName, securityGroup, taskConfig, tokenTable, modelsPsName, vpc } = props;

    let buildArgs: Record<string, string> | undefined = undefined;
    let environment: Record<string, string> = {};
    if (taskConfig.containerConfig && taskConfig.containerConfig.image.type === EcsSourceType.ASSET) {
      buildArgs = {
        BASE_IMAGE: taskConfig.containerConfig.image.baseImage,
        PYPI_INDEX_URL: config.pypiConfig.indexUrl,
        PYPI_TRUSTED_HOST: config.pypiConfig.trustedHost,
        LITELLM_CONFIG: yamlDump(config.litellmConfig),
      };
    } else {
      environment = {
        ...environment,
        PYPI_INDEX_URL: config.pypiConfig.indexUrl,
        PYPI_TRUSTED_HOST: config.pypiConfig.trustedHost,
        LITELLM_CONFIG: yamlDump(config.litellmConfig),
      };
    }

    environment = {
      ...environment,
      LOG_LEVEL: config.logLevel,
      AWS_REGION: config.region,
      AWS_REGION_NAME: config.region, // for supporting SageMaker endpoints in LiteLLM
      THREADS: Ec2Metadata.get(taskConfig.instanceType).vCpus.toString(),
      AUTHORITY: config.authConfig.authority,
      CLIENT_ID: config.authConfig.clientId,
      TOKEN_TABLE_NAME: tokenTable.tableName,
      REGISTERED_MODELS_PS_NAME: modelsPsName,
    };

    const apiCluster = new ServerCluster(scope, `${id}-Cluster`, {
      config,
      amiHardwareType: AmiHardwareType.STANDARD,
      taskConfig: taskConfig,
      buildArgs,
      containerMemoryBuffer: CONTAINER_MEMORY_BUFFER,
      environment,
      identifier: apiName,
      internetFacing: true,
      securityGroup,
      vpc,
    });

    tokenTable.grantReadData(apiCluster.taskRole);

    this.endpoint = apiCluster.endpointUrl;

    // Update
    this.taskRole = apiCluster.taskRole;

    // CFN output
    new CfnOutput(this, `${apiName}Url`, {
      value: apiCluster.endpointUrl,
    });
  }
}
