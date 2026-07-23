package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	signv4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	"github.com/aws/aws-sdk-go-v2/service/sesv2/types"
	"go.temporal.io/sdk/activity"
)

// opensearchService is the SigV4 service name for Amazon OpenSearch Service (managed domains).
const opensearchService = "es"

// StoreResultsInput is the StoreResults activity's input: the analyzed
// video's key and the labels found per fragment.
type StoreResultsInput struct {
	VideoKey string         `json:"videoKey"`
	Labels   FragmentLabels `json:"labels"`
}

// StoreResults indexes the analysis in OpenSearch and emails a summary to the
// video's uploader via SES.
func (a *Activities) StoreResults(ctx context.Context, input StoreResultsInput) error {
	logger := activity.GetLogger(ctx)

	if err := a.indexResults(ctx, input); err != nil {
		return fmt.Errorf("index results in opensearch: %w", err)
	}
	logger.Info("indexed results in opensearch", "videoKey", input.VideoKey)

	userID, err := userIDFromVideoKey(input.VideoKey)
	if err != nil {
		return fmt.Errorf("parse uploader from video key: %w", err)
	}
	recipient, err := a.lookupUserEmail(ctx, userID)
	if err != nil {
		return fmt.Errorf("look up uploader email: %w", err)
	}

	if err := a.sendSummaryEmail(ctx, input, recipient); err != nil {
		return fmt.Errorf("send summary email: %w", err)
	}
	logger.Info("sent summary email", "recipient", recipient)
	return nil
}

// userIDFromVideoKey extracts the uploader's userId from a video key of the
// form "videos/{userId}/{uuid}-{fileName}" (see api/src/controllers/video.controller.ts).
func userIDFromVideoKey(key string) (string, error) {
	parts := strings.SplitN(key, "/", 3)
	if len(parts) < 2 || parts[0] != "videos" {
		return "", fmt.Errorf("unexpected video key format: %s", key)
	}
	return parts[1], nil
}

func (a *Activities) lookupUserEmail(ctx context.Context, userID string) (string, error) {
	out, err := a.dynamodb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(a.UsersTable),
		Key: map[string]ddbtypes.AttributeValue{
			"userId": &ddbtypes.AttributeValueMemberS{Value: userID},
		},
	})
	if err != nil {
		return "", err
	}
	if out.Item == nil {
		return "", fmt.Errorf("user %s not found", userID)
	}

	email, ok := out.Item["email"].(*ddbtypes.AttributeValueMemberS)
	if !ok {
		return "", fmt.Errorf("user %s has no email attribute", userID)
	}
	return email.Value, nil
}

// indexResults PUTs the analysis straight to OpenSearch's REST API, signed
// with SigV4. Simpler than pulling in the opensearch-go client for a single write.
func (a *Activities) indexResults(ctx context.Context, input StoreResultsInput) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}

	docID := strings.ReplaceAll(input.VideoKey, "/", "_")
	url := fmt.Sprintf("%s/%s/_doc/%s", a.OpenSearchEndpoint, a.OpenSearchIndex, docID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	creds, err := a.awsConfig.Credentials.Retrieve(ctx)
	if err != nil {
		return fmt.Errorf("retrieve aws credentials: %w", err)
	}
	payloadHash := sha256Hex(body)
	if err := signv4.NewSigner().SignHTTP(ctx, creds, req, payloadHash, opensearchService, a.awsConfig.Region, time.Now()); err != nil {
		return fmt.Errorf("sign opensearch request: %w", err)
	}

	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("opensearch returned %d: %s", resp.StatusCode, respBody)
	}
	return nil
}

func (a *Activities) sendSummaryEmail(ctx context.Context, input StoreResultsInput, recipient string) error {
	_, err := a.ses.SendEmail(ctx, &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(a.SenderEmail),
		Destination:      &types.Destination{ToAddresses: []string{recipient}},
		Content: &types.EmailContent{
			Simple: &types.Message{
				Subject: &types.Content{Data: aws.String(fmt.Sprintf("Video analysis complete: %s", input.VideoKey))},
				Body:    &types.Body{Text: &types.Content{Data: aws.String(summaryText(input))}},
			},
		},
	})
	return err
}

func summaryText(input StoreResultsInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Analysis results for %s\n\n", input.VideoKey)
	for fragment, labels := range input.Labels {
		fmt.Fprintf(&b, "%s: %s\n", fragment, strings.Join(labels, ", "))
	}
	return b.String()
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
