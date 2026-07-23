package main

import (
	"net/http"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/rekognition"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
)

// Config holds the settings the activities need beyond what's already on the workflow input.
type Config struct {
	OpenSearchEndpoint string
	OpenSearchIndex    string
	SenderEmail        string // SES identity the completion email is sent from.
	UsersTable         string // DynamoDB table used to look up the uploader's email (see StoreResults).
}

// Activities bundles the AWS clients and settings shared by the video-processing activities.
type Activities struct {
	Config

	awsConfig   aws.Config
	s3          *s3.Client
	rekognition *rekognition.Client
	ses         *sesv2.Client
	dynamodb    *dynamodb.Client
	http        *http.Client
}

func NewActivities(awsCfg aws.Config, cfg Config) *Activities {
	return &Activities{
		Config:      cfg,
		awsConfig:   awsCfg,
		s3:          s3.NewFromConfig(awsCfg),
		rekognition: rekognition.NewFromConfig(awsCfg),
		ses:         sesv2.NewFromConfig(awsCfg),
		dynamodb:    dynamodb.NewFromConfig(awsCfg),
		http:        http.DefaultClient,
	}
}
