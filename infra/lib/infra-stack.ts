import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';
import { buildTemporalUserData } from './temporal-user-data';

// Keep these in sync with temporal/.env.example so the AWS deployment matches
// what's been run/tested locally via docker-compose.
const TEMPORAL_VERSION = '1.29.1';
const TEMPORAL_UI_VERSION = '2.34.0';
const POSTGRES_VERSION = '16';

// Keep in sync with the OPENSEARCH_INDEX default in workers/main.go.
const OPENSEARCH_INDEX = 'video-analysis';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Public subnet so the Temporal EC2 instance can get a stable, directly-reachable
    // address for the UI; private-with-egress for the Lambda and RDS, which only need
    // to talk to Temporal/AWS services, never to be reached from outside the VPC.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const videosBucket = new s3.Bucket(this, 'VideosBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // POC: bucket (and whatever's in it) goes away with `cdk destroy`, no leftover billing.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const videoUploadQueue = new sqs.Queue(this, 'VideoUploadQueue', {
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    videosBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(videoUploadQueue),
      { prefix: 'videos/' },
    );

    // --- Temporal (self-hosted on EC2; Postgres runs as a container on the same instance) ---

    const temporalSecurityGroup = new ec2.SecurityGroup(this, 'TemporalSg', {
      vpc,
      description: 'Temporal server (EC2)',
      allowAllOutbound: true,
    });

    // Empty by default: until this is set (`cdk deploy --parameters TemporalUiAllowedCidr=x.x.x.x/32`),
    // port 8080 stays closed rather than risking a wide-open UI with no login in front of it.
    const temporalUiAllowedCidr = new cdk.CfnParameter(this, 'TemporalUiAllowedCidr', {
      type: 'String',
      default: '',
      description: 'CIDR allowed to reach the Temporal UI (port 8080). Leave blank to keep it closed.',
    });

    const temporalUiCidrProvided = new cdk.CfnCondition(this, 'TemporalUiCidrProvided', {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(temporalUiAllowedCidr.valueAsString, '')),
    });

    const temporalUiIngress = new ec2.CfnSecurityGroupIngress(this, 'TemporalUiIngress', {
      groupId: temporalSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 8080,
      toPort: 8080,
      cidrIp: temporalUiAllowedCidr.valueAsString,
      description: 'Temporal UI access',
    });
    temporalUiIngress.cfnOptions.condition = temporalUiCidrProvided;

    const temporalInstanceRole = new iam.Role(this, 'TemporalInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const temporalEip = new ec2.CfnEIP(this, 'TemporalEip', { domain: 'vpc' });
    const temporalUiOrigin = `http://${temporalEip.ref}:8080`;

    const userData = buildTemporalUserData({
      temporalVersion: TEMPORAL_VERSION,
      temporalUiVersion: TEMPORAL_UI_VERSION,
      postgresVersion: POSTGRES_VERSION,
      temporalUiOrigin,
    });

    const temporalInstance = new ec2.Instance(this, 'TemporalInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: temporalSecurityGroup,
      role: temporalInstanceRole,
      userData,
    });

    new ec2.CfnEIPAssociation(this, 'TemporalEipAssociation', {
      allocationId: temporalEip.attrAllocationId,
      instanceId: temporalInstance.instanceId,
    });

    // --- Lambda: S3 event (via SQS) -> StartWorkflowExecution ---

    const startVideoWorkflowSecurityGroup = new ec2.SecurityGroup(this, 'StartVideoWorkflowSg', {
      vpc,
      description: 'start-video-workflow Lambda',
      allowAllOutbound: true,
    });

    temporalSecurityGroup.addIngressRule(startVideoWorkflowSecurityGroup, ec2.Port.tcp(7233), 'Lambda -> Temporal frontend');

    // CDK's default Lambda-managed log group is RETAIN + 2yr retention, which survives
    // `cdk destroy`. POC: destroy it with the stack, keep retention short.
    const startVideoWorkflowLogGroup = new logs.LogGroup(this, 'StartVideoWorkflowFnLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const startVideoWorkflowFn = new NodejsFunction(this, 'StartVideoWorkflowFn', {
      entry: path.join(__dirname, '../lambda/start-video-workflow/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [startVideoWorkflowSecurityGroup],
      logGroup: startVideoWorkflowLogGroup,
      environment: {
        TEMPORAL_ADDRESS: `${temporalInstance.instancePrivateIp}:7233`,
        TEMPORAL_NAMESPACE: 'default',
        TEMPORAL_TASK_QUEUE: 'video-processing',
        VIDEO_WORKFLOW_TYPE: 'ProcessVideoWorkflow',
      },
    });

    startVideoWorkflowFn.addEventSource(new SqsEventSource(videoUploadQueue, {
      batchSize: 5,
      reportBatchItemFailures: true,
    }));

    // --- API: DynamoDB table + ECS Fargate service behind a public ALB ---

    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'Users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // POC: table (and its data) goes away with `cdk destroy`.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    usersTable.addGlobalSecondaryIndex({
      indexName: 'EmailIndex',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
    });

    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiCluster = new ecs.Cluster(this, 'ApiCluster', { vpc });

    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster: apiCluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../api')),
        containerPort: 8080,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: apiLogGroup }),
        secrets: {
          JWT_SECRET_KEY: ecs.Secret.fromSecretsManager(jwtSecret),
        },
        environment: {
          PORT: '8080',
          JWT_EXPIRES_IN: '24h',
          AWS_REGION: this.region,
          DYNAMODB_USERS_TABLE: usersTable.tableName,
          DYNAMODB_USERS_EMAIL_INDEX: 'EmailIndex',
          VIDEOS_BUCKET: videosBucket.bucketName,
          VIDEO_UPLOAD_LIMIT: '50mb',
        },
      },
    });

    apiService.targetGroup.configureHealthCheck({ path: '/health' });

    // Scoped to exactly what api/src/data-access does today (PutItem + Query-by-email,
    // presigned PutObject) rather than the broader grantReadWriteData()/grantWrite() defaults.
    apiService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [usersTable.tableArn],
    }));
    apiService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${usersTable.tableArn}/index/EmailIndex`],
    }));
    apiService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${videosBucket.bucketArn}/*`],
    }));
    apiService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      // VerifyEmailIdentity doesn't support resource-level permissions — it's what
      // creates the identity, so there's no ARN to scope to beforehand.
      actions: ['ses:VerifyEmailIdentity'],
      resources: ['*'],
    }));

    // --- Worker: OpenSearch (results) + SES (notification email) + ECS Fargate service ---

    // CDK creates this as an SES identity below; check this address's inbox for AWS's
    // verification email after deploying (SES starts in sandbox mode either way, so
    // recipients need verifying too until the account is moved out of it).
    const sesSenderEmail = new cdk.CfnParameter(this, 'SesSenderEmail', {
      type: 'String',
      description: 'Email address the video-analysis worker sends completion notifications from.',
    });

    const senderIdentity = new ses.EmailIdentity(this, 'SenderIdentity', {
      identity: ses.Identity.email(sesSenderEmail.valueAsString),
    });

    // Public (non-VPC) domain: reachable over the NAT gateway the private subnet
    // already has, and access-controlled via IAM (see grantIndexReadWrite below)
    // instead of the extra VPC/security-group wiring a VPC-attached domain needs.
    const searchDomain = new opensearch.Domain(this, 'SearchDomain', {
      version: opensearch.EngineVersion.OPENSEARCH_2_19,
      // Single node, single AZ: t3.small.search doesn't support the Multi-AZ-with-standby
      // default this CDK app's feature flags would otherwise turn on.
      capacity: { dataNodes: 1, dataNodeInstanceType: 't3.small.search', multiAzWithStandbyEnabled: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc,
      description: 'video-processing worker',
      allowAllOutbound: true,
    });

    temporalSecurityGroup.addIngressRule(workerSecurityGroup, ec2.Port.tcp(7233), 'Worker -> Temporal frontend');

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      // ffmpeg (video splitting) needs more headroom than the API's plain request handling.
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    workerTaskDefinition.addContainer('WorkerContainer', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../workers')),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: workerLogGroup }),
      environment: {
        TEMPORAL_ADDRESS: `${temporalInstance.instancePrivateIp}:7233`,
        TEMPORAL_NAMESPACE: 'default',
        OPENSEARCH_ENDPOINT: `https://${searchDomain.domainEndpoint}`,
        OPENSEARCH_INDEX: OPENSEARCH_INDEX,
        DYNAMODB_USERS_TABLE: usersTable.tableName,
        SENDER_EMAIL: sesSenderEmail.valueAsString,
        AWS_REGION: this.region,
      },
    });

    new ecs.FargateService(this, 'WorkerService', {
      cluster: apiCluster,
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [workerSecurityGroup],
    });

    // Matches what workers/activity_split.go, activity_analyze.go and activity_store.go
    // actually call, same scoped-permissions approach as the API's task role above.
    workerTaskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${videosBucket.bucketArn}/videos/*`, `${videosBucket.bucketArn}/fragments/*`],
    }));
    workerTaskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${videosBucket.bucketArn}/fragments/*`],
    }));
    workerTaskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      // Rekognition's video label-detection actions don't support resource-level permissions.
      actions: ['rekognition:StartLabelDetection', 'rekognition:GetLabelDetection'],
      resources: ['*'],
    }));
    workerTaskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [usersTable.tableArn],
    }));
    searchDomain.grantIndexReadWrite(OPENSEARCH_INDEX, workerTaskDefinition.taskRole);
    senderIdentity.grantSendEmail(workerTaskDefinition.taskRole);

    new cdk.CfnOutput(this, 'VideosBucketName', { value: videosBucket.bucketName });
    new cdk.CfnOutput(this, 'TemporalUiUrl', { value: temporalUiOrigin });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `http://${apiService.loadBalancer.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'SearchDomainEndpoint', { value: searchDomain.domainEndpoint });
  }
}
