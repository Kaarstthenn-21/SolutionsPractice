#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EcsFargateStack } from '../lib/ecs_fargate-stack';

const app = new cdk.App();
new EcsFargateStack(app, 'EcsFargateStack', {
  clientName: 'kaars',
  environment: 'dev',
  domain: 'fiorigas.pe',
  taskEnv: { task: 'Hola' },
  vpcId: ''
});