import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as path from 'path';

// Keep these in sync with temporal/.env.example so the AWS deployment matches
// what's been run/tested locally via docker-compose.
const TEMPORAL_VERSION = '1.29.1';
const TEMPORAL_UI_VERSION = '2.34.0';
const POSTGRES_VERSION = '16';

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

    // No default: until this is set, port 8080 stays closed rather than risking a
    // wide-open UI with no login in front of it.
    const uiAllowedCidr = process.env.TEMPORAL_UI_ALLOWED_CIDR;
    if (uiAllowedCidr) {
      temporalSecurityGroup.addIngressRule(ec2.Peer.ipv4(uiAllowedCidr), ec2.Port.tcp(8080), 'Temporal UI access');
    } else {
      console.warn('TEMPORAL_UI_ALLOWED_CIDR not set — Temporal UI (port 8080) will not be reachable until you set it and redeploy.');
    }

    const temporalInstanceRole = new iam.Role(this, 'TemporalInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const temporalEip = new ec2.CfnEIP(this, 'TemporalEip', { domain: 'vpc' });
    const temporalUiOrigin = `http://${temporalEip.ref}:8080`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y docker',
      'systemctl enable --now docker',
      'docker network create temporal-network',
      // Fixed local creds, not Secrets Manager — Postgres is only reachable from inside
      // this instance's docker network, never exposed to the host or the VPC.
      [
        'docker run -d --name temporal-postgresql --restart unless-stopped --network temporal-network',
        '-e POSTGRES_USER=temporal',
        '-e POSTGRES_PASSWORD=temporal',
        '-v temporal-postgres-data:/var/lib/postgresql/data',
        `postgres:${POSTGRES_VERSION}`,
      ].join(' '),
      'until docker exec temporal-postgresql pg_isready -U temporal > /dev/null 2>&1; do sleep 2; done',
      // No DYNAMIC_CONFIG_FILE_PATH override here on purpose — the repo's local dev
      // config enables system.forceSearchAttributesCacheRefreshOnRead, which its own
      // comment flags as dev-only. This uses the image's built-in defaults instead.
      [
        'docker run -d --name temporal --restart unless-stopped --network temporal-network',
        '-e DB=postgres12',
        '-e DB_PORT=5432',
        '-e POSTGRES_USER=temporal',
        '-e POSTGRES_PWD=temporal',
        '-e POSTGRES_SEEDS=temporal-postgresql',
        '-p 7233:7233',
        `temporalio/auto-setup:${TEMPORAL_VERSION}`,
      ].join(' '),
      [
        'docker run -d --name temporal-ui --restart unless-stopped --network temporal-network',
        '-e TEMPORAL_ADDRESS=temporal:7233',
        `-e TEMPORAL_CORS_ORIGINS=${temporalUiOrigin}`,
        '-p 8080:8080',
        `temporalio/ui:${TEMPORAL_UI_VERSION}`,
      ].join(' '),
    );

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

    usersTable.grantReadWriteData(apiService.taskDefinition.taskRole);
    videosBucket.grantWrite(apiService.taskDefinition.taskRole);

    new cdk.CfnOutput(this, 'VideosBucketName', { value: videosBucket.bucketName });
    new cdk.CfnOutput(this, 'TemporalUiUrl', { value: temporalUiOrigin });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `http://${apiService.loadBalancer.loadBalancerDnsName}` });
  }
}
