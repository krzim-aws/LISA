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

// Server Cluster Construct.
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AutoScalingGroup,
  BlockDeviceVolume,
  GroupMetrics,
  Monitoring,
  UpdatePolicy,
} from 'aws-cdk-lib/aws-autoscaling';
import { Metric, Stats } from 'aws-cdk-lib/aws-cloudwatch';
import { InstanceType, LookupMachineImage, SecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import {
  AmiHardwareType,
  Cluster,
  ContainerImage,
  Ec2Service,
  Ec2ServiceProps,
  Ec2TaskDefinition,
  EcsOptimizedImage,
  HealthCheck,
  Host,
  LinuxParameters,
  LogDriver,
  MountPoint,
  Protocol,
  Volume,
} from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, BaseApplicationListenerProps } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IRole, ManagedPolicy, Role } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { createCdkId } from '../core/utils';
import { BaseProps, Ec2Metadata, EcsSourceType, ServerType, TaskConfig } from '../schema';

/**
 * Properties for the ServerCluster Construct.
 *
 * @property {AmiHardwareType} amiHardwareType - Hardware type for optimized ECS AMI.
 * @property {TaskConfig} taskConfig - The configuration for the task.
 * @property {Record<string,string>} buildArgs - Optional build args to be applied when creating the
 *                                              task container if containerConfig.image.type is ASSET
 * @property {number} [containerMemoryBuffer] - This is the amount of memory to buffer (or subtract off)
 *                                                from the total instance memory, if we don't include this,
 *                                                the container can have a hard time finding available RAM
 *                                                resources to start and the tasks will fail deployment
 * @property {Record<string,string>} environment - Environment variables set on the task container
 * @property {string} identifier - The identifier for the task.
 * @property {boolean} internetFacing - Whether the ALB should be internet facing.
 * @property {SecurityGroup} securityGroup - The security group for the ALB.
 * @property {IVpc} vpc - The virtual private cloud (VPC).
 */
interface ServerClusterProps extends BaseProps {
  amiHardwareType?: AmiHardwareType;
  taskConfig: TaskConfig;
  buildArgs?: Record<string, string>;
  containerMemoryBuffer?: number;
  environment: Record<string, string>;
  identifier: string;
  internetFacing: boolean;
  securityGroup: SecurityGroup;
  vpc: IVpc;
}

/**
 * Create a cluster for EC2 or ECS based Docker tasks.
 */
export class ServerCluster extends Construct {
  /** IAM role associated with the ECS Cluster task */
  public readonly taskRole: IRole;

  /** Endpoint URL of application load balancer for the cluster. */
  public readonly endpointUrl: string;

