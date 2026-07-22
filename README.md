# Video Processing Pipeline

Uploads videos, splits them into frames, and analyzes each frame with Amazon Rekognition, orchestrated by Temporal.

A user registers/logs in, requests a presigned URL and uploads a video straight to S3. That upload
lands an S3 event on an SQS queue, which triggers a Lambda that starts a Temporal workflow. Go workers
pick up the workflow to split the video into frames (ffmpeg) and run Rekognition analysis on each frame.

## Structure

- [`api/`](api/) — Express/TypeScript API: auth (JWT via `jose`, Argon2 password hashing, DynamoDB-backed users) and video upload (S3 presigned URLs).
- [`infra/`](infra/) — AWS CDK (TypeScript) stack: S3 bucket, SQS, the Lambda that starts Temporal workflows on upload, and the self-hosted Temporal server (EC2, with Postgres as a container on the same instance). IAM roles are scoped to the specific actions/resources each service actually uses (e.g. the API's task role only gets `dynamodb:PutItem`/`Query` on the users table and `s3:PutObject` on the videos bucket) rather than broad read/write grants.
- [`temporal/`](temporal/) — Local Temporal server via docker-compose, for development.
- [`workers/`](workers/) — Go Temporal workers: frame-splitting (ffmpeg) and per-frame Rekognition analysis.

## API

Base path: `/api/v1`. JSON bodies only (max 100kb), rate-limited to 100 requests / 15 min per client.
A `GET /health` endpoint also exists outside the base path for load balancer health checks.

### `POST /auth/register`

Creates a user. No auth required.

```json
{
  "name": "Jose",
  "lastname": "Quiros",
  "email": "jose@example.com",
  "password": "at-least-8-chars"
}
```

- `201` — user created.
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
