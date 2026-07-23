package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/rekognition"
	"github.com/aws/aws-sdk-go-v2/service/rekognition/types"
	"go.temporal.io/sdk/activity"
)

// AnalyzeInput is the AnalyzeFragments activity's input: the bucket the
// fragments were uploaded to, plus their keys.
type AnalyzeInput struct {
	Bucket       string   `json:"bucket"`
	FragmentKeys []string `json:"fragmentKeys"`
}

// FragmentLabels maps a fragment's S3 key to the distinct labels Rekognition detected in it.
type FragmentLabels map[string][]string

const labelDetectionPollInterval = 10 * time.Second

// AnalyzeFragments runs Amazon Rekognition label detection on each video
// fragment and returns the distinct labels found per fragment.
func (a *Activities) AnalyzeFragments(ctx context.Context, input AnalyzeInput) (FragmentLabels, error) {
	results := make(FragmentLabels, len(input.FragmentKeys))

	for _, key := range input.FragmentKeys {
		labels, err := a.detectLabels(ctx, input.Bucket, key)
		if err != nil {
			return nil, fmt.Errorf("analyze fragment %s: %w", key, err)
		}
		results[key] = labels
	}

	return results, nil
}

// detectLabels starts a Rekognition label-detection job and polls it to
// completion. Video is async-only in Rekognition; polling (with heartbeats so
// Temporal knows the activity is still alive) is simpler here than wiring up
// the SNS-topic completion-notification flow AWS recommends for production.
func (a *Activities) detectLabels(ctx context.Context, bucket, key string) ([]string, error) {
	start, err := a.rekognition.StartLabelDetection(ctx, &rekognition.StartLabelDetectionInput{
		Video: &types.Video{
			S3Object: &types.S3Object{Bucket: aws.String(bucket), Name: aws.String(key)},
		},
	})
	if err != nil {
		return nil, err
	}

	for {
		activity.RecordHeartbeat(ctx, key)

		result, err := a.rekognition.GetLabelDetection(ctx, &rekognition.GetLabelDetectionInput{
			JobId: start.JobId,
		})
		if err != nil {
			return nil, err
		}

		switch result.JobStatus {
		case types.VideoJobStatusSucceeded:
			return uniqueLabelNames(result.Labels), nil
		case types.VideoJobStatusFailed:
			return nil, fmt.Errorf("rekognition job failed: %s", aws.ToString(result.StatusMessage))
		default:
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(labelDetectionPollInterval):
			}
		}
	}
}

func uniqueLabelNames(labels []types.LabelDetection) []string {
	seen := make(map[string]struct{})
	names := make([]string, 0, len(labels))
	for _, l := range labels {
		if l.Label == nil || l.Label.Name == nil {
			continue
		}
		name := *l.Label.Name
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}
