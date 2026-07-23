package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

// VideoInput mirrors the {bucket, key} payload the start-video-workflow Lambda
// starts the workflow with (see infra/lambda/start-video-workflow).
type VideoInput struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
}

// ProcessVideoWorkflow splits a video into fragments, analyzes each fragment
// with Rekognition, then stores the results and emails a summary.
func ProcessVideoWorkflow(ctx workflow.Context, input VideoInput) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 20 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
	})

	// Method value on a nil receiver: only used by the SDK to resolve the
	// registered activity name, never actually called on this instance.
	var a *Activities

	var fragmentKeys []string
	if err := workflow.ExecuteActivity(ctx, a.SplitVideo, input).Get(ctx, &fragmentKeys); err != nil {
		return err
	}

	var labels FragmentLabels
	analyzeInput := AnalyzeInput{Bucket: input.Bucket, FragmentKeys: fragmentKeys}
	if err := workflow.ExecuteActivity(ctx, a.AnalyzeFragments, analyzeInput).Get(ctx, &labels); err != nil {
		return err
	}

	storeInput := StoreResultsInput{VideoKey: input.Key, Labels: labels}
	return workflow.ExecuteActivity(ctx, a.StoreResults, storeInput).Get(ctx, nil)
}
