#!/bin/bash
# LocalStack AWS open-source auto-initialization script
# Runs inside LocalStack container on startup

echo "Configuring Airpath Open Source AWS resources on LocalStack..."

# 1. Create S3 Bucket for Route GeoJSON Archives
awslocal s3 mb s3://airpath-commute-routes

# 2. Create DynamoDB Table for BreathBudget daily exposure logs
awslocal dynamodb create-table \
    --table-name BreathBudgetExposures \
    --attribute-definitions \
        AttributeName=PK,AttributeType=S \
        AttributeName=SK,AttributeType=S \
    --key-schema \
        AttributeName=PK,KeyType=HASH \
        AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST

# 3. Create EventBridge rule for high AQI warnings
awslocal events put-rule \
    --name HighExposureAlertRule \
    --event-pattern "{\"source\":[\"airpath.commute.router\"],\"detail-type\":[\"AirQualityThresholdBreach\"]}"

echo "Airpath Open Source AWS resources ready on LocalStack (100% Free, on your machine)."
