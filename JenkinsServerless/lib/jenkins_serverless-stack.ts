import { Duration, IResource, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as cdk from 'aws-cdk-lib';

import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Port } from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class JenkinsServerlessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);



    // Creacion de instancia fargate 

    const jenkinsHomeDir: string = 'jenkins-home';
    const appName: string = 'jenkins-cdk';

    const cluster = new ecs.Cluster(this, `${appName}-cluster`, {
      clusterName: appName,
    });

    // Asignacion de VPC de cluster
    const vpc = cluster.vpc;


    // configuracion de EFS

    const fileSystem = new efs.FileSystem(this, `${appName}-efs`, {
      vpc: vpc,
      fileSystemName: appName,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Configuracion de puntos de acceso y puertos de entrada para EFS para datos compartidos

    const accessPoint = fileSystem.addAccessPoint(`${appName}-ap`, {
      path: `/${jenkinsHomeDir}`,
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
    });


    //Definicion de tarea de configuracion para ejecutar contenedores Docker en ECS

    const taskDefinition = new ecs.FargateTaskDefinition(this, `${appName}-task`, {
      family: appName,
      cpu: 1024,
      memoryLimitMiB: 2048
    });

    // Añadiendo Volumen
    taskDefinition.addVolume({
      name: jenkinsHomeDir,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    // Configuracion de contenedor utilizando la definicion de la tarea y la imagen de jenkins

    const containerDefinition = taskDefinition.addContainer(appName, {
      image: ecs.ContainerImage.fromRegistry('jenkins/jenkins:lts'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'jenkins' }),
      portMappings: [{ containerPort: 8080 }],
    });


    // Configuracion de volumen para contenedor

    containerDefinition.addMountPoints({
      containerPath: '/var/jenkins_home',
      sourceVolume: jenkinsHomeDir,
      readOnly: false
    });

    //Configuracion de servicio Fargate para ejecutar contenedor serverless
    const fargateService = new ecs.FargateService(this, `${appName}-service`, {
      serviceName: appName,
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      healthCheckGracePeriod: Duration.minutes(5),
    });

    fargateService.connections.allowTo(fileSystem, Port.tcp(2049));

    // Configuracion de balanceador de carga V2

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${appName}-elb`, {
      loadBalancerName: appName,
      vpc: vpc,
      internetFacing: true,
    });

    const lblistener = loadBalancer.addListener(`${appName}-listener`, {
      port: 80,
    });

    //Configurar target para enrutar solicitudes a jenkins serverless ECS fargate

    const loadBalancerTarget = lblistener.addTargets(`${appName}-target`, {
      port: 8080,
      targets: [fargateService],
      deregistrationDelay: Duration.seconds(10),
      healthCheck: { path: '/login' },
    })

  }
}
