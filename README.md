# Video Processing Pipeline

Uploads videos, splits them into frames, and analyzes each frame with Amazon Rekognition, orchestrated by Temporal.

## Structure

- [`api/`](api/) — Express/TypeScript API: auth (JWT via `jose`, Argon2 password hashing, DynamoDB-backed users) and video upload (S3 presigned URLs).
- [`infra/`](infra/) — AWS CDK (TypeScript) stack: S3 bucket, SQS, the Lambda that starts Temporal workflows on upload, and the self-hosted Temporal server (EC2 + RDS Postgres).
- [`temporal/`](temporal/) — Local Temporal server via docker-compose, for development.
- [`workers/`](workers/) — Go Temporal workers: frame-splitting (ffmpeg) and per-frame Rekognition analysis.