  /**
   * @param {Construct} scope - The parent or owner of the construct.
   * @param {string} id - The unique identifier for the construct within its scope.
   * @param {ServerClusterProps} props - The properties of the construct.
   */
  constructor(scope: Construct, id: string, props: ServerClusterProps) {
    super(scope, id);
    const {
      config,
      vpc,
      securityGroup,
      taskConfig,
      amiHardwareType,
      buildArgs,
      containerMemoryBuffer,
      environment,
      identifier,
      internetFacing,
    } = props;

    const isEc2Deployment = taskConfig.serverType === ServerType.EC2;

    // Get task role
    const taskRole = Role.fromRoleArn(
      this,
      createCdkId([identifier, 'TR']),
      StringParameter.valueForStringParameter(this, `${config.deploymentPrefix}/roles/${identifier}`),
    );

    // Create ECS cluster
    let cluster;
    if (!isEc2Deployment) {
      cluster = new Cluster(this, createCdkId([identifier, 'Cl']), {
        clusterName: createCdkId([config.deploymentName, identifier], 32, 2),
        vpc: vpc,
        containerInsights: !config.region.includes('iso'),
      });
    }

    let autoScalingGroup;
    if (taskConfig.serverType === ServerType.EC2) {
      const machineImage = new LookupMachineImage({
        name: taskConfig.amiNamePattern!,
        filters: {
          state: ['available'],
        },
        owners: ['amazon'],
        windows: false,
      });

      // Create auto scaling group
      autoScalingGroup = new AutoScalingGroup(this, createCdkId([identifier, 'ASG']), {
        vpc: vpc,
        role: taskRole,
        instanceType: new InstanceType(taskConfig.instanceType),
        machineImage: machineImage,
        minCapacity: taskConfig.autoScalingConfig.minCapacity,
        maxCapacity: taskConfig.autoScalingConfig.maxCapacity,
        cooldown: Duration.seconds(taskConfig.autoScalingConfig.cooldown),
        groupMetrics: [GroupMetrics.all()],
        instanceMonitoring: Monitoring.DETAILED,
        newInstancesProtectedFromScaleIn: false,
        defaultInstanceWarmup: Duration.seconds(taskConfig.autoScalingConfig.defaultInstanceWarmup),
        updatePolicy: UpdatePolicy.rollingUpdate(),
        blockDevices: [
          {
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(30, {
              encrypted: true,
            }),
          },
        ],
      });
    } else {
      // Create auto scaling group
      autoScalingGroup = cluster!.addCapacity(createCdkId([identifier, 'ASG']), {
        instanceType: new InstanceType(taskConfig.instanceType),
        machineImage: EcsOptimizedImage.amazonLinux2(amiHardwareType),
        minCapacity: taskConfig.autoScalingConfig.minCapacity,
        maxCapacity: taskConfig.autoScalingConfig.maxCapacity,
        cooldown: Duration.seconds(taskConfig.autoScalingConfig.cooldown),
        groupMetrics: [GroupMetrics.all()],
        instanceMonitoring: Monitoring.DETAILED,
        newInstancesProtectedFromScaleIn: false,
        defaultInstanceWarmup: Duration.seconds(taskConfig.autoScalingConfig.defaultInstanceWarmup),
        blockDevices: [
          {
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(30, {
              encrypted: true,
            }),
          },
        ],
      });
    }

    // Configure user data script and mount NVMe
    const volumes: Volume[] = [];
    const mountPoints: MountPoint[] = [];
    /* eslint-disable no-useless-escape */
    let rawUserData = `#!/bin/bash
      set -e
      # Install Docker if not installed
      if ! command -v docker &> /dev/null; then
        yum -y install docker
        service docker start
      fi
    `;

    // If NVMe drive available, mount and use it
    if (Ec2Metadata.get(taskConfig.instanceType).nvmePath && !taskConfig.amiNamePattern) {
      // EC2 user data to mount ephemeral NVMe drive
      const mountPath = config.nvmeHostMountPath;
      const nvmePath = Ec2Metadata.get(taskConfig.instanceType).nvmePath;
      rawUserData += `
        # Check if NVMe is already formatted
        if ! blkid ${nvmePath}; then
            mkfs.xfs ${nvmePath}
        fi

        mkdir -p ${mountPath}
        mount ${nvmePath} ${mountPath}

        # Add to fstab if not already present
        if ! grep -q "${nvmePath}" /etc/fstab; then
            echo ${nvmePath} ${mountPath} xfs defaults,nofail 0 2 >> /etc/fstab
        fi

        # Update Docker root location and restart Docker service
        mkdir -p ${mountPath}/docker
        echo '{\"data-root\": \"${mountPath}/docker\"}' | tee /etc/docker/daemon.json
        systemctl restart docker
      `;
      /* eslint-enable no-useless-escape */

      // Create mount point for container
      const sourceVolume = 'nvme';
      const host: Host = { sourcePath: config.nvmeHostMountPath };
      const nvmeVolume: Volume = { name: sourceVolume, host: host };
      const nvmeMountPoint: MountPoint = {
        sourceVolume: sourceVolume,
        containerPath: config.nvmeContainerMountPath,
        readOnly: false,
      };
      volumes.push(nvmeVolume);
      mountPoints.push(nvmeMountPoint);
    } else if (taskConfig.amiNamePattern?.includes('Deep Learning')) {
      // DLAMIs mount the nvme to /opt/dlami/nvme for us
      rawUserData += `
        # Update Docker root location and restart Docker service
        mkdir -p /opt/dlami/nvme/docker
        echo '{"data-root": "/opt/dlami/nvme/docker"}' | tee /etc/docker/daemon.json
        systemctl restart docker
      `;
    }

    // Add permissions to use SSM in dev environment for EC2 debugging purposes only
    if (config.deploymentStage === 'dev') {
      autoScalingGroup.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMFullAccess'));
    }

    if (config.region.includes('iso')) {
      const pkiSourceVolume = 'pki';
      const pkiHost: Host = { sourcePath: '/etc/pki' };
      const pkiVolume: Volume = { name: pkiSourceVolume, host: pkiHost };
      const pkiMountPoint: MountPoint = {
        sourceVolume: pkiSourceVolume,
        containerPath: '/etc/pki',
        readOnly: false,
      };
      volumes.push(pkiVolume);
      mountPoints.push(pkiMountPoint);
      // Requires mount point /etc/pki from host
      environment.SSL_CERT_DIR = '/etc/pki/tls/certs';
      environment.SSL_CERT_FILE = config.certificateAuthorityBundle;
    }

    // Create and configure container assets
    let service;
    if (taskConfig.serverType === ServerType.EC2) {
      if (taskConfig.containerConfig.image.type !== EcsSourceType.ASSET) {
        throw new Error('Only ImageSourceAssets are supported for EC2 based deployments.');
      }
      // Build and push docker image
      const assetImage = new DockerImageAsset(this, createCdkId([identifier, 'DockerImage']), {
        directory: taskConfig.containerConfig.image.path,
        buildArgs: buildArgs,
      });

      // Add pull permissions for task role
      assetImage.repository.grantPull(taskRole);

      // Add necessary policies to the role
      taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'));
      taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

      // Update user data script
      const envVarString = Object.keys(environment)
        .map((key) => `-e ${key}="${environment[key]}"`)
        .join(' \\\n');

      let extraDockerArgs = '';
      if (Ec2Metadata.get(taskConfig.instanceType).gpuCount > 0) {
        extraDockerArgs = `--gpus all`;
      }
      /* eslint-disable no-useless-escape */
      rawUserData += `
aws ecr get-login-password --region ${config.region} | docker login --username AWS --password-stdin ${
        assetImage.repository!.repositoryUri
      }
docker pull ${assetImage.repository.repositoryUri}:${assetImage.imageTag}
docker run -d \\
  ${extraDockerArgs} --privileged \\
  -p 80:8080 \\
  ${envVarString} \\
  ${assetImage.repository.repositoryUri}:${assetImage.imageTag}
`;
      /* eslint-enable no-useless-escape */

      service = autoScalingGroup;
    } else {
      // Create ECS task definition
      const taskDefinition = new Ec2TaskDefinition(this, createCdkId([identifier, 'Ec2TaskDefinition']), {
        family: createCdkId([config.deploymentName, identifier], 32, 2),
        taskRole: taskRole,
        volumes: volumes,
      });

      // Add container to task definition
      const containerHealthCheckConfig = taskConfig.containerConfig.healthCheckConfig;
      const containerHealthCheck: HealthCheck = {
        command: containerHealthCheckConfig.command,
        interval: Duration.seconds(containerHealthCheckConfig.interval),
        startPeriod: Duration.seconds(containerHealthCheckConfig.startPeriod),
        timeout: Duration.seconds(containerHealthCheckConfig.timeout),
        retries: containerHealthCheckConfig.retries,
      };

      const linuxParameters =
        taskConfig.containerConfig.sharedMemorySize > 0
          ? new LinuxParameters(this, createCdkId([identifier, 'LinuxParameters']), {
              sharedMemorySize: taskConfig.containerConfig.sharedMemorySize,
            })
          : undefined;

      let image: ContainerImage;
      switch (taskConfig.containerConfig.image.type) {
        case EcsSourceType.ECR: {
          const repository = Repository.fromRepositoryArn(
            this,
            createCdkId([identifier, 'Repo']),
            taskConfig.containerConfig.image.repositoryArn,
          );
          image = ContainerImage.fromEcrRepository(repository, taskConfig.containerConfig.image.tag);
          break;
        }
        case EcsSourceType.REGISTRY: {
          image = ContainerImage.fromRegistry(taskConfig.containerConfig.image.registry);
          break;
        }
        case EcsSourceType.TARBALL: {
          image = ContainerImage.fromTarball(taskConfig.containerConfig.image.path);
          break;
        }
        default: {
          image = ContainerImage.fromAsset(taskConfig.containerConfig.image.path, { buildArgs: buildArgs });
          break;
        }
      }

      const container = taskDefinition.addContainer(createCdkId([identifier, 'Container']), {
        containerName: createCdkId([config.deploymentName, identifier], 32, 2),
        image,
        environment,
        logging: LogDriver.awsLogs({ streamPrefix: identifier }),
        gpuCount: Ec2Metadata.get(taskConfig.instanceType).gpuCount,
        memoryReservationMiB: Ec2Metadata.get(taskConfig.instanceType).memory - containerMemoryBuffer!,
        portMappings: [{ hostPort: 80, containerPort: 8080, protocol: Protocol.TCP }],
        healthCheck: containerHealthCheck,
        // Model containers need to run with privileged set to true
        privileged: amiHardwareType === AmiHardwareType.GPU,
        ...(linuxParameters && { linuxParameters }),
      });
      container.addMountPoints(...mountPoints);

      // Create ECS service
      const serviceProps: Ec2ServiceProps = {
        cluster: cluster!,
        daemon: true,
        serviceName: createCdkId([config.deploymentName, identifier], 32, 2),
        taskDefinition: taskDefinition,
        circuitBreaker: !config.region.includes('iso') ? { rollback: true } : undefined,
      };

      service = new Ec2Service(this, createCdkId([identifier, 'Ec2Svc']), serviceProps);

      service.node.addDependency(autoScalingGroup);
    }

    // Add final user data script to ASG
    autoScalingGroup.addUserData(rawUserData);

    // Create application load balancer
    const loadBalancer = new ApplicationLoadBalancer(this, createCdkId([identifier, 'ALB']), {
      deletionProtection: config.removalPolicy !== RemovalPolicy.DESTROY,
      internetFacing: internetFacing,
      loadBalancerName: createCdkId([config.deploymentName, identifier], 32, 2),
      dropInvalidHeaderFields: true,
      securityGroup,
      vpc,
    });

    // Add listener
    const listenerProps: BaseApplicationListenerProps = {
      port: taskConfig.loadBalancerConfig.sslCertIamArn ? 443 : 80,
      open: internetFacing,
      certificates: taskConfig.loadBalancerConfig.sslCertIamArn
        ? [{ certificateArn: taskConfig.loadBalancerConfig.sslCertIamArn }]
        : undefined,
    };

    const listener = loadBalancer.addListener(createCdkId([identifier, 'ApplicationListener']), listenerProps);
    const protocol = listenerProps.port === 443 ? 'https' : 'http';

    // Add targets
    const loadBalancerHealthCheckConfig = taskConfig.loadBalancerConfig.healthCheckConfig;
    const targetGroup = listener.addTargets(createCdkId([identifier, 'TgtGrp']), {
      targetGroupName: createCdkId([config.deploymentName, identifier], 32, 2),
      healthCheck: {
        path: loadBalancerHealthCheckConfig.path,
        interval: Duration.seconds(loadBalancerHealthCheckConfig.interval),
        timeout: Duration.seconds(loadBalancerHealthCheckConfig.timeout),
        healthyThresholdCount: loadBalancerHealthCheckConfig.healthyThresholdCount,
        unhealthyThresholdCount: loadBalancerHealthCheckConfig.unhealthyThresholdCount,
      },
      port: 80,
      targets: [service],
    });

    // ALB metric for ASG to use for auto scaling EC2 instances
    // TODO: Update this to step scaling for embedding models??
    const requestCountPerTargetMetric = new Metric({
      metricName: taskConfig.autoScalingConfig.metricConfig.AlbMetricName,
      namespace: 'AWS/ApplicationELB',
      dimensionsMap: {
        TargetGroup: targetGroup.targetGroupFullName,
        LoadBalancer: loadBalancer.loadBalancerFullName,
      },
      statistic: Stats.SAMPLE_COUNT,
      period: Duration.seconds(taskConfig.autoScalingConfig.metricConfig.duration),
    });

    // Create hook to scale on ALB metric count exceeding thresholds
    autoScalingGroup.scaleToTrackMetric(createCdkId([identifier, 'ScalingPolicy']), {
      metric: requestCountPerTargetMetric,
      targetValue: taskConfig.autoScalingConfig.metricConfig.targetValue,
      estimatedInstanceWarmup: Duration.seconds(taskConfig.autoScalingConfig.metricConfig.duration),
    });

    const domain =
      taskConfig.loadBalancerConfig.domainName !== null
        ? taskConfig.loadBalancerConfig.domainName
        : loadBalancer.loadBalancerDnsName;
    const endpoint = `${protocol}://${domain}`;
    this.endpointUrl = endpoint;

    // Update
    this.taskRole = taskRole;
  }
}
