import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Platform as ImagePlatform } from "aws-cdk-lib/aws-ecr-assets";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cw from "aws-cdk-lib/aws-cloudwatch";

export class Foundation extends Stack {
  modelRepo: ecr.Repository;
  gatewayRepo: ecr.Repository;
  artifacts: s3.Bucket;
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.modelRepo = new ecr.Repository(this, "ModelRepo", {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.gatewayRepo = new ecr.Repository(this, "GatewayRepo", {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.artifacts = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const repo = this.node.tryGetContext("githubRepo") as string | undefined;
    if (repo) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error("githubRepo must be owner/repo");
      const existing = this.node.tryGetContext("oidcProviderArn") as
        string | undefined;
      const provider = existing
        ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            "GitHubOIDC",
            existing,
          )
        : new iam.OpenIdConnectProvider(this, "GitHubOIDC", {
            url: "https://token.actions.githubusercontent.com",
            clientIds: ["sts.amazonaws.com"],
          });
      const role = new iam.Role(this, "ReleaseRole", {
        assumedBy: new iam.WebIdentityPrincipal(
          provider.openIdConnectProviderArn,
          {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub": [
                `repo:${repo}:environment:staging`,
                `repo:${repo}:environment:production`,
              ],
            },
          },
        ),
        maxSessionDuration: Duration.hours(1),
      });
      this.modelRepo.grantPullPush(role);
      this.gatewayRepo.grantPullPush(role);
      this.artifacts.grantRead(role, "versions/*");
      this.artifacts.grantPut(role, "versions/*");
      // Bootstrap roles hold deployment permissions; this role may assume only this account/region's CDK roles.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-role-${this.account}-${this.region}`,
          ],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["cloudformation:DescribeStacks"],
          resources: [
            `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/ModelForge*/*`,
          ],
        }),
      );
      new CfnOutput(this, "ReleaseRoleArn", { value: role.roleArn });
    }
    new CfnOutput(this, "ModelRepository", {
      value: this.modelRepo.repositoryUri,
    });
    new CfnOutput(this, "GatewayRepository", {
      value: this.gatewayRepo.repositoryUri,
    });
    new CfnOutput(this, "ArtifactBucket", { value: this.artifacts.bucketName });
  }
}

