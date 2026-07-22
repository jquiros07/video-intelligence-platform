import { SQSHandler, SQSBatchResponse } from 'aws-lambda';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

interface S3EventNotification {
    Records: {
        s3: {
            bucket: { name: string };
            object: { key: string };
        };
    }[];
}

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE as string;
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE as string;
const VIDEO_WORKFLOW_TYPE = process.env.VIDEO_WORKFLOW_TYPE as string;

let clientPromise: Promise<Client> | undefined;

// Reused across warm invocations of the same execution environment.
const getClient = (): Promise<Client> => {
    if (!clientPromise) {
        clientPromise = Connection.connect({ address: TEMPORAL_ADDRESS }).then(
            (connection) => new Client({ connection, namespace: TEMPORAL_NAMESPACE }),
        );
    }
    return clientPromise;
};

export const handler: SQSHandler = async (event) => {
    const client = await getClient();
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

    for (const record of event.Records) {
        try {
            const s3Event = JSON.parse(record.body) as S3EventNotification;

            for (const s3Record of s3Event.Records) {
                const bucket = s3Record.s3.bucket.name;
                const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

                try {
                    await client.workflow.start(VIDEO_WORKFLOW_TYPE, {
                        taskQueue: TEMPORAL_TASK_QUEUE,
                        workflowId: `video-${key}`,
                        args: [{ bucket, key }],
                    });
                } catch (error) {
                    // Same S3 key already has a workflow running/completed — SQS redelivered
                    // the notification. Not a failure, so don't retry the message over it.
                    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
                        throw error;
                    }
                }
            }
        } catch (error) {
            console.error('Failed to start workflow for message', record.messageId, error);
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures };
};
