#!/bin/bash

set -e

AMI_NAME=$1
NUM_RESULTS=${2:-3}

# Print header
printf "%-80s\t%-20s\n" "AMI Name" "AMI ID"
printf "%-80s\t%-20s\n" "$(printf '%.0s-' {1..80})" "$(printf '%.0s-' {1..20})"

# Fetch and print the AMI details
aws ec2 describe-images --region us-east-1 --owners amazon \
--filters "Name=name,Values=${AMI_NAME}" \
--query "reverse(sort_by(Images, &CreationDate))[:${NUM_RESULTS}].[Name, ImageId]" --output json | jq -r '.[] | "\(.[])"' | while read -r name; do
    read -r id
    printf "%-80s\t%-20s\n" "$name" "$id"
done
