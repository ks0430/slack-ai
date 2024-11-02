#!/bin/bash

# Function to get value from .env file
get_env_value() {
    local key=$1
    local value=$(grep "^$key=" .env | cut -d '=' -f2)
    # Remove leading/trailing whitespace and quotes
    echo "$value" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Check if .env file exists
if [ ! -f .env ]; then
    echo "Error: .env file not found!"
    exit 1
fi

# If no arguments provided, show usage
if [ "$#" -eq 0 ]; then
    echo "Usage: ./set-env.sh VARIABLE_NAME [VARIABLE_VALUE]"
    echo "If VARIABLE_VALUE is not provided, it will be read from .env file"
    echo "Example: ./set-env.sh SLACK_BOT_TOKEN"
    echo "Example: ./set-env.sh SLACK_BOT_TOKEN xoxb-your-token"
    exit 1
fi

# Get variable name from first argument
VAR_NAME=$1

if [ "$#" -eq 1 ]; then
    # If only variable name provided, get value from .env
    VAR_VALUE=$(get_env_value "$VAR_NAME")
    if [ -z "$VAR_VALUE" ]; then
        echo "Error: Variable $VAR_NAME not found in .env file!"
        exit 1
    fi
else
    # If value provided as second argument, use that
    VAR_VALUE=$2
fi

# Set the variable using railway CLI
echo "Setting $VAR_NAME=$VAR_VALUE"
railway variables --set "$VAR_NAME=$VAR_VALUE"

# Verify the variable was set
echo "Variable $VAR_NAME has been set. Verifying variables list:"
railway variables