# Local delivery and the final AWS milestone

Local operation and tests need no AWS account. `make synth` validates CloudFormation generation but does not prove an AWS deployment will succeed. Docker image builds, ECS behavior, OIDC federation, external smoke tests, and the hosted dashboards must be verified in their target environments before claiming cloud deployment.

## Prerequisites

Use an AWS sandbox account, AWS CLI v2 authenticated through an appropriate local profile, Docker with Buildx, Node 22/24, uv, and the project's dependencies. Choose a region. Set a budget alert. Review the CDK diff and bootstrap policy in that account. The CDK bootstrap deployment role has broader provisioning permissions than the runtime task roles; tighten its CloudFormation execution policies for a real organization.

The supplied stack names are fixed. **Use separate AWS accounts or regions for staging and production.** GitHub environment names only select credentials and approvals; they do not create infrastructure isolation. Publish images and artifacts into each environment's account before deploying there. Do not deploy both environments into the same account/region with these stack names.

## First: enable CI without AWS

Push the reviewed commits to `main` (or open a pull request). In **Settings → Actions → General**, enable GitHub Actions and permit the action providers used by the workflows: `actions`, `astral-sh`, `aws-actions`, and `docker`. Default workflow permissions can remain read-only; deployment workflows explicitly request `id-token: write` for OIDC. No AWS variables or secrets are needed for `ci.yml`.

Open **Actions → Validate, build and prepare deployment** and inspect the run. It installs dependencies, lints, runs tests, validates artifacts, scans dependencies, synthesizes CDK, starts Compose and runs smoke/Prometheus checks. Inspect the uploaded `compose-logs` artifact if stack startup fails. After a successful run, configure a branch ruleset requiring the `checks` status and reviews appropriate to your repository. Manually dispatched publication/deployment workflows become available after their files are on the default branch.

## 1. Bootstrap and create registry foundation

From repository root:

```bash
make setup
make test
make synth
export AWS_PROFILE=your-sandbox-profile
export AWS_REGION=ap-south-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
cd infra/cdk
npx cdk bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION"
npx cdk deploy ModelForgeFoundation -c githubRepo=sumeetweb/modelforge --outputs-file foundation.json
cd ../..
```

If the account already has a GitHub OIDC provider, pass `-c oidcProviderArn=THE_EXISTING_ARN` consistently on foundation and platform commands. The foundation outputs the model/gateway ECR URIs, S3 artifact bucket, and optional release-role ARN. Copy these into shell variables for the commands below. No secrets belong in the repository.

## 2. Publish application images independently

```bash
export MODEL_REPOSITORY='COPY_MODEL_REPOSITORY_OUTPUT'
export GATEWAY_REPOSITORY='COPY_GATEWAY_REPOSITORY_OUTPUT'
export ARTIFACT_BUCKET='COPY_ARTIFACT_BUCKET_OUTPUT'
export IMAGE_TAG=$(git rev-parse HEAD)
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${MODEL_REPOSITORY%%/*}"
docker buildx build --platform linux/amd64 -f services/model-server/Dockerfile \
  -t "$MODEL_REPOSITORY:$IMAGE_TAG" --push .
docker buildx build --platform linux/amd64 -f services/model-gateway/Dockerfile \
  -t "$GATEWAY_REPOSITORY:$IMAGE_TAG" --push .
```

Commit reviewed changes first so the image tag identifies the code you build. ECR tags are immutable: do not reuse a SHA after changing uncommitted code. The tasks specify X86_64, so an Apple Silicon machine must build `linux/amd64`. Neither image includes generated model artifacts. ECR scans pushed images; review the findings before deployment. Dependency audits in CI complement, rather than replace, image scanning.

## 3. Publish trusted model artifacts independently

```bash
make artifacts
for version in v1 v2; do
  scripts/validate-artifact "$version"
  aws s3api put-object --bucket "$ARTIFACT_BUCKET" --key "versions/$version/model.joblib" \
    --body "model-artifacts/versions/$version/model.joblib" --if-none-match '*'
  aws s3api put-object --bucket "$ARTIFACT_BUCKET" --key "versions/$version/manifest.json" \
    --body "model-artifacts/versions/$version/manifest.json" --if-none-match '*'
done
```

The artifact bytes are uploaded before the manifest. Conditional writes fail if a key already exists. Registration, evaluation, and publication are distinct from changing serving traffic. The ECS task downloads only its configured version and verifies it before starting Uvicorn. The registry's trusted writers are a security boundary; S3 versioning and SHA-256 alone are not signed provenance.

## 4. Deploy the platform

Default: internal ALB, two gateway tasks, one task for each model, private subnets and one NAT gateway.

```bash
cd infra/cdk
npx cdk diff ModelForgePlatform -c githubRepo=sumeetweb/modelforge \
  -c "imageTag=$IMAGE_TAG" -c stableVersion=v1 -c candidateVersion=v2 -c canaryPercent=20
npx cdk deploy ModelForgePlatform -c githubRepo=sumeetweb/modelforge \
  -c "imageTag=$IMAGE_TAG" -c stableVersion=v1 -c candidateVersion=v2 -c canaryPercent=20 \
  --outputs-file platform.json
cd ../..
```

