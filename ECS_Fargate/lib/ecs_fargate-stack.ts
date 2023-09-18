import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as elasticloadbalancing from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as waf from 'aws-cdk-lib/aws-waf';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';


interface ECSStackProps extends cdk.StackProps {
  clientName: string;
  environment: string;
  domain: string;
  taskEnv: { [key: string]: string };
  vpcId: string;
}

export class EcsFargateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: ECSStackProps) {
    super(scope, id, props);

    const clientName = props?.clientName;
    const clientPrefix = `${clientName}-${props?.environment}-server`;

    //Creacion de VPC
    const vpc = new ec2.Vpc(this, `${clientPrefix}-vpc`, { maxAzs: 2 });

    const repository = new ecr.Repository(this, `${clientPrefix}-repository`, {
      repositoryName: `${clientPrefix}-repository`,
    });

    //Creacion de hosted Zone Route53

    const zone = new route53.HostedZone(this, `${clientPrefix}-zone`, {
      zoneName: 'example.com',
    });

    const cert = new acm.Certificate(this, 'Certificate', {
      domainName: 'example.com',
      certificateName: 'Hello World Service', // Optionally provide an certificate name
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // LoadBalancer
    const alb = new elasticloadbalancing.ApplicationLoadBalancer(this, `alb`, {
      vpc,
      vpcSubnets: { subnets: vpc.publicSubnets },
      internetFacing: true,
    });

    const cloudFrontWaf = new waf.CfnWebACL(this, `cfn-waf`, {
      name: 'example-name',
      metricName: 'example-metric',
      defaultAction: {
        type: "Allow"
      },
      rules: []
    });

    new cloudfront.Distribution(this, `cf-distribution`, {
      defaultBehavior: { origin: new origins.LoadBalancerV2Origin(alb) },
      domainNames: ["example.com"],
      certificate: cert,
      webAclId: cloudFrontWaf.ref
    });

    const targetGroupHttp = new elasticloadbalancing.ApplicationTargetGroup(this, `target-group`, {
      port: 80,
      vpc,
      protocol: elasticloadbalancing.ApplicationProtocol.HTTP,
      targetType: elasticloadbalancing.TargetType.IP,
    });

    // Verificar el estado de salud del contenedor, cuando este desplegado correctamente

    targetGroupHttp.configureHealthCheck({
      path: "/api/status",
      protocol: elasticloadbalancing.Protocol.HTTP,
    });

    // Habilitar conexiones HTTPS

    const listener = alb.addListener("alb-listener", {
      open: true,
      port: 443,
      certificates: [cert]
    });

    listener.addTargetGroups("alb-listener-target-group", {
      targetGroups: [targetGroupHttp],
    });

    // Uso de security group para asegurar una conexion segura con el balanceador y los contenedores

    const albSG = new ec2.SecurityGroup(this, "alb-SG", {
      vpc,
      allowAllOutbound: true,
    });

    albSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow https traffic"
    );

    alb.addSecurityGroup(albSG);

    //Cluster deploy resoruces to

    const cluster = new ecs.Cluster(this, "Example-cluster", {
      clusterName: "example-cluster",
      vpc,
    });

    //Rol para asumir tarea para los containers

    const taskRole = new iam.Role(this, "task-role", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: "task-role",
      description: "Role that the api task definitions use to run the api code",
    });

    taskRole.attachInlinePolicy(new iam.Policy(this, "task-policy", {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["SES:*"],
          resources: ["*"],
        }),
      ],
    }));

    // Task definition

    const taskDefinition = new ecs.TaskDefinition(this, "task", {
      family: "task",
      compatibility: ecs.Compatibility.EC2_AND_FARGATE,
      cpu: "256",
      memoryMiB: "512",
      networkMode: ecs.NetworkMode.AWS_VPC,
      taskRole: taskRole,
    });

    // Imagen a cargar al docker

    const image = ecs.RepositoryImage.fromEcrRepository(repository, "latest");

    const container = taskDefinition.addContainer(`${clientPrefix}-comtainer`, {
      image: image,
      memoryLimitMiB: 512,
      environment: props?.taskEnv,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: clientPrefix }),
    });

    container.addPortMappings({ containerPort: 80 });

    const ecsSG = new ec2.SecurityGroup(this, `${clientPrefix}-ecsSG`, {
      vpc,
      allowAllOutbound: true,
    });

    ecsSG.connections.allowFrom(
      albSG,
      ec2.Port.allTcp(),
      "Application load balancer"
    );

    const service = new ecs.FargateService(this, `${clientPrefix}-service`, {
      cluster,
      desiredCount: 1,
      taskDefinition,
      securityGroups: [ecsSG],
      assignPublicIp: true,
    });

    service.attachToApplicationTargetGroup(targetGroupHttp);

    const scalableTarget = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });

    scalableTarget.scaleOnMemoryUtilization(`${clientPrefix}-ScaleUpMen`, {
      targetUtilizationPercent: 75,
    });

    scalableTarget.scaleOnCpuUtilization(`${clientPrefix}-ScalableUpCPU`, {
      targetUtilizationPercent: 75
    });

    // outputs to be used in code deployments
    new cdk.CfnOutput(this, `${props?.environment}ServiceName`, {
      exportName: `${props?.environment}ServiceName`,
      value: service.serviceName,
    });

    new cdk.CfnOutput(this, `${props?.environment}ImageRepositoryUri`, {
      exportName: `${props?.environment}ImageRepositoryUri`,
      value: repository.repositoryUri,
    });

    new cdk.CfnOutput(this, `${props?.environment}ImageName`, {
      exportName: `${props?.environment}ImageName`,
      value: image.imageName,
    });

    new cdk.CfnOutput(this, `${props?.environment}ClusterName`, {
      exportName: `${props?.environment}ClusterName`,
      value: cluster.clusterName,
    });
  }
}
