import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, it, expect } from "vitest";
import { Foundation, Platform } from "../lib/stacks";

describe("AWS deployment safety", () => {
  it("creates private model services, immutable repositories and read-only task roots", () => {
    const app = new App();
    const foundation = new Foundation(app, "Foundation");
    const platform = new Platform(app, "Platform", { foundation });
    const f = Template.fromStack(foundation);
    const p = Template.fromStack(platform);
    f.resourceCountIs("AWS::ECR::Repository", 2);
    f.hasResourceProperties("AWS::ECR::Repository", {
      ImageTagMutability: "IMMUTABLE",
    });
    f.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    p.resourceCountIs("AWS::ECS::Service", 5);
    p.hasResourceProperties("AWS::ECS::Service", {
      NetworkConfiguration: {
        AwsvpcConfiguration: { AssignPublicIp: "DISABLED" },
      },
    });
    p.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ ReadonlyRootFilesystem: true }),
      ]),
    });
    p.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
    });
    const definitions = p.findResources("AWS::ECS::TaskDefinition");
    for (const definition of Object.values(definitions))
      for (const container of definition.Properties.ContainerDefinitions)
        expect(container.ReadonlyRootFilesystem).toBe(true);
  });
  it("wires private metrics and X-Ray without notification destinations", () => {
    const app = new App();
    const foundation = new Foundation(app, "Foundation");
    const platform = new Platform(app, "Platform", { foundation });
    const template = Template.fromStack(platform);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "gateway",
          Environment: Match.arrayWith([
            {
              Name: "PROMETHEUS_URL",
              Value: "http://prometheus.modelforge.local:9090",
            },
            {
              Name: "OTEL_EXPORTER_OTLP_ENDPOINT",
              Value: "http://otel.modelforge.local:4318",
            },
          ]),
        }),
      ]),
    });
    template.hasResourceProperties("AWS::ServiceDiscovery::Service", {
      Name: "gateway",
    });
    template.hasResourceProperties("AWS::ServiceDiscovery::Service", {
      Name: "prometheus",
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
            Resource: "*",
          }),
        ]),
      },
    });
    template.resourceCountIs("AWS::SNS::Topic", 0);
    for (const alarm of Object.values(
      template.findResources("AWS::CloudWatch::Alarm"),
    ))
      expect(alarm.Properties.AlarmActions).toBeUndefined();
  });
  it("rejects publicly accessible ALB without TLS and ingress restrictions", () => {
    const app = new App({ context: { publicAlb: "true" } });
    const foundation = new Foundation(app, "Foundation");
    expect(() => new Platform(app, "Platform", { foundation })).toThrow(
      "Public ALB requires",
    );
  });
  it("scopes OIDC to the repository and deployment environments", () => {
    const app = new App({ context: { githubRepo: "sumeetweb/modelforge" } });
    const f = new Foundation(app, "Foundation");
    Template.fromStack(f).hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": [
                  "repo:sumeetweb/modelforge:environment:staging",
                  "repo:sumeetweb/modelforge:environment:production",
                ],
              },
            },
          }),
        ]),
      },
    });
  });
});
