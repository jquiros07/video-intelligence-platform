import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface TemporalUserDataProps {
  temporalVersion: string;
  temporalUiVersion: string;
  postgresVersion: string;
  temporalUiOrigin: string;
}

// EC2 bootstrap script for the self-hosted Temporal instance: installs Docker,
// then runs Postgres, the Temporal server, and the Temporal UI as containers
// on a shared docker network.
export function buildTemporalUserData(props: TemporalUserDataProps): ec2.UserData {
  const { temporalVersion, temporalUiVersion, postgresVersion, temporalUiOrigin } = props;

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
      `postgres:${postgresVersion}`,
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
      `temporalio/auto-setup:${temporalVersion}`,
    ].join(' '),
    [
      'docker run -d --name temporal-ui --restart unless-stopped --network temporal-network',
      '-e TEMPORAL_ADDRESS=temporal:7233',
      `-e TEMPORAL_CORS_ORIGINS=${temporalUiOrigin}`,
      '-p 8080:8080',
      `temporalio/ui:${temporalUiVersion}`,
    ].join(' '),
  );

  return userData;
}