Run smoke from a host or runner with VPC access:

```bash
make smoke URL=http://INTERNAL_ALB_DNS
```

For an explicitly internet-facing demo, add all three context settings on diff/deploy: `-c publicAlb=true -c certificateArn=ACM_CERTIFICATE_ARN -c allowedCidr=YOUR_PUBLIC_IP/32`. Use a real ACM certificate in the same region and a DNS name you control pointing to the ALB. `SMOKE_URL` must use that name, not the ALB-generated hostname, for certificate validation. Inbound access stays restricted to the selected CIDR; configure an identity/authentication layer before admitting other users. Model services have no public IP or direct public ingress.

## 5. GitHub Actions deployment

In **Settings → Environments**, create `staging` and `production`. Restrict deployment branches to `main` and enable required reviewers where your GitHub plan supports them. Add these **environment variables**:

| Variable | Meaning |
|---|---|
| `AWS_REGION`, `AWS_RELEASE_ROLE_ARN` | Target account/region and OIDC role from that account's foundation |
| `MODEL_REPOSITORY`, `GATEWAY_REPOSITORY`, `ARTIFACT_BUCKET` | Foundation outputs in that environment |
| `SMOKE_URL` | Accessible gateway origin; custom DNS for TLS |
| `PUBLIC_ALB`, `CERTIFICATE_ARN`, `ALLOWED_CIDR` | Optional explicit public/TLS deployment settings |
| `OIDC_PROVIDER_ARN` | Existing provider ARN if reusing one; otherwise leave empty consistently |

Set `DEPLOY_RUNNER` as a **repository-level Actions variable**, not an environment-level variable: runner selection occurs before environment variables are available. Use a dedicated runner label whose host can reach the internal ALB. The default `ubuntu-latest` GitHub-hosted runner cannot reach an internal ALB. Keep deployment workflows restricted to trusted branches. [GitHub variable availability](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).

There are no long-lived AWS access-key secrets. Trust conditions restrict the GitHub subject to this repository's staging/production environments and the `sts.amazonaws.com` audience. Publish application images, publish model artifacts, then run **Deploy or roll back release configuration** with an existing image SHA, explicit stable/candidate versions, and weight. Do not grant untrusted PR workflows deployment credentials.

In the Actions tab, run **Publish application images** for the chosen environment and record the run commit SHA. Run **Validate and publish model artifact** twice to register unique versions `v1` (regularization `1`) and `v2` (regularization `2`). Skip versions already published: their keys are intentionally immutable. Then run **Deploy or roll back release configuration** with that image SHA, stable `v1`, candidate `v2`, and canary percentage `20`. Configure and check the intended `SMOKE_URL` first.

The workflow validates downloaded model artifacts, applies CDK and runs a smoke gate. The gate fails the workflow on errors; it does not revert an already completed model rollout. Production promotion means redeploying the accepted versions with a higher percentage, after reviewing observed behavior. Record all four release inputs and the preceding release before applying changes. To roll back, rerun with the preceding image SHA, versions, and percentage. ECS's configured deployment circuit breaker can roll back unhealthy task deployments; it does not judge model accuracy or automate statistical canary promotion.

CloudWatch includes application JSON logs, gateway CPU/latency/5xx dashboards, model inference error alarms and healthy-host alarms. Configure alarm notification actions yourself. Prometheus/Tempo/Grafana are supplied for Compose only; there is no claim that the local trace backend is deployed to AWS.

## Cost drivers and cleanup

No fixed monthly estimate is supplied because region, runtime, traffic and current AWS pricing matter. Persistent costs include four Fargate tasks at baseline (two gateway, two model), an ALB and capacity units, one NAT gateway plus data processing, public IPv4 where applicable, Cloud Map, log ingestion/storage, ECR image storage/scans, and versioned S3 storage. Gateway autoscaling can raise its task count from two to four. NAT and ALB can dominate a small idle demo. The model tasks use 0.25 vCPU/1 GiB each; gateway tasks use 0.25 vCPU/0.5 GiB each. Use AWS's pricing calculator for the selected region and destroy idle demos.

```bash
cd infra/cdk
npx cdk destroy ModelForgePlatform -c githubRepo=sumeetweb/modelforge
# Once platform is removed and you have reviewed retained assets:
npx cdk destroy ModelForgeFoundation -c githubRepo=sumeetweb/modelforge
```

ECR repositories and the S3 bucket use RETAIN, so destroying the foundation does **not** delete images, object versions, or their charges. Delete retained assets manually only after checking backups and intended retention. Review CloudWatch log groups, dashboard and network resources after destruction. Bootstrap resources also remain until separately removed. Never use a blanket account-wide deletion command.

Reference: [AWS CDK Fargate service configuration](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.FargateService.html), [GitHub OIDC with AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
