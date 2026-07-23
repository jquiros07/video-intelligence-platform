package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.temporal.io/sdk/activity"
)

const fragmentDurationSeconds = 30

// SplitVideo downloads the source video from S3, splits it into fixed-length
// fragments with ffmpeg, and uploads each fragment back to S3 under a
// "fragments/<video-key>/" prefix. It returns the resulting fragment keys.
//
// Fragments are written under "fragments/", outside the "videos/" prefix the
// S3 -> SQS -> Lambda trigger watches, so uploading them doesn't start new workflows.
func (a *Activities) SplitVideo(ctx context.Context, input VideoInput) ([]string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("splitting video", "bucket", input.Bucket, "key", input.Key)

	workDir, err := os.MkdirTemp("", "video-split-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(workDir)

	sourcePath := filepath.Join(workDir, filepath.Base(input.Key))
	if err := a.downloadFromS3(ctx, input.Bucket, input.Key, sourcePath); err != nil {
		return nil, fmt.Errorf("download source video: %w", err)
	}
	logger.Info("downloaded source video", "path", sourcePath)

	fragmentPattern := filepath.Join(workDir, "fragment-%03d.mp4")
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-i", sourcePath,
		"-c", "copy",
		"-map", "0",
		"-f", "segment",
		"-segment_time", fmt.Sprintf("%d", fragmentDurationSeconds),
		"-reset_timestamps", "1",
		fragmentPattern,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg split: %w: %s", err, output)
	}

	fragmentFiles, err := filepath.Glob(filepath.Join(workDir, "fragment-*.mp4"))
	if err != nil {
		return nil, fmt.Errorf("list fragments: %w", err)
	}
	logger.Info("ffmpeg produced fragments", "count", len(fragmentFiles))

	videoStem := strings.TrimSuffix(input.Key, filepath.Ext(input.Key))
	fragmentKeys := make([]string, 0, len(fragmentFiles))
	for _, file := range fragmentFiles {
		fragmentKey := fmt.Sprintf("fragments/%s/%s", videoStem, filepath.Base(file))
		if err := a.uploadToS3(ctx, input.Bucket, fragmentKey, file); err != nil {
			return nil, fmt.Errorf("upload fragment %s: %w", fragmentKey, err)
		}
		fragmentKeys = append(fragmentKeys, fragmentKey)
	}
	logger.Info("uploaded fragments", "count", len(fragmentKeys))

	return fragmentKeys, nil
}

func (a *Activities) downloadFromS3(ctx context.Context, bucket, key, destPath string) error {
	out, err := a.s3.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return err
	}
	defer out.Body.Close()

	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer dest.Close()

	_, err = io.Copy(dest, out.Body)
	return err
}

func (a *Activities) uploadToS3(ctx context.Context, bucket, key, filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	_, err = a.s3.PutObject(ctx, &s3.PutObjectInput{Bucket: &bucket, Key: &key, Body: file})
	return err
}
