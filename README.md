# Video Processing Pipeline

A demo/POC pipeline: users upload a video, it's split into fragments, each fragment is analyzed
with Amazon Rekognition, and the results are indexed for search and emailed to the uploader —
all orchestrated by a durable [Temporal](https://temporal.io/) workflow rather than a hand-rolled
queue/retry system.

It exists to show an event-driven pipeline pattern end to end: API → object storage → async
messaging → serverless trigger → durable workflow orchestration → background workers touching
several AWS services (Rekognition, OpenSearch, SES) — all defined as one AWS CDK stack.

## User flow

1. **Register** — `POST /auth/register` creates the user in DynamoDB and triggers an SES
   verification email to their address (see [SES sandbox mode](#ses-sandbox-mode) below).
2. **Log in** — `POST /auth/login` returns a JWT.
3. **Request an upload URL** — `POST /videos` (authenticated) returns a presigned S3 `PUT` URL;
   the client uploads the video bytes directly to S3 under `videos/<userId>/<uuid>-<fileName>`.
4. **Upload triggers the pipeline** — the S3 `ObjectCreated` event lands on an SQS queue, which
   triggers a Lambda that starts a `ProcessVideoWorkflow` Temporal workflow with `{ bucket, key }`.
5. **A Go worker runs three activities** for that workflow:
   - `SplitVideo` — downloads the source video, splits it into fragments with `ffmpeg`, uploads
     the fragments back to S3 under `fragments/`.
   - `AnalyzeFragments` — runs Rekognition label detection on each fragment.
   - `StoreResults` — indexes the labels per fragment into OpenSearch, looks up the uploader's
     email from DynamoDB (parsed from the video key), and emails them a summary via SES.
6. **Uploader gets notified** — once the workflow completes, the uploader receives a summary
   email and the full results are searchable in OpenSearch.

Workflow progress at any point can be inspected in the Temporal Web UI (see
[Deploying](#deploying)).

## Structure

- [`api/`](api/) — Express/TypeScript API: auth (JWT via `jose`, Argon2 password hashing,
  DynamoDB-backed users, SES email verification on register) and video upload (S3 presigned
  URLs). Runs on ECS Fargate behind a public ALB. Request logging via `morgan`; all container
  stdout ships to CloudWatch Logs.
- [`infra/`](infra/) — AWS CDK (TypeScript) stack defining everything: VPC, S3 bucket + SQS +
  the Lambda that starts Temporal workflows on upload, the self-hosted Temporal server (EC2,
  with Postgres as a container on the same instance), the DynamoDB users table, the API's ECS
  Fargate service + ALB, the worker's ECS Fargate service, an OpenSearch domain, and an SES
  email identity. IAM roles are scoped to the specific actions/resources each service actually
  uses rather than broad read/write grants.
- [`temporal/`](temporal/) — Local Temporal server via docker-compose, for development.
- [`workers/`](workers/) — Go Temporal worker: the `ProcessVideoWorkflow` workflow and its three
  activities (`SplitVideo`, `AnalyzeFragments`, `StoreResults`), described above. Runs on ECS
  Fargate; ships as a Docker image (`ffmpeg` + the compiled binary).

## API

Base path: `/api/v1`. JSON bodies only (max 100kb), rate-limited to 100 requests / 15 min per client.
A `GET /health` endpoint also exists outside the base path for load balancer health checks.

### `POST /auth/register`

Creates a user and sends them an SES verification email. No auth required.

```json
{
  "name": "Jose",
  "lastname": "Quiros",
  "email": "jose@example.com",
  "password": "at-least-8-chars"
}
```

- `201` — `{ "message": "User created successfully! Please verify your email address" }`.
- `409` — a user with that email already exists.

### `POST /auth/login`

Verifies credentials and returns a JWT. No auth required.

```json
{ "email": "jose@example.com", "password": "at-least-8-chars" }
```

- `200` — `{ "token": "<jwt>" }`, expires in 24h.
- `401` — invalid email or password.

### `POST /videos`

Requests a presigned S3 URL to upload a video directly to the videos bucket. Requires
`Authorization: Bearer <jwt>`.

```json
{
  "fileName": "clip.mp4",
  "contentType": "video/mp4",
  "fileSize": 10485760
}
```

`contentType` must be one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo`;
`fileSize` is capped by the `VIDEO_UPLOAD_LIMIT` env var (50MB by default).

- `200` — `{ "uploadUrl": "<presigned PUT url>", "key": "videos/<userId>/<uuid>-<fileName>" }`.
  The URL expires in 5 minutes; the client `PUT`s the file bytes to it directly.
- `401` — missing/invalid/expired token.

## Deploying

Prerequisites:

- An AWS profile/credentials configured locally.
- Docker running — `cdk deploy` builds two container images (`api/`, `workers/`) as part of
  publishing assets.
- This AWS account/region has been through `npx cdk bootstrap` at least once.

```bash
cd infra
npm install
npx cdk deploy \
  --parameters SesSenderEmail=you@example.com \
  --parameters TemporalUiAllowedCidr=<your-ip>/32
```

- `SesSenderEmail` (required) — the address the worker sends completion emails from. CDK
  creates an SES identity for it; check that inbox for AWS's verification email after deploying.
- `TemporalUiAllowedCidr` (optional) — CIDR allowed to reach the Temporal UI on port 8080. Leave
  it unset and the port stays closed.

Useful outputs after deploy: `ApiUrl`, `TemporalUiUrl`, `VideosBucketName`, `SearchDomainEndpoint`.

Everything in the stack has `removalPolicy: DESTROY`, so `npx cdk destroy` tears it all down —
worth doing between test sessions, since the always-on pieces (EC2, ALB, NAT gateway, two
Fargate services, OpenSearch) run into real cost if left up.

### SES sandbox mode

New AWS accounts start with SES in sandbox mode: both the sender identity (`SesSenderEmail`)
and every recipient need to be verified via the "click the link we emailed you" flow before mail
actually sends. Registering a user (`POST /auth/register`) triggers that verification email for
the recipient automatically; the sender identity gets verified the same way right after deploy.

## Testing end to end

```bash
API_URL=<ApiUrl output>

# 1. Register, then click the verification link AWS emails to this address.
curl -X POST "$API_URL/api/v1/auth/register" -H 'Content-Type: application/json' -d '{
  "name": "Jose", "lastname": "Quiros", "email": "you@example.com", "password": "at-least-8-chars"
}'

# 2. Log in.
TOKEN=$(curl -X POST "$API_URL/api/v1/auth/login" -H 'Content-Type: application/json' -d '{
  "email": "you@example.com", "password": "at-least-8-chars"
}' | jq -r .token)

# 3. Request a presigned upload URL, then PUT the video bytes to it.
curl -X POST "$API_URL/api/v1/videos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "fileName": "clip.mp4", "contentType": "video/mp4", "fileSize": 10485760
}'
# -> { "uploadUrl": "...", "key": "videos/<userId>/<uuid>-clip.mp4" }
curl -X PUT "<uploadUrl>" -H 'Content-Type: video/mp4' --data-binary @clip.mp4
```

From there:

- **Temporal UI** (`TemporalUiUrl` output, if `TemporalUiAllowedCidr` was set) — the workflow
  ID is `video-<key>`; watch `SplitVideo` → `AnalyzeFragments` → `StoreResults` execute.
- **CloudWatch Logs** — `WorkerLogGroup` has per-activity progress logs; `ApiLogGroup` has
  request logs; `StartVideoWorkflowFnLogGroup` has the Lambda's workflow-start logs.
- **Email** — the uploader receives a summary email once `StoreResults` finishes.
- **OpenSearch** (`SearchDomainEndpoint` output, index `video-analysis`) — the same results,
  indexed per video key. Querying it directly requires a SigV4-signed request (IAM auth, no
  public access policy) — see `workers/activity_store.go` for the exact request shape.