export class Platform extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { foundation: Foundation },
  ) {
    super(scope, id, props);
    const value = (name: string, fallback: string) =>
      String(this.node.tryGetContext(name) ?? fallback);
    const stableVersion = value("stableVersion", "v1");
    const candidateVersion = value("candidateVersion", "v2");
    for (const version of [stableVersion, candidateVersion])
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version))
        throw new Error("Invalid version");
    const canary = value("canaryPercent", "20");
    if (!/^\d+$/.test(canary) || Number(canary) > 100)
      throw new Error("Invalid canary percentage");
    const tag = value("imageTag", "dev");
    const publicAlb = this.node.tryGetContext("publicAlb") === "true";
    const cert = this.node.tryGetContext("certificateArn") as
      string | undefined;
    const allowed = this.node.tryGetContext("allowedCidr") as
      string | undefined;
    if (publicAlb && (!cert || !allowed || allowed === "0.0.0.0/0"))
      throw new Error(
        "Public ALB requires certificateArn and a restricted allowedCidr",
      );
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      defaultCloudMapNamespace: { name: "modelforge.local" },
    });
    const gatewaySg = new ec2.SecurityGroup(this, "GatewaySG", { vpc });
    const modelSg = new ec2.SecurityGroup(this, "ModelSG", { vpc });
    modelSg.addIngressRule(gatewaySg, ec2.Port.tcp(8000), "Gateway only");
    const monitoringSg = new ec2.SecurityGroup(this, "MonitoringSG", { vpc });
    modelSg.addIngressRule(
      monitoringSg,
      ec2.Port.tcp(8000),
      "Prometheus scrapes",
    );
    gatewaySg.addIngressRule(
      monitoringSg,
      ec2.Port.tcp(8080),
      "Prometheus scrapes",
    );
    monitoringSg.addIngressRule(
      gatewaySg,
      ec2.Port.tcp(9090),
      "Read-only telemetry queries",
    );
    monitoringSg.addIngressRule(
      gatewaySg,
      ec2.Port.tcp(4318),
      "Gateway traces",
    );
    monitoringSg.addIngressRule(modelSg, ec2.Port.tcp(4318), "Model traces");
    const telemetryLogs = new logs.LogGroup(this, "TelemetryLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const metricsTask = new ecs.FargateTaskDefinition(this, "MetricsTask", {
      cpu: 256,
      memoryLimitMiB: 1024,
    });
    metricsTask.addVolume({ name: "metrics" });
    const prometheus = metricsTask.addContainer("prometheus", {
      image: ecs.ContainerImage.fromAsset(
        resolve(__dirname, "../../../observability"),
        { file: "prometheus/Dockerfile", platform: ImagePlatform.LINUX_AMD64 },
      ),
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "prometheus",
        logGroup: telemetryLogs,
      }),
      command: [
        "--config.file=/etc/prometheus/prometheus.yml",
        "--storage.tsdb.path=/prometheus",
        "--storage.tsdb.retention.time=2d",
        "--storage.tsdb.retention.size=10GB",
        "--query.max-concurrency=20",
        "--query.timeout=5s",
      ],
      portMappings: [{ containerPort: 9090 }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "wget -q -O /dev/null http://localhost:9090/-/ready",
        ],
        startPeriod: Duration.seconds(60),
      },
    });
    prometheus.addMountPoints({
      sourceVolume: "metrics",
      containerPath: "/prometheus",
      readOnly: false,
    });
    new ecs.FargateService(this, "MetricsService", {
      cluster,
      taskDefinition: metricsTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [monitoringSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      cloudMapOptions: { name: "prometheus" },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });
    const collectorTask = new ecs.FargateTaskDefinition(this, "CollectorTask", {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    collectorTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
        resources: ["*"],
      }),
    );
    collectorTask.addContainer("collector", {
      image: ecs.ContainerImage.fromRegistry(
        "otel/opentelemetry-collector-contrib:0.136.0",
      ),
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "collector",
        logGroup: telemetryLogs,
      }),
      environment: {
        AWS_REGION: this.region,
        COLLECTOR_CONFIG: readFileSync(
          resolve(__dirname, "../../../observability/otel-aws.yml"),
          "utf8",
        ).replace("${env:AWS_REGION}", this.region),
      },
      command: ["--config=env:COLLECTOR_CONFIG"],
      portMappings: [{ containerPort: 4318 }],
    });
    new ecs.FargateService(this, "CollectorService", {
      cluster,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskDefinition: collectorTask,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [monitoringSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      cloudMapOptions: { name: "otel" },
      circuitBreaker: { rollback: true },
    });
    for (const [name, version] of [
      ["stable", stableVersion],
      ["candidate", candidateVersion],
    ]) {
      const task = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        cpu: 256,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      props.foundation.artifacts.grantRead(
        task.taskRole,
        `versions/${version}/*`,
      );
      const group = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const container = task.addContainer(name, {
        image: ecs.ContainerImage.fromEcrRepository(
          props.foundation.modelRepo,
          tag,
        ),
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: name,
          logGroup: group,
        }),
        environment: {
          MODEL_VERSION: version,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.modelforge.local:4318",
          ARTIFACT_ROOT: "/tmp/artifacts",
          ARTIFACT_BUCKET: props.foundation.artifacts.bucketName,
        },
        healthCheck: {
          command: [
            "CMD-SHELL",
            "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready')\"",
          ],
          startPeriod: Duration.seconds(60),
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 3,
        },
        readonlyRootFilesystem: true,
      });
      task.addVolume({ name: "tmp" });
      container.addMountPoints({
        sourceVolume: "tmp",
        containerPath: "/tmp",
        readOnly: false,
      });
      container.addPortMappings({ containerPort: 8000 });
      new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: task,
        desiredCount: 1,
        securityGroups: [modelSg],
        assignPublicIp: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cloudMapOptions: { name },
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      });
      const errors = new logs.MetricFilter(this, `${name}Errors`, {
        logGroup: group,
        filterPattern: logs.FilterPattern.stringValue(
          "$.event",
          "=",
          "inference_failed",
        ),
        metricNamespace: "ModelForge",
        metricName: `${name}InferenceErrors`,
        metricValue: "1",
        defaultValue: 0,
      });
      errors
        .metric({ statistic: "Sum", period: Duration.minutes(1) })
        .createAlarm(this, `${name}ErrorAlarm`, {
          threshold: 5,
          evaluationPeriods: 2,
          treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        });
    }
    const task = new ecs.FargateTaskDefinition(this, "GatewayTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const gatewayLogs = new logs.LogGroup(this, "GatewayLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    task.addContainer("gateway", {
      image: ecs.ContainerImage.fromEcrRepository(
        props.foundation.gatewayRepo,
        tag,
      ),
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "gateway",
        logGroup: gatewayLogs,
      }),
      environment: {
        HOST: "0.0.0.0",
        PORT: "8080",
        STABLE_URL: "http://stable.modelforge.local:8000",
        CANDIDATE_URL: "http://candidate.modelforge.local:8000",
        MODEL_STABLE_VERSION: stableVersion,
        MODEL_CANDIDATE_VERSION: candidateVersion,
        CANARY_PERCENT: canary,
        PROMETHEUS_URL: "http://prometheus.modelforge.local:9090",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.modelforge.local:4318",
      },
      portMappings: [{ containerPort: 8080 }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        interval: Duration.seconds(30),
        startPeriod: Duration.seconds(30),
      },
    });
    const service = new ecs.FargateService(this, "GatewayService", {
      cluster,
      cloudMapOptions: { name: "gateway" },
      taskDefinition: task,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      securityGroups: [gatewaySg],
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
    });
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: publicAlb,
      vpcSubnets: {
        subnetType: publicAlb
          ? ec2.SubnetType.PUBLIC
          : ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
    const listener = alb.addListener("Listener", {
      port: cert ? 443 : 80,
      protocol: cert
        ? elbv2.ApplicationProtocol.HTTPS
        : elbv2.ApplicationProtocol.HTTP,
      certificates: cert
        ? [acm.Certificate.fromCertificateArn(this, "Certificate", cert)]
        : undefined,
      open: false,
    });
    alb.connections.allowFrom(
      ec2.Peer.ipv4(allowed || vpc.vpcCidrBlock),
      ec2.Port.tcp(cert ? 443 : 80),
    );
    gatewaySg.addIngressRule(
      alb.connections.securityGroups[0],
      ec2.Port.tcp(8080),
    );
    const targets = listener.addTargets("GatewayTargets", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: "/ready", healthyHttpCodes: "200" },
      deregistrationDelay: Duration.seconds(20),
    });
    service
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 })
      .scaleOnCpuUtilization("CpuScaling", {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });
    const errors = alb.metrics.httpCodeTarget(
      elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
      { period: Duration.minutes(1), statistic: "Sum" },
    );
    errors.createAlarm(this, "Gateway5xx", {
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    targets.metrics.healthyHostCount().createAlarm(this, "NoHealthyGateway", {
      threshold: 1,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
    });
    const dashboard = new cw.Dashboard(this, "Dashboard");
    dashboard.addWidgets(
      new cw.GraphWidget({ title: "Gateway HTTP 5xx", left: [errors] }),
      new cw.GraphWidget({
        title: "Gateway latency p95",
        left: [alb.metrics.targetResponseTime({ statistic: "p95" })],
      }),
      new cw.GraphWidget({
        title: "Gateway CPU",
        left: [service.metricCpuUtilization()],
      }),
    );
    new CfnOutput(this, "GatewayUrl", {
      value: `${cert ? "https" : "http"}://${alb.loadBalancerDnsName}`,
    });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
  }
}
