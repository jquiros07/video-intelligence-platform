package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/config"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

// Keep in sync with TEMPORAL_TASK_QUEUE / VIDEO_WORKFLOW_TYPE in infra/lib/infra-stack.ts —
// ProcessVideoWorkflow is registered below under its Go function name, which already matches.
const taskQueue = "video-processing"

func main() {
	awsCfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("load aws config: %v", err)
	}

	activities := NewActivities(awsCfg, Config{
		OpenSearchEndpoint: mustGetenv("OPENSEARCH_ENDPOINT"),
		OpenSearchIndex:    getenvDefault("OPENSEARCH_INDEX", "video-analysis"),
		SenderEmail:        mustGetenv("SENDER_EMAIL"),
		UsersTable:         mustGetenv("DYNAMODB_USERS_TABLE"),
	})

	temporalClient, err := client.Dial(client.Options{
		HostPort:  getenvDefault("TEMPORAL_ADDRESS", "localhost:7233"),
		Namespace: getenvDefault("TEMPORAL_NAMESPACE", "default"),
	})
	if err != nil {
		log.Fatalf("connect to temporal: %v", err)
	}
	defer temporalClient.Close()

	w := worker.New(temporalClient, taskQueue, worker.Options{})
	w.RegisterWorkflow(ProcessVideoWorkflow)
	w.RegisterActivity(activities.SplitVideo)
	w.RegisterActivity(activities.AnalyzeFragments)
	w.RegisterActivity(activities.StoreResults)

	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalf("worker stopped: %v", err)
	}
}

func mustGetenv(key string) string {
	value := os.Getenv(key)
	if value == "" {
		log.Fatalf("required environment variable %s is not set", key)
	}
	return value
}

func getenvDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
